// In-memory store: same interface as the MongoDB store. Used when MONGODB_URI
// is empty so the dashboard runs with zero setup. Data is lost on restart.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_READINGS_PER_ROOM = 20000;
const MAX_LOG = 500;

class MemoryStore {
  constructor() {
    this.name = 'memory';
    this.rooms = new Map();
    this.readings = new Map();
    this.decisions = new Map();
    this.overrides = new Map();
  }

  async init() {}

  async close() {}

  async loadRooms() {
    return [...this.rooms.values()].map((r) => ({ ...r }));
  }

  async saveRoom(room) {
    this.rooms.set(room.id, { ...room });
  }

  async insertReading(reading) {
    const list = this.readings.get(reading.room) || [];
    list.push({ ...reading });
    const cutoff = Date.now() - DAY_MS;
    while (list.length && (list.length > MAX_READINGS_PER_ROOM || list[0].ts < cutoff)) list.shift();
    this.readings.set(reading.room, list);
  }

  async getReadings(roomId, since) {
    return (this.readings.get(roomId) || []).filter((r) => r.ts >= since);
  }

  async insertDecision(decision) {
    pushCapped(this.decisions, decision.room, decision);
  }

  async getDecisions(roomId, limit) {
    return (this.decisions.get(roomId) || []).slice(-limit).reverse();
  }

  async insertOverride(entry) {
    pushCapped(this.overrides, entry.room, entry);
  }

  async summary(roomId, since, poorThreshold) {
    const rows = await this.getReadings(roomId, since);
    const people = rows.map((r) => r.people).filter(isNum);
    const aq = rows.map((r) => r.aq).filter(isNum);
    return {
      samples: rows.length,
      peakPeople: people.length ? Math.max(...people) : null,
      avgPeople: people.length ? avg(people) : null,
      avgAq: aq.length ? avg(aq) : null,
      poorSamples: aq.filter((v) => v >= poorThreshold).length,
    };
  }
}

function pushCapped(map, key, value) {
  const list = map.get(key) || [];
  list.push({ ...value });
  if (list.length > MAX_LOG) list.shift();
  map.set(key, list);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function avg(list) {
  return list.reduce((a, b) => a + b, 0) / list.length;
}

module.exports = { MemoryStore };
