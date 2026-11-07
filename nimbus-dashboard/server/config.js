const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const demo = process.argv.includes('--demo');

const roomsFile = path.join(__dirname, '..', 'config', 'rooms.json');
const site = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));

function bool(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

function parseSimulate(v) {
  const raw = String(v || '').trim();
  if (!raw) return [];
  if (raw === 'all') return site.rooms.map((r) => r.id);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'nimbus',
  mqttUrl: process.env.MQTT_URL || '',
  mqttPrefix: process.env.MQTT_PREFIX || '',
  embeddedBroker: bool(process.env.EMBEDDED_BROKER) || demo,
  embeddedBrokerPort: Number(process.env.EMBEDDED_BROKER_PORT) || 1883,
  simulate: parseSimulate(process.env.SIMULATE || (demo ? 'all' : '')),
  readingIntervalMs: (Number(process.env.READING_INTERVAL_SECONDS) || 10) * 1000,
  site,
};

if (config.embeddedBroker && !config.mqttUrl) {
  config.mqttUrl = `mqtt://127.0.0.1:${config.embeddedBrokerPort}`;
}

module.exports = config;
