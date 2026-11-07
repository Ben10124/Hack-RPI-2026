// RoomHub keeps the live state of every room, merges incoming messages
// (from MQTT or the simulator), stores snapshots and decisions in the
// database, manages manual overrides, and emits events for the dashboard.

const EventEmitter = require('events');

// Which message fields map to which room fields. Aliases let the hardware
// team use slightly different names without breaking anything.
const FIELDS = {
  sensors: {
    temp: 'temp', temperature: 'temp',
    humidity: 'humidity',
    pressure: 'pressure',
    aq: 'aq', co2: 'aq', air: 'aq', airQuality: 'aq',
    rpm: 'fanRpm', fanRpm: 'fanRpm', fan_rpm: 'fanRpm',
    window: 'windowPct', windowPct: 'windowPct',
  },
  occupancy: { people: 'people', count: 'people' },
  cmd: { fan: 'fanPct', window: 'windowCmd', reason: 'reason', mode: 'mode' },
  context: { booked: 'booked', rainChance: 'rainChance', outdoorTemp: 'outdoorTemp', nextEvent: 'nextEvent' },
  // The device driving the fan and servo reports what it actually applied.
  actuators: { window: 'windowPct', rpm: 'fanRpm', fanRpm: 'fanRpm' },
};

const SOURCE = { sensors: 'sensors', occupancy: 'camera', cmd: 'controller', context: 'controller', actuators: 'actuators' };
const PERCENT_FIELDS = new Set(['fanPct', 'windowPct', 'windowCmd', 'rainChance']);
const TREND_WINDOW_MS = 60 * 60 * 1000;

class RoomHub extends EventEmitter {
  constructor({ store, site, readingIntervalMs }) {
    super();
    this.store = store;
    this.site = site;
    this.readingIntervalMs = readingIntervalMs;
    this.rooms = new Map();
    this.pressureHistory = new Map();
    this.saveTimers = new Map();
    this.lastDecision = new Map();
  }

  async init(simulatedIds = []) {
    const saved = await this.store.loadRooms();
    for (const room of saved) this.rooms.set(room.id, { ...defaultRoom(room.id), ...room });
    for (const cfg of this.site.rooms) {
      const room = this.rooms.get(cfg.id) || defaultRoom(cfg.id);
      Object.assign(room, { name: cfg.name, areaSqft: cfg.areaSqft ?? null, capacity: cfg.capacity ?? null });
      this.rooms.set(cfg.id, room);
    }
    for (const room of this.rooms.values()) {
      room.simulated = simulatedIds.includes(room.id);
      const since = new Date(Date.now() - TREND_WINDOW_MS);
      const rows = await this.store.getReadings(room.id, since);
      this.pressureHistory.set(
        room.id,
        rows.filter((r) => isNum(r.pressure)).map((r) => ({ t: +new Date(r.ts), p: r.pressure })),
      );
      const last = await this.store.getDecisions(room.id, 1);
      if (last[0]) this.lastDecision.set(room.id, last[0]);
    }

    this.snapshotTimer = setInterval(() => this.snapshotAll().catch(logError('snapshot')), this.readingIntervalMs);
    this.expiryTimer = setInterval(() => this.expireOverrides(), 2000);
  }

  stop() {
    clearInterval(this.snapshotTimer);
    clearInterval(this.expiryTimer);
  }

  list() {
    return [...this.rooms.values()].map(clone);
  }

  get(id) {
    const room = this.rooms.get(id);
    return room ? clone(room) : null;
  }

  ensureRoom(id) {
    if (!this.rooms.has(id)) this.rooms.set(id, defaultRoom(id));
    return this.rooms.get(id);
  }

  // kind: sensors | occupancy | cmd | context | actuators
  ingest(roomId, kind, payload) {
    if (!FIELDS[kind] || !isValidRoomId(roomId) || !payload || typeof payload !== 'object') return false;
    const room = this.ensureRoom(roomId);
    const now = Date.now();
    const patch = {};

    for (const [key, value] of Object.entries(payload)) {
      const field = FIELDS[kind][key];
      if (!field) continue;
      const clean = cleanValue(field, value);
      if (clean !== undefined) patch[field] = clean;
    }
    if (!Object.keys(patch).length) return false;

    // While a dashboard override is active the dashboard owns the mode label.
    if (room.override && patch.mode === 'auto') delete patch.mode;

    Object.assign(room, patch);
    room.lastSeen = { ...room.lastSeen, [SOURCE[kind]]: now };
    room.updatedAt = now;

    if (kind === 'cmd') this.maybeLogDecision(room).catch(logError('decision'));
    this.touch(room);
    return true;
  }

