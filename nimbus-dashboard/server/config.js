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

// Rooms the server's controller decides for. Empty -> every room that isn't
// simulated; "none" -> no controller (an external one publishes <room>/cmd).
function parseControl(v, simulated) {
  const raw = String(v || '').trim();
  if (['none', 'off', '0'].includes(raw.toLowerCase())) return [];
  const ids = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : site.rooms.map((r) => r.id);
  return ids.filter((id) => !simulated.includes(id));
}

function num(v, fallback) {
  if (v === undefined || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const simulate = parseSimulate(process.env.SIMULATE || (demo ? 'all' : ''));

const config = {
  port: Number(process.env.PORT) || 3000,
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'nimbus',
  mqttUrl: process.env.MQTT_URL || '',
  mqttPrefix: process.env.MQTT_PREFIX || '',
  embeddedBroker: bool(process.env.EMBEDDED_BROKER) || demo,
  embeddedBrokerPort: Number(process.env.EMBEDDED_BROKER_PORT) || 1883,
  simulate,
  control: parseControl(process.env.CONTROL, simulate),
  // Default: Rensselaer Polytechnic Institute, Troy NY (HackRPI venue)
  weatherLat: num(process.env.WEATHER_LAT, 42.7298),
  weatherLon: num(process.env.WEATHER_LON, -73.6789),
  forceRain: num(process.env.FORCE_RAIN, null),
  readingIntervalMs: (Number(process.env.READING_INTERVAL_SECONDS) || 10) * 1000,
  site,
};

if (config.embeddedBroker && !config.mqttUrl) {
  config.mqttUrl = `mqtt://127.0.0.1:${config.embeddedBrokerPort}`;
}

module.exports = config;
