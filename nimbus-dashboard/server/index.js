const path = require('path');
const http = require('http');
const net = require('net');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config');
const { createStore } = require('./store');
const { RoomHub, isValidRoomId } = require('./hub');
const { startMqtt } = require('./mqtt');
const { SimEngine } = require('./sim-engine');
const { Weather } = require('./weather');
const { RoomController } = require('./controller');

const ROOT = path.join(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');

async function startEmbeddedBroker(port) {
  try {
    const { Aedes } = await import('aedes');
    const broker = await Aedes.createBroker();
    await new Promise((resolve, reject) => {
      const server = net.createServer(broker.handle);
      server.once('error', reject);
      server.listen(port, '0.0.0.0', resolve);
    });
    console.log(`[broker] built-in MQTT broker listening on port ${port}`);
    return true;
  } catch (err) {
    console.error(`[broker] could not start the built-in MQTT broker: ${err.message}`);
    return false;
  }
}

async function main() {
  const store = await createStore(config);
  const hub = new RoomHub({ store, site: config.site, readingIntervalMs: config.readingIntervalMs });
  await hub.init(config.simulate);

  let brokerRunning = false;
  if (config.embeddedBroker) brokerRunning = await startEmbeddedBroker(config.embeddedBrokerPort);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  const weather = new Weather({ lat: config.weatherLat, lon: config.weatherLon, forced: config.forceRain });

  const mqtt = startMqtt({
    url: config.mqttUrl,
    prefix: config.mqttPrefix,
    hub,
    onStatus: () => io.emit('status', statusPayload()),
    isControlled: (roomId) => config.control.includes(roomId),
  });

  const controller = new RoomController({
    hub,
    site: config.site,
    roomIds: config.control.filter((id) => hub.get(id)),
    weather,
    publish: mqtt.publish,
  });

  function statusPayload() {
    return {
      store: store.name,
      timeseries: Boolean(store.timeseries),
      mqtt: mqtt.status(),
      mqttUrl: config.mqttUrl || null,
      embeddedBroker: brokerRunning,
      simulated: config.simulate,
      controlled: controller.roomIds,
      forcedRain: weather.forced,
    };
  }

  // Live updates to every open dashboard
  hub.on('room', (room) => io.emit('room', room));
  hub.on('reading', (reading) => io.emit('reading', { ...reading, ts: +reading.ts }));
  hub.on('decision', (d) => io.emit('decision', { ...d, ts: +d.ts }));
  io.on('connection', (socket) => socket.emit('status', statusPayload()));

  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  // Charts and fonts are served locally so the dashboard works on flaky venue Wi-Fi.
  app.get('/vendor/chart.umd.min.js', (req, res) => res.sendFile(path.join(NODE_MODULES, 'chart.js/dist/chart.umd.min.js')));
  app.use('/vendor/fonts/bricolage', express.static(path.join(NODE_MODULES, '@fontsource-variable/bricolage-grotesque')));
  app.use('/vendor/fonts/atkinson', express.static(path.join(NODE_MODULES, '@fontsource/atkinson-hyperlegible')));

  const api = express.Router();

  api.get('/config', (req, res) => {
    const { siteName, buildingName, airQuality, staleAfterSeconds, temperatureUnit } = config.site;
    res.json({
      siteName,
      buildingName,
      airQuality,
      staleAfterSeconds,
      temperatureUnit: temperatureUnit === 'F' ? 'F' : 'C',
      readingIntervalSeconds: config.readingIntervalMs / 1000,
    });
  });

  api.get('/status', (req, res) => res.json(statusPayload()));

  api.get('/rooms', (req, res) => res.json(hub.list()));

  // Demo setting: pretend rain is coming so the window stays closed.
  const onWeatherChange = () => {
    controller.decideAll();
    io.emit('status', statusPayload());
  };
  api.post('/weather/rain', (req, res) => {
    const chance = req.body?.chance === undefined ? 80 : Number(req.body.chance);
    if (!Number.isFinite(chance) || chance < 0 || chance > 100) return res.status(400).json({ error: 'Rain chance must be between 0 and 100.' });
    weather.setForced(chance);
    console.log(`[weather] demo setting: rain chance forced to ${weather.forced}%`);
    onWeatherChange();
    res.json(statusPayload());
  });
  api.delete('/weather/rain', (req, res) => {
    weather.setForced(null);
    console.log('[weather] demo setting cleared, using the forecast again');
    onWeatherChange();
    res.json(statusPayload());
  });

  api.param('id', (req, res, next, id) => {
    if (!isValidRoomId(id) || !hub.get(id)) return res.status(404).json({ error: `No room called "${id}".` });
    next();
  });

  api.get('/rooms/:id', (req, res) => res.json(hub.get(req.params.id)));

  api.get('/rooms/:id/history', wrap(async (req, res) => {
    const minutes = clampInt(req.query.minutes, 1, 1440, 60);
    res.json(await hub.history(req.params.id, minutes));
  }));

  api.get('/rooms/:id/decisions', wrap(async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 100, 20);
    const rows = await hub.decisions(req.params.id, limit);
    res.json(rows.map((d) => ({ ...d, ts: +new Date(d.ts) })));
  }));

  api.get('/rooms/:id/summary', wrap(async (req, res) => {
    const hours = clampInt(req.query.hours, 1, 168, 24);
    res.json(await hub.summary(req.params.id, hours));
  }));

  api.post('/rooms/:id/override', (req, res) => {
    try {
      res.json(hub.setOverride(req.params.id, req.body || {}));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  api.delete('/rooms/:id/override', (req, res) => {
    res.json(hub.clearOverride(req.params.id));
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error('[http]', err);
    res.status(500).json({ error: 'Server error. Check the server log.' });
  });

  if (config.simulate.length) {
    const rooms = config.site.rooms.filter((r) => config.simulate.includes(r.id));
    const sim = new SimEngine({
      rooms,
      airQuality: config.site.airQuality,
      speed: Number(process.env.SIM_SPEED) || 6,
      send: (roomId, kind, payload) => hub.ingest(roomId, kind, payload),
      forcedRain: () => weather.forced,
    });
    for (const room of hub.list()) if (room.override) sim.setOverride(room.id, room.override);
    hub.on('override', ({ roomId, override }) => sim.setOverride(roomId, override));
    sim.start(2000);
    console.log(`[sim] simulating ${rooms.map((r) => r.id).join(', ') || 'no rooms (check SIMULATE ids)'}`);
  }

  if (controller.roomIds.length) {
    // Re-decide right away when someone sets or clears a hold.
    hub.on('override', ({ roomId }) => controller.controls(roomId) && controller.decideRoom(roomId));
    weather.start();
    controller.start();
    console.log(`[controller] deciding fan and window for ${controller.roomIds.join(', ')} (publishes <room>/cmd and <room>/heartbeat)`);
  }
  if (weather.forced !== null) console.log(`[weather] demo setting: rain chance forced to ${weather.forced}%`);

  server.listen(config.port, () => {
    console.log(`[http] dashboard on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    console.log('\nShutting down…');
    hub.stop();
    controller.stop();
    weather.stop();
    await Promise.all(hub.list().map((r) => store.saveRoom(r).catch(() => {})));
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
