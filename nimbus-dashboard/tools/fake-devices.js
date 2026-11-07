// Pretends to be the UNO Q, the camera counter and the Pi 4 controller by
// publishing simulated rooms over MQTT. Use it to test the full MQTT path
// before the hardware is ready, or to fill extra rooms during a demo.
//
//   node tools/fake-devices.js                         -> room1 on mqtt://127.0.0.1:1883
//   node tools/fake-devices.js --url mqtt://10.0.0.5:1883 --rooms room2,room3
//
// It also listens for <room>/override messages from the dashboard and obeys
// them, the same way the real controller should.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mqtt = require('mqtt');
const { SimEngine } = require('../server/sim-engine');
const site = require('../config/rooms.json');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const url = arg('url', process.env.MQTT_URL || 'mqtt://127.0.0.1:1883');
const prefix = arg('prefix', process.env.MQTT_PREFIX || '');
const ids = arg('rooms', 'room1').split(',').map((s) => s.trim()).filter(Boolean);
const rooms = ids.map((id) => site.rooms.find((r) => r.id === id) || { id, name: id, areaSqft: 600, capacity: 20 });

const client = mqtt.connect(url, { clientId: `nimbus-fake-${Math.random().toString(16).slice(2, 8)}` });
const sim = new SimEngine({
  rooms,
  airQuality: site.airQuality,
  speed: Number(arg('speed', 6)),
  send: (roomId, kind, payload) => client.publish(`${prefix}${roomId}/${kind}`, JSON.stringify(payload)),
});

client.on('connect', () => {
  console.log(`[fake] connected to ${url}, publishing ${ids.join(', ')}`);
  client.subscribe(ids.map((id) => `${prefix}${id}/override`));
  if (!sim.timer) sim.start(2000);
});

client.on('message', (topic, buf) => {
  const roomId = topic.slice(prefix.length).split('/')[0];
  try {
    const msg = JSON.parse(buf.toString());
    if (msg.mode === 'manual') {
      sim.setOverride(roomId, { fan: msg.fan, window: msg.window, expiresAt: Date.parse(msg.expiresAt) });
      console.log(`[fake] ${roomId}: override received, fan ${msg.fan}%, window ${msg.window}%`);
    } else {
      sim.setOverride(roomId, null);
      console.log(`[fake] ${roomId}: back to automatic`);
    }
  } catch (err) {
    console.warn(`[fake] bad override message on ${topic}`);
  }
});

client.on('error', (err) => console.error('[fake] MQTT error:', err.message));
