// Virtual model room: plays the part of the fan and the window servo while the real
// ones aren't connected. It follows the same live decisions the Pi would receive
// (the room's fan and window from <room>/cmd), swings the window at servo speed,
// spins the fan up and down with some inertia, and copies the Pi script's fail-safe:
// no decision for 10 s -> window closed, fan 50%.
//
// Open it as /model.html#room1 (any room id works, including simulated rooms).

(() => {
  'use strict';

  const MAX_FLAP_DEG = 70; // flap angle drawn for a fully open window
  const FLAP_DEG_PER_S = 47; // about pi4/actuators.py: 60°/s over a 90° servo travel
  const FAN_TAU_S = 1.2; // fan spin-up / spin-down time constant
  const RPM_PER_PCT = 18; // same fan model as the simulator (1,800 rpm at 100%)
  const SPIN_DEG_PER_S = 900; // drawn blade speed at 100% (slowed so the eye can follow)
  const WATCHDOG_MS = 10000; // same as the Pi script
  const FAILSAFE = { fan: 50, window: 0 };
  const MAX_PEOPLE_DRAWN = 12;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (sel) => document.querySelector(sel);
  const field = (f) => document.querySelector(`[data-f="${f}"]`);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  // "#room1" or a dashboard-style "#/room/room1"
  const roomId = decodeURIComponent(location.hash.replace(/^#/, '').split('/').filter(Boolean).pop() || '') || 'room1';

  const els = {
    flap: $('#flap'),
    blades: $('#blades'),
    flow: $('#flow'),
    flowPaths: [...document.querySelectorAll('#flow path')],
    exhaust: $('#exhaust'),
    inflow: $('#inflow'),
    haze: $('#haze'),
    rain: $('#rain'),
    rainLines: $('#rain-lines'),
    people: $('#people'),
    more: $('#people-more'),
    chip: $('#chip'),
    chipText: $('#chip-text'),
    windowCap: $('#window-cap'),
    fanCap: $('#fan-cap'),
    sceneTitle: $('#scene-title'),
    status: $('#sim-status'),
    reason: $('#reason'),
  };

  const state = {
    config: null,
    room: null,
    status: null,
    connected: false,
    lastCmdAt: null, // performance.now() when the controller last made a decision
    controllerTs: null,
    target: null,
    flapDeg: 0,
    fan: 0,
    bladeDeg: 0,
    dash: 0,
    haze: 0,
    lastFrame: null,
    lastText: 0,
    peopleDrawn: null,
  };

  // ---------- helpers

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function pct(v, fallback) {
    return isNum(v) ? clamp(v, 0, 100) : fallback;
  }

  function fmt(n) {
    return Math.round(n).toLocaleString();
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function set(el, text) {
    if (el && el.textContent !== String(text)) el.textContent = text;
  }

  async function getJson(url) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }

  function levels() {
    const aq = state.config?.airQuality || {};
    const good = isNum(aq.good) ? aq.good : 800;
    const poor = isNum(aq.poor) ? aq.poor : 1200;
    return { good, poor, near: good - 0.375 * (poor - good) };
  }

  function airWord(aq) {
    const { good, poor, near } = levels();
    if (aq >= poor) return 'Needs air';
    if (aq >= good) return 'Getting stuffy';
    if (aq >= near) return 'Starting to build up';
    return 'Fresh air';
  }

  function raining() {
    return isNum(state.room?.rainChance) && state.room.rainChance >= 50;
  }

  // ---------- what the device should be doing

  function target(now) {
    const room = state.room;
    if (!room || state.lastCmdAt === null) return { ...FAILSAFE, failsafe: true, waiting: true };
    if (now - state.lastCmdAt > WATCHDOG_MS) return { ...FAILSAFE, failsafe: true, waiting: false };
    return { fan: pct(room.fanPct, 0), window: pct(room.windowCmd ?? room.windowPct, 0), failsafe: false, waiting: false };
  }

  function hazeFor(room) {
    if (!room || !isNum(room.aq)) return 0;
    const { poor, near } = levels();
    return 0.05 + 0.6 * clamp((room.aq - near) / (poor - near), 0, 1);
  }

  // ---------- incoming data

  function onRoom(room) {
    if (!room || room.id !== roomId) return;
    const ts = room.lastSeen?.controller ?? null;
    if (ts && ts !== state.controllerTs) {
      // On first load, count the age the server reports, so a stale room starts in fail-safe.
      const age = state.room === null ? Math.max(0, Date.now() - ts) : 0;
      state.lastCmdAt = performance.now() - age;
    }
    state.controllerTs = ts;
    const first = state.room === null;
    state.room = room;
    if (first) {
      document.title = `${room.name} · Virtual model room · Nimbus`;
      set($('#title'), `${room.name}: virtual model room`);
      set($('#back-text'), `${room.name} dashboard`);
      $('#back').href = `/#/room/${encodeURIComponent(room.id)}`;
    }
    renderPeople(room.people);
  }

  function renderPeople(n) {
    const count = isNum(n) ? Math.max(0, Math.round(n)) : null;
    if (count === state.peopleDrawn) return;
    state.peopleDrawn = count;
    els.people.textContent = '';
    const shown = count === null ? 0 : Math.min(count, MAX_PEOPLE_DRAWN);
    const left = 250;
    const right = 680;
    const gap = shown > 1 ? Math.min(46, (right - left) / (shown - 1)) : 0;
    const start = (left + right) / 2 - (gap * (shown - 1)) / 2;
    for (let i = 0; i < shown; i++) {
      const x = start + i * gap;
      const person = document.createElementNS(SVG_NS, 'g');
      person.setAttribute('class', 'person');
      const head = document.createElementNS(SVG_NS, 'circle');
      head.setAttribute('cx', x.toFixed(1));
      head.setAttribute('cy', '353');
      head.setAttribute('r', '11');
      const body = document.createElementNS(SVG_NS, 'path');
      body.setAttribute('d', `M${(x - 15).toFixed(1)} 420 v-34 a15 15 0 0 1 30 0 v34 z`);
      person.append(head, body);
      els.people.append(person);
    }
    els.more.textContent = count !== null && count > shown ? `+${count - shown}` : '';
  }

  // ---------- animation

  function frame(now) {
    const dt = state.lastFrame === null ? 0 : Math.min(0.1, (now - state.lastFrame) / 1000);
    state.lastFrame = now;
    const t = target(now);
    state.target = t;

    const flapGoal = (t.window / 100) * MAX_FLAP_DEG;
    if (reduced.matches) {
      state.flapDeg = flapGoal;
      state.fan = t.fan;
    } else {
      const step = FLAP_DEG_PER_S * dt;
      const d = flapGoal - state.flapDeg;
      state.flapDeg = Math.abs(d) <= step ? flapGoal : state.flapDeg + Math.sign(d) * step;
      state.fan += (t.fan - state.fan) * (1 - Math.exp(-dt / FAN_TAU_S));
      if (Math.abs(t.fan - state.fan) < 0.05) state.fan = t.fan;
      state.bladeDeg = (state.bladeDeg + (state.fan / 100) * SPIN_DEG_PER_S * dt) % 360;
    }
    const openFrac = state.flapDeg / MAX_FLAP_DEG;
    const airflow = clamp((state.fan + openFrac * 50) / 100, 0, 1);

    els.flap.setAttribute('transform', `rotate(${state.flapDeg.toFixed(2)} 180 150)`);
    els.blades.setAttribute('transform', `rotate(${state.bladeDeg.toFixed(2)} 740 205)`);
    els.exhaust.setAttribute('opacity', (state.fan / 100).toFixed(2));
    els.inflow.setAttribute('opacity', openFrac.toFixed(2));
    els.flow.setAttribute('opacity', (airflow > 0.01 ? 0.25 + 0.6 * airflow : 0).toFixed(2));
    if (!reduced.matches) {
      state.dash = (state.dash - (20 + 240 * airflow) * dt) % 1800;
      for (const p of els.flowPaths) p.style.strokeDashoffset = state.dash.toFixed(1);
    }

    state.haze += (hazeFor(state.room) - state.haze) * (1 - Math.exp(-dt / 1.5));
    els.haze.setAttribute('opacity', state.haze.toFixed(3));
    if (!reduced.matches) {
      els.haze.setAttribute('transform', `translate(${(Math.sin(now / 2400) * 18).toFixed(1)} ${(Math.cos(now / 3100) * 6).toFixed(1)})`);
    }

    const wet = raining();
    els.rain.setAttribute('opacity', wet ? '1' : '0');
    if (wet && !reduced.matches) els.rainLines.setAttribute('transform', `translate(0 ${(((now / 1000) * 90) % 36).toFixed(1)})`);

    if (now - state.lastText > 200) {
      state.lastText = now;
      renderText(t);
    }
    requestAnimationFrame(frame);
  }

  // ---------- text

  function renderText(t) {
    const room = state.room;
    if (!room) return;
    const windowPct = Math.round((state.flapDeg / MAX_FLAP_DEG) * 100);
    const windowText = windowPct === 0 ? 'Closed' : `${windowPct}% open`;
    const fanPct = Math.round(state.fan);
    const unit = state.config?.airQuality?.unit || '';
    const forced = isNum(state.status?.forcedRain);

    set(els.windowCap, windowText);
    set(els.fanCap, `${fanPct}%`);

    let status;
    let statusState;
    let chip = '';
    if (t.waiting) {
      statusState = 'waiting';
      status = 'Waiting for the first decision from the controller. Holding the safe state: window closed, fan 50%.';
      chip = 'WAITING FOR COMMANDS';
    } else if (t.failsafe) {
      statusState = 'failsafe';
      status = 'Fail-safe: no decision from the server for over 10 s, so the window is closed and the fan runs at 50%.';
      chip = 'FAIL-SAFE';
    } else if (!state.connected) {
      statusState = 'lost';
      status = 'Lost the server. Holding the last decision until the 10 s fail-safe.';
    } else {
      statusState = 'live';
      status = "Following the controller live: the same decisions the Pi's fan and servo would get.";
    }
    els.status.dataset.state = statusState;
    set(els.status, status);
    els.chip.setAttribute('opacity', chip ? '1' : '0');
    set(els.chipText, chip || ' ');

    let reason = room.reason || 'Waiting for the controller to make its first decision.';
    if (t.waiting) reason = 'Waiting for the first decision. Until then the window stays closed and the fan runs at 50%.';
    else if (t.failsafe) reason = 'No decision from the server for 10 s, so the window is closed and the fan is at 50% to be safe.';
    set(els.reason, reason);

    set(field('people'), isNum(room.people) ? room.people : '–');
    set(field('people-sub'), isNum(room.booked) && room.booked > 0 ? `${room.booked} booked` : isNum(room.capacity) ? `Seats ${room.capacity}` : '');
    set(field('aq-label'), state.config?.airQuality?.label || 'Air quality');
    set(field('aq'), isNum(room.aq) ? `${fmt(room.aq)}${unit ? ` ${unit}` : ''}` : '–');
    set(field('aq-sub'), isNum(room.aq) ? airWord(room.aq) : 'Waiting for data');
    set(field('fan'), `${fanPct}%`);
    set(field('fan-sub'), fanPct > 0 ? `About ${fmt(fanPct * RPM_PER_PCT)} rpm` : 'Stopped');
    set(field('window'), windowText);
    set(field('window-sub'), `Flap at ${Math.round(state.flapDeg)}°`);

    const manual = !t.failsafe && room.mode === 'manual';
    $('#manual-tag').hidden = !manual;
    if (t.waiting) {
      set(field('mode'), 'Waiting');
      set(field('mode-sub'), 'Safe state until the first decision');
    } else if (t.failsafe) {
      set(field('mode'), 'Fail-safe');
      set(field('mode-sub'), 'Window closed, fan 50%');
    } else if (manual) {
      set(field('mode'), 'Manual hold');
      set(field('mode-sub'), room.override?.expiresAt ? `Until ${fmtTime(room.override.expiresAt)}` : 'Set from the dashboard');
    } else {
      set(field('mode'), 'Automatic');
      set(field('mode-sub'), 'Following the controller');
    }

    set(field('rain'), isNum(room.rainChance) ? `${room.rainChance}%` : '–');
    set(field('rain-sub'), forced ? 'Demo setting' : raining() ? 'Rain likely' : isNum(room.rainChance) ? 'Dry' : '');

    set(
      els.sceneTitle,
      `Simulated model room: fan at ${fanPct}%, window ${windowText.toLowerCase()}, ` +
        `${isNum(room.people) ? room.people : 'unknown number of'} people` +
        `${isNum(room.aq) ? `, ${(state.config?.airQuality?.label || 'air quality').toLowerCase()} ${fmt(room.aq)}` : ''}.`,
    );
  }

  function setLive(mode) {
    $('#live').dataset.state = mode;
    set($('#live-text'), mode === 'live' ? 'Live' : mode === 'lost' ? 'Reconnecting' : 'Connecting');
  }

  // ---------- start

  async function start() {
    try {
      state.config = await getJson('/api/config');
      onRoom(await getJson(`/api/rooms/${encodeURIComponent(roomId)}`));
    } catch (e) {
      set(els.reason, `Can't load "${roomId}": ${e.message} Check the server is running and the room id after # in the address.`);
      set(els.status, 'Not connected.');
      return;
    }
    const socket = io();
    socket.on('connect', async () => {
      state.connected = true;
      setLive('live');
      try {
        onRoom(await getJson(`/api/rooms/${encodeURIComponent(roomId)}`));
      } catch (e) {
        console.error(e);
      }
    });
    socket.on('disconnect', () => {
      state.connected = false;
      setLive('lost');
    });
    socket.on('room', onRoom);
    socket.on('status', (s) => {
      state.status = s;
    });
    window.addEventListener('hashchange', () => location.reload());
    requestAnimationFrame(frame);
  }

  start();
})();