  async maybeLogDecision(room) {
    // Log real changes of plan, not every small wobble: a new kind of reason
    // (numbers ignored), a mode change, the window moving, or a big fan change.
    const prev = this.lastDecision.get(room.id);
    const shape = (s) => String(s || '').replace(/\d+(\.\d+)?/g, '#');
    const sinceLast = prev ? Date.now() - +new Date(prev.ts) : Infinity;
    const changed =
      !prev ||
      shape(prev.reason) !== shape(room.reason) ||
      prev.mode !== room.mode ||
      Math.abs((prev.window ?? -100) - (room.windowCmd ?? -100)) >= 5 ||
      (Math.abs((prev.fan ?? -100) - (room.fanPct ?? -100)) >= 10 && sinceLast > 20000);
    if (!changed) return;
    const decision = {
      room: room.id,
      ts: new Date(),
      fan: room.fanPct,
      window: room.windowCmd,
      reason: room.reason,
      mode: room.mode,
      people: room.people,
      aq: room.aq,
    };
    this.lastDecision.set(room.id, decision);
    await this.store.insertDecision(decision);
    this.emit('decision', decision);
  }

  setOverride(roomId, { fan, window, minutes, by }) {
    const room = this.rooms.get(roomId);
    if (!room) throw httpError(404, `No room called "${roomId}"`);
    const fanValue = fan === null || fan === undefined || fan === '' ? null : Number(fan);
    const windowValue = window === null || window === undefined || window === '' ? null : Number(window);
    if (fanValue === null && windowValue === null) throw httpError(400, 'Set a fan speed, a window opening, or both.');
    for (const [name, v] of [['Fan speed', fanValue], ['Window opening', windowValue]]) {
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) throw httpError(400, `${name} must be between 0 and 100.`);
    }
    const mins = minutes === undefined ? 15 : Number(minutes);
    if (!Number.isFinite(mins) || mins < 1 || mins > 240) throw httpError(400, 'Duration must be between 1 and 240 minutes.');

    const now = Date.now();
    room.override = {
      fan: fanValue === null ? null : Math.round(fanValue),
      window: windowValue === null ? null : Math.round(windowValue),
      setAt: now,
      expiresAt: now + mins * 60 * 1000,
      by: typeof by === 'string' && by.trim() ? by.trim().slice(0, 40) : 'dashboard',
    };
    room.mode = 'manual';
    room.updatedAt = now;
    this.store
      .insertOverride({ room: roomId, ts: new Date(now), action: 'set', ...room.override })
      .catch(logError('override log'));
    this.emit('override', { roomId, override: room.override });
    this.touch(room);
    return clone(room);
  }

  clearOverride(roomId, action = 'cleared') {
    const room = this.rooms.get(roomId);
    if (!room) throw httpError(404, `No room called "${roomId}"`);
    if (!room.override) return clone(room);
    room.override = null;
    room.mode = 'auto';
    room.updatedAt = Date.now();
    this.store.insertOverride({ room: roomId, ts: new Date(), action }).catch(logError('override log'));
    this.emit('override', { roomId, override: null });
    this.touch(room);
    return clone(room);
  }

  expireOverrides() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.override && room.override.expiresAt <= now) this.clearOverride(room.id, 'expired');
    }
  }

  async snapshotAll() {
    const staleMs = (this.site.staleAfterSeconds || 30) * 1000;
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const seen = Object.values(room.lastSeen || {}).filter(Boolean);
      if (!seen.length || now - Math.max(...seen) > staleMs) continue;
      const reading = {
        room: room.id,
        ts: new Date(now),
        people: room.people,
        aq: room.aq,
        temp: room.temp,
        pressure: room.pressure,
        fanPct: room.fanPct,
        fanRpm: room.fanRpm,
        windowPct: room.windowPct ?? room.windowCmd,
      };
      await this.store.insertReading(reading);
      this.updatePressureTrend(room, now);
      this.emit('reading', reading);
    }
  }

  // Pressure trend in hPa per hour from a least-squares line over the last hour.
  updatePressureTrend(room, now) {
    if (!isNum(room.pressure)) return;
    const list = this.pressureHistory.get(room.id) || [];
    list.push({ t: now, p: room.pressure });
    while (list.length && now - list[0].t > TREND_WINDOW_MS) list.shift();
    this.pressureHistory.set(room.id, list);
    if (list.length < 6 || list[list.length - 1].t - list[0].t < 3 * 60 * 1000) {
      room.pressureTrend = null;
      return;
    }
    const n = list.length;
    const meanT = list.reduce((s, x) => s + x.t, 0) / n;
    const meanP = list.reduce((s, x) => s + x.p, 0) / n;
    let num = 0;
    let den = 0;
    for (const x of list) {
      num += (x.t - meanT) * (x.p - meanP);
      den += (x.t - meanT) ** 2;
    }
    const perMs = den ? num / den : 0;
    room.pressureTrend = Math.round(perMs * 3600 * 1000 * 100) / 100;
    this.touch(room);
  }

  async history(roomId, minutes) {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const rows = await this.store.getReadings(roomId, since);
    return downsample(rows, 180);
  }

  async decisions(roomId, limit) {
    return this.store.getDecisions(roomId, limit);
  }

  async summary(roomId, hours) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const poor = this.site.airQuality?.poor ?? Infinity;
    const stats = await this.store.summary(roomId, since, poor);
    const minutesPerSample = this.readingIntervalMs / 60000;
    return {
      hours,
      samples: stats.samples,
      peakPeople: stats.peakPeople ?? null,
      avgPeople: round1(stats.avgPeople),
      avgAq: round1(stats.avgAq),
      minutesPoorAir: Math.round((stats.poorSamples || 0) * minutesPerSample),
    };
  }

  // Emit right away for the dashboard, save to the database at most once a second.
  touch(room) {
    this.emit('room', clone(room));
    if (this.saveTimers.has(room.id)) return;
    this.saveTimers.set(
      room.id,
      setTimeout(() => {
        this.saveTimers.delete(room.id);
        this.store.saveRoom(clone(this.rooms.get(room.id))).catch(logError('save room'));
      }, 1000),
    );
  }
}

