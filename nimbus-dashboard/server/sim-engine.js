// Simulated rooms: people arriving for booked events, CO₂ building up,
// weather changing, and a controller reacting with the same rules the real
// Pi 4 controller will use. Lets you build and demo the dashboard before the
// hardware works.
//
// `send(roomId, kind, payload)` receives each message, where kind is one of
// sensors | occupancy | cmd | context, exactly like the MQTT topics.

const OUTDOOR_CO2 = 420;
const CO2_PER_PERSON_CFM = 0.011; // CO₂ exhaled by a seated adult, cubic feet per minute
const CFM_PER_PERSON = 10; // ASHRAE 62.1 classroom outdoor-air rate per person
const CFM_PER_SQFT = 0.12; // ASHRAE 62.1 classroom outdoor-air rate per floor area
const CEILING_FT = 9;
const INFILTRATION_ACH = 0.3;

const EVENT_TITLES = ['Physics lecture', 'CS study group', 'Calculus recitation', 'Club meeting', 'Lab section', 'Review session'];

class SimEngine {
  constructor({ rooms, airQuality, speed = 6, send }) {
    this.send = send;
    this.speed = speed;
    this.good = airQuality?.good ?? 800;
    this.poor = airQuality?.poor ?? 1200;
    this.weather = { pressure: 1013.2, drift: 0, rainChance: 15, outdoorTemp: 8 };
    this.rooms = rooms.map((cfg, i) => this.makeRoom(cfg, i));
    this.tickCount = 0;
  }

  makeRoom(cfg, index) {
    const area = cfg.areaSqft || 600;
    const capacity = cfg.capacity || 20;
    const now = Date.now();
    const room = {
      id: cfg.id,
      area,
      capacity,
      volume: area * CEILING_FT,
      maxCfm: CFM_PER_PERSON * capacity + CFM_PER_SQFT * area,
      people: index === 1 ? Math.round(capacity * 0.5) : 0,
      co2: index === 1 ? 980 : 520 + index * 40,
      temp: 21 + index * 0.4,
      fan: 20,
      window: 0,
      override: null,
      dropIn: /lounge|commons|lobby/i.test(cfg.name || ''),
      events: [],
    };
    // Stagger the first event so rooms change at different times during a demo.
    const firstStart = index === 1 ? now - 4 * 60000 : now + (2 + index * 3) * 60000;
    room.events.push(makeEvent(firstStart, capacity));
    return room;
  }

  start(intervalMs = 2000) {
    this.intervalMs = intervalMs;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  setOverride(roomId, override) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (room) room.override = override;
  }

  tick() {
    this.tickCount += 1;
    const now = Date.now();
    const dtMin = ((this.intervalMs || 2000) / 60000) * this.speed;
    this.stepWeather(dtMin);
    for (const room of this.rooms) {
      this.stepSchedule(room, now);
      this.stepPeople(room, now);
      const decision = this.decide(room, now);
      room.fan = decision.fan;
      room.window = decision.window;
      this.stepAir(room, dtMin);
      this.publish(room, decision, now);
    }
  }

  stepWeather(dtMin) {
    const w = this.weather;
    // Occasionally a front moves in (pressure falls, rain chance climbs), then clears.
    if (Math.random() < 0.01) w.drift = w.drift < 0 ? 0.6 : -1.8; // hPa per hour
    w.pressure += (w.drift / 60) * dtMin + (Math.random() - 0.5) * 0.02;
    w.pressure = clamp(w.pressure, 990, 1030);
    const target = w.drift < 0 ? 75 : 12;
    w.rainChance = clamp(w.rainChance + (target - w.rainChance) * 0.03 + (Math.random() - 0.5) * 2, 2, 95);
    w.outdoorTemp = clamp(w.outdoorTemp + (Math.random() - 0.5) * 0.05, 2, 14);
  }

  stepSchedule(room, now) {
    room.events = room.events.filter((e) => e.end > now);
    const last = room.events[room.events.length - 1];
    if (!last || room.events.length < 2) {
      const after = last ? last.end : now;
      room.events.push(makeEvent(after + randInt(3, 8) * 60000, room.capacity));
    }
  }

  stepPeople(room, now) {
    const current = room.events.find((e) => e.start <= now && e.end > now);
    let target = current ? current.attendance : room.dropIn ? randInt(1, 5) : 0;
    if (current && now > current.end - 60000) target = Math.round(target * 0.3); // people leaving early
    const diff = target - room.people;
    if (diff !== 0 && Math.random() < 0.6) room.people += Math.sign(diff) * Math.min(Math.abs(diff), randInt(1, 3));
    room.people = clamp(room.people, 0, room.capacity + 5);
  }

