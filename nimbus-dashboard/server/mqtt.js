// Connects to the MQTT broker, feeds device messages into the hub and
// publishes dashboard overrides back to the controller.
//
// Subscribes:  <prefix><room>/sensors     from the UNO Q
//              <prefix><room>/occupancy   from the Pi 4 camera counter
//              <prefix><room>/cmd         from an external controller (fan, window, reason)
//              <prefix><room>/context     from an external controller (calendar, weather)
// Publishes:   <prefix><room>/override    retained, for any external controller
//              <prefix><room>/cmd         and <room>/heartbeat for rooms this
//                                          server controls (via publish())
//
// For rooms this server controls, cmd and context messages from other
// publishers are ignored so two controllers never fight over one room.

const mqtt = require('mqtt');

const KINDS = ['sensors', 'occupancy', 'cmd', 'context'];

function startMqtt({ url, prefix, hub, onStatus, isControlled = () => false }) {
  if (!url) {
    console.log('[mqtt] MQTT_URL not set, not listening for devices');
    return { status: () => 'off', publish: () => {} };
  }

  let status = 'connecting';
  const setStatus = (s) => {
    if (s === status) return;
    status = s;
    onStatus?.(s);
  };

  const client = mqtt.connect(url, {
    clientId: `nimbus-dashboard-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  });

  client.on('connect', () => {
    setStatus('connected');
    console.log(`[mqtt] connected to ${url}`);
    client.subscribe(KINDS.map((k) => `${prefix}+/${k}`), { qos: 0 }, (err) => {
      if (err) console.error('[mqtt] subscribe failed:', err.message);
    });
  });
  client.on('reconnect', () => setStatus('reconnecting'));
  client.on('offline', () => setStatus('offline'));
  client.on('close', () => setStatus('reconnecting'));
  client.on('error', (err) => console.error('[mqtt] error:', err.message));

  const warned = new Set();
  client.on('message', (topic, buf) => {
    if (prefix && !topic.startsWith(prefix)) return;
    const [roomId, kind] = topic.slice(prefix.length).split('/');
    const text = buf.toString().trim();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    // A bare number on the occupancy topic is accepted as the people count.
    if (kind === 'occupancy' && typeof payload === 'number') payload = { people: payload };
    if ((kind === 'cmd' || kind === 'context') && isControlled(roomId)) return;
    const ok = hub.ingest(roomId, kind, payload);
    if (!ok && !warned.has(topic)) {
      warned.add(topic);
      console.warn(`[mqtt] ignored message on ${topic}: ${text.slice(0, 120)} (expected JSON with known fields)`);
    }
  });

  hub.on('override', ({ roomId, override }) => {
    const message = override
      ? { mode: 'manual', fan: override.fan, window: override.window, expiresAt: new Date(override.expiresAt).toISOString() }
      : { mode: 'auto' };
    client.publish(`${prefix}${roomId}/override`, JSON.stringify(message), { qos: 1, retain: true });
  });

  // Topic without the prefix, e.g. "room1/cmd". Dropped while disconnected
  // (the next decision a few seconds later replaces it anyway).
  const publish = (topic, payload) => {
    if (!client.connected) return;
    client.publish(`${prefix}${topic}`, JSON.stringify(payload), { qos: 0 });
  };

  return { status: () => status, publish, client };
}

module.exports = { startMqtt };