function defaultRoom(id) {
  return {
    id,
    name: id,
    areaSqft: null,
    capacity: null,
    simulated: false,
    people: null,
    booked: null,
    aq: null,
    temp: null,
    humidity: null,
    pressure: null,
    pressureTrend: null,
    fanPct: null,
    fanRpm: null,
    windowPct: null,
    windowCmd: null,
    reason: null,
    mode: 'auto',
    rainChance: null,
    outdoorTemp: null,
    nextEvent: null,
    override: null,
    lastSeen: { sensors: null, camera: null, controller: null, actuators: null },
    updatedAt: null,
  };
}

function cleanValue(field, value) {
  if (field === 'reason') return typeof value === 'string' ? value.slice(0, 240) : undefined;
  if (field === 'mode') return value === 'auto' || value === 'manual' ? value : undefined;
  if (field === 'nextEvent') {
    if (value === null) return null;
    if (!value || typeof value !== 'object') return undefined;
    const start = new Date(value.start);
    return {
      title: String(value.title || 'Booked').slice(0, 80),
      start: Number.isNaN(+start) ? null : start.getTime(),
      people: isNum(Number(value.people)) ? Number(value.people) : null,
    };
  }
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (field === 'people' || field === 'booked') return Math.max(0, Math.round(n));
  if (PERCENT_FIELDS.has(field)) return Math.min(100, Math.max(0, Math.round(n)));
  return Math.round(n * 100) / 100;
}

// Average consecutive rows into at most maxPoints buckets so charts stay light.
function downsample(rows, maxPoints) {
  const out = rows.map((r) => ({ ...r, ts: +new Date(r.ts) }));
  if (out.length <= maxPoints) return out;
  const size = Math.ceil(out.length / maxPoints);
  const result = [];
  for (let i = 0; i < out.length; i += size) {
    const chunk = out.slice(i, i + size);
    const point = { room: chunk[0].room, ts: chunk[chunk.length - 1].ts };
    for (const key of ['people', 'aq', 'temp', 'pressure', 'fanPct', 'fanRpm', 'windowPct']) {
      const vals = chunk.map((r) => r[key]).filter(isNum);
      point[key] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
    }
    result.push(point);
  }
  return result;
}

function isValidRoomId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round1(v) {
  return isNum(v) ? Math.round(v * 10) / 10 : null;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function logError(label) {
  return (err) => console.error(`[hub] ${label} failed:`, err.message);
}

module.exports = { RoomHub, isValidRoomId };