  decide(room, now) {
    const current = room.events.find((e) => e.start <= now && e.end > now);
    const next = room.events.find((e) => e.start > now);
    const minsToNext = next ? (next.start - now) / 60000 : Infinity;
    const raining = this.weather.rainChance >= 50;
    const falling = this.weather.drift < 0;

    if (room.override) {
      const fan = room.override.fan ?? room.fan;
      const window = room.override.window ?? room.window;
      return {
        fan,
        window,
        reason: `Manual override from the dashboard. Fan held at ${fan}%, window ${window === 0 ? 'closed' : `${window}% open`}.`,
        mode: 'manual',
      };
    }

    // ASHRAE-style demand: airflow for the people here plus the floor area.
    let needed = CFM_PER_PERSON * room.people + CFM_PER_SQFT * room.area;
    let preVent = false;
    if (next && minsToNext <= 10 && next.booked > room.people) {
      const ahead = 0.6 * (CFM_PER_PERSON * next.booked + CFM_PER_SQFT * room.area);
      if (ahead > needed) {
        needed = ahead;
        preVent = true;
      }
    }
    // Feedback from the air sensor: push harder when air is getting worse.
    if (room.co2 > this.good) needed *= 1 + Math.min(1, (room.co2 - this.good) / (this.poor - this.good)) * 0.6;

    let window = 0;
    if (!raining && room.people > 0 && room.co2 > this.good - 150) {
      window = room.co2 > this.poor ? 70 : 40;
    }
    const windowCfm = (window / 100) * 0.5 * room.maxCfm;
    let fan = Math.round(((needed - windowCfm) / room.maxCfm) * 100);
    fan = room.people === 0 && !preVent ? clamp(fan, 0, 15) : clamp(fan, 20, 100);

    // Explain the decision in one sentence a person can read from across the room.
    const aqLabel = room.co2 >= this.poor ? 'stale' : room.co2 >= this.good ? 'getting stuffy' : 'fresh';
    const co2 = Math.round(room.co2);
    const parts = [];
    if (preVent) {
      parts.push(`${next.title} starts in ${Math.max(1, Math.round(minsToNext))} min with ${next.booked} booked, so the room is being aired out ahead of time.`);
    } else if (current && room.people < current.booked * 0.5 && current.booked >= 6) {
      parts.push(`${current.title} was booked for ${current.booked} but only ${room.people} came, so ventilation is scaled down to save energy.`);
    } else if (room.people === 0) {
      parts.push(`Room is empty and the air is ${aqLabel} at ${co2} ppm.`);
    } else {
      parts.push(`${room.people} ${room.people === 1 ? 'person' : 'people'} here and the air is ${aqLabel} at ${co2} ppm.`);
    }
    if (window > 0) parts.push(`Fan at ${fan}%, window open ${window}% while it's dry outside.`);
    else if (raining) parts.push(`Fan at ${fan}%, window kept closed because rain is likely (${Math.round(this.weather.rainChance)}%).`);
    else if (falling && room.people > 0) parts.push(`Fan at ${fan}%, window closed as pressure is falling.`);
    else parts.push(`Fan at ${fan}%, window closed.`);

    return { fan, window, reason: parts.join(' '), mode: 'auto' };
  }

  stepAir(room, dtMin) {
    const fanCfm = (room.fan / 100) * room.maxCfm;
    const windowCfm = (room.window / 100) * 0.5 * room.maxCfm;
    const infiltration = (INFILTRATION_ACH / 60) * room.volume;
    const q = fanCfm + windowCfm + infiltration;
    const gen = (CO2_PER_PERSON_CFM * room.people * 1e6) / room.volume;
    const dC = gen - (q / room.volume) * (room.co2 - OUTDOOR_CO2);
    room.co2 = clamp(room.co2 + dC * dtMin + (Math.random() - 0.5) * 6, OUTDOOR_CO2, 3000);

    const comfort = 20.5 + room.people * 0.06 - (room.window / 100) * (20.5 - this.weather.outdoorTemp) * 0.25;
    room.temp += (comfort - room.temp) * 0.02 * this.speed + (Math.random() - 0.5) * 0.03;
  }

  publish(room, decision, now) {
    const next = room.events.find((e) => e.start > now);
    const current = room.events.find((e) => e.start <= now && e.end > now);
    const rpm = decision.fan > 0 ? Math.round(decision.fan * 18 + (Math.random() - 0.5) * 40) : 0;

    this.send(room.id, 'occupancy', { people: room.people });
    this.send(room.id, 'sensors', {
      temp: round(room.temp, 1),
      pressure: round(this.weather.pressure + (Math.random() - 0.5) * 0.04, 2),
      aq: Math.round(room.co2),
      rpm,
      window: decision.window,
    });
    this.send(room.id, 'cmd', decision);
    if (this.tickCount % 3 === 1) {
      const shown = current && current.end - now > 60000 ? current : next;
      this.send(room.id, 'context', {
        booked: current ? current.booked : 0,
        rainChance: Math.round(this.weather.rainChance),
        outdoorTemp: round(this.weather.outdoorTemp, 1),
        nextEvent: shown ? { title: shown.title, start: new Date(shown.start).toISOString(), people: shown.booked } : null,
      });
    }
  }
}

function makeEvent(start, capacity) {
  const booked = randInt(Math.round(capacity * 0.3), capacity);
  const noShow = Math.random() < 0.25;
  const attendance = noShow ? Math.max(1, Math.round(booked * 0.2)) : Math.round(booked * (0.75 + Math.random() * 0.25));
  return {
    title: EVENT_TITLES[randInt(0, EVENT_TITLES.length - 1)],
    start,
    end: start + randInt(8, 14) * 60000,
    booked,
    attendance,
  };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

module.exports = { SimEngine };
