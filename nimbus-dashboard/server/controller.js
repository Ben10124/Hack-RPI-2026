// Controller for real rooms. Every few seconds it reads the room's live state
// from the hub (people from the camera, air from the sensors), adds weather
// and bookings, runs the rules in server/rules.js and:
//
//   publishes <room>/cmd        { fan, window, reason, mode } for the fan + servo device
//   publishes <room>/heartbeat  every 2 s, so the device can fail safe without it
//   updates the dashboard       (cmd and context go straight into the hub)
//
// Safety: if neither the air sensors nor the people counter have reported
// recently, it commands the safe state (window closed, fan 50%). The device
// driving the fan and servo must also close the window on its own when it
// hears no cmd or heartbeat for 10 s (master doc, section 11).

const rules = require('./rules');

const DECIDE_MS = 5000;
const HEARTBEAT_MS = 2000;
const SAFE = { fan: 50, window: 0 };
const STARTED_AT = Date.now();

class RoomController {
  constructor({ hub, site, roomIds, weather, publish }) {
    this.hub = hub;
    this.site = site;
    this.roomIds = roomIds;
    this.weather = weather;
    this.publish = publish;
  }

  start() {
    if (!this.roomIds.length) return;
    this.decideAll();
    this.decideTimer = setInterval(() => this.decideAll(), DECIDE_MS);
    this.heartbeatTimer = setInterval(() => {
      for (const id of this.roomIds) this.publish(`${id}/heartbeat`, { t: Math.floor(Date.now() / 1000) });
    }, HEARTBEAT_MS);
  }

  stop() {
    clearInterval(this.decideTimer);
    clearInterval(this.heartbeatTimer);
  }

  controls(roomId) {
    return this.roomIds.includes(roomId);
  }

  decideAll() {
    for (const id of this.roomIds) this.decideRoom(id);
  }

  decideRoom(roomId) {
    const room = this.hub.get(roomId);
    const cfg = this.site.rooms.find((r) => r.id === roomId) || {};
    if (!room) return;
    const now = Date.now();
    const staleMs = (this.site.staleAfterSeconds || 30) * 1000;
    const fresh = (t) => Boolean(t) && now - t <= staleMs;
    const sensorsOk = fresh(room.lastSeen?.sensors);
    const cameraOk = fresh(room.lastSeen?.camera);

    const weather = this.weather.current();
    const { current, next } = bookingsAt(cfg.bookings, now);
    const shown = current && current.end - now > 60000 ? current : next;
    this.hub.ingest(roomId, 'context', {
      booked: current ? current.booked : 0,
      rainChance: weather.rainChance,
      outdoorTemp: weather.outdoorTemp,
      nextEvent: shown ? { title: shown.title, start: new Date(shown.start).toISOString(), people: shown.booked } : null,
    });

    let cmd;
    if (!sensorsOk && !cameraOk && !room.override) {
      cmd = {
        ...SAFE,
        mode: 'auto',
        reason: `No recent data from the air sensor or the people counter, so the window is closed and the fan is at ${SAFE.fan}% to be safe.`,
      };
    } else {
      cmd = rules.decide(
        {
          people: cameraOk ? room.people : null,
          aq: sensorsOk ? room.aq : null,
          areaSqft: cfg.areaSqft,
          capacity: cfg.capacity,
          rainChance: weather.rainChance,
          pressureTrend: sensorsOk ? room.pressureTrend : null,
          current,
          next,
          override: room.override,
          now,
        },
        this.site.airQuality,
      );
    }
    this.hub.ingest(roomId, 'cmd', cmd);
    this.publish(`${roomId}/cmd`, cmd);
  }
}

// Bookings from config/rooms.json:
//   "bookings": [{ "title": "Physics lecture", "start": "15:00", "minutes": 50, "people": 24 }]
// "start" is a time today ("HH:MM", server's local time), a full ISO date, or
// "+N": N minutes after the server started (handy for a demo: restart the
// server a few minutes before judging).
function bookingsAt(list, now) {
  const events = (Array.isArray(list) ? list : [])
    .map((b) => {
      const start = parseStart(b.start, now);
      if (start === null) return null;
      const minutes = Number(b.minutes) > 0 ? Number(b.minutes) : 60;
      const booked = Number(b.people);
      return {
        title: String(b.title || 'Booked').slice(0, 80),
        start,
        end: start + minutes * 60000,
        booked: Number.isFinite(booked) ? booked : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  return {
    current: events.find((e) => e.start <= now && e.end > now) || null,
    next: events.find((e) => e.start > now) || null,
  };
}

function parseStart(value, now) {
  if (typeof value !== 'string') return null;
  const rel = value.trim().match(/^\+(\d+(?:\.\d+)?)$/);
  if (rel) return STARTED_AT + Number(rel[1]) * 60000;
  const hm = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d.getTime();
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

module.exports = { RoomController, bookingsAt };
