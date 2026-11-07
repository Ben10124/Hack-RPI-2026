(() => {
  'use strict';

  const main = document.getElementById('main');
  const state = {
    config: null,
    rooms: new Map(),
    status: null,
    view: null,
    roomId: null,
    range: 15,
    history: [],
    decisions: [],
    summary: null,
    charts: {},
    lastReason: null,
    firstRoute: true,
  };

  const RANGES = [
    { minutes: 15, label: '15 min' },
    { minutes: 60, label: '1 hour' },
    { minutes: 360, label: '6 hours' },
    { minutes: 1440, label: '24 hours' },
  ];

  const ICONS = {
    fresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>',
    stuffy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v6"/><path d="M12 16.5v.5"/></svg>',
    poor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5"/><path d="M12 17.5v.3"/></svg>',
    offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M8 8l8 8"/></svg>',
    waiting: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/></svg>',
  };
  const LEVEL_TEXT = {
    fresh: 'Fresh air',
    stuffy: 'Getting stuffy',
    poor: 'Needs air',
    offline: 'Offline',
    waiting: 'Waiting for data',
  };
  const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

  // ---------- small helpers

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function fmtNum(v, digits = 0) {
    if (!isNum(v)) return '–';
    return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function toTemp(c) {
    if (!isNum(c)) return null;
    return state.config.temperatureUnit === 'F' ? (c * 9) / 5 + 32 : c;
  }

  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtAgo(ms) {
    if (!ms) return 'not seen yet';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function valueHtml(value, unit) {
    return `${esc(value)}${unit ? `<span class="metric-unit">${esc(unit)}</span>` : ''}`;
  }

  async function getJson(url, options) {
    const res = await fetch(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
    return body;
  }

  // ---------- status logic

  function isFresh(ms) {
    return Boolean(ms) && Date.now() - ms <= (state.config.staleAfterSeconds || 30) * 1000;
  }

  function airLevel(room) {
    const seen = room.lastSeen || {};
    if (!Object.values(seen).some(Boolean)) return 'waiting';
    if (!isFresh(seen.sensors) && !isFresh(seen.camera) && !isFresh(seen.controller)) return 'offline';
    if (!isNum(room.aq) || !isFresh(seen.sensors)) return 'waiting';
    const { good, poor } = state.config.airQuality;
    if (room.aq >= poor) return 'poor';
    if (room.aq >= good) return 'stuffy';
    return 'fresh';
  }

  function statusHtml(level, text = LEVEL_TEXT[level]) {
    return `<span class="status" data-level="${level}">${ICONS[level]}<span>${esc(text)}</span></span>`;
  }

  function tagsHtml(room) {
    let html = statusHtml(airLevel(room));
    if (room.mode === 'manual') html += '<span class="tag tag-manual">Manual</span>';
    if (room.simulated) html += '<span class="tag">Simulated</span>';
    return html;
  }

  function windowValue(room) {
    const w = room.windowPct ?? room.windowCmd;
    if (!isNum(w)) return { value: '–', unit: '' };
    return w === 0 ? { value: 'Closed', unit: '' } : { value: w, unit: '% open' };
  }

  function sortedRooms() {
    return [...state.rooms.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  }

  // ---------- overview

  function renderOverview() {
    state.view = 'overview';
    state.roomId = null;
    destroyCharts();
    document.title = state.config.siteName;
    const rooms = sortedRooms();
    if (!rooms.length) {
      main.innerHTML = `
        <div class="empty">
          <h2>No rooms yet</h2>
          <p>Rooms appear here as soon as a device publishes to <code>room1/sensors</code> or another room topic.</p>
          <p>To see simulated rooms right now, stop the server and start it with <code>npm run demo</code>.</p>
        </div>`;
      return;
    }
    const { label } = state.config.airQuality;
    main.innerHTML = `
      <h1 class="headline" id="building-headline"></h1>
      <ul class="rooms" aria-label="Rooms">
        ${rooms
          .map(
            (room) => `
          <li class="room-row" data-room="${esc(room.id)}">
            <a class="room-link" href="#/room/${encodeURIComponent(room.id)}">
              <div class="room-name-cell">
                <span class="room-name">${esc(room.name)}</span>
                <span class="tags" data-f="tags"></span>
              </div>
              <div class="cell-people"><span class="metric-label">People</span><span class="metric-value" data-f="people"></span><span class="metric-sub" data-f="booked"></span></div>
              <div class="cell-aq"><span class="metric-label">${esc(label)}</span><span class="metric-value" data-f="aq"></span></div>
              <div class="cell-fan"><span class="metric-label">Fan</span><span class="metric-value" data-f="fan"></span></div>
              <div class="cell-window"><span class="metric-label">Window</span><span class="metric-value" data-f="window"></span></div>
              <p class="room-reason" data-f="reason"></p>
            </a>
          </li>`,
          )
          .join('')}
      </ul>`;
    for (const room of rooms) updateRow(room);
    updateBuildingHeadline();
  }

  function updateRow(room) {
    const row = main.querySelector(`[data-room="${CSS.escape(room.id)}"]`);
    if (!row) {
      renderOverview();
      return;
    }
    const set = (f, html) => {
      const el = row.querySelector(`[data-f="${f}"]`);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    const win = windowValue(room);
    set('tags', tagsHtml(room));
    set('people', valueHtml(isNum(room.people) ? room.people : '–'));
    set('booked', isNum(room.booked) && room.booked > 0 ? esc(`${room.booked} booked`) : '');
    set('aq', valueHtml(fmtNum(room.aq), isNum(room.aq) ? state.config.airQuality.unit : ''));
    set('fan', valueHtml(isNum(room.fanPct) ? room.fanPct : '–', isNum(room.fanPct) ? '%' : ''));
    set('window', valueHtml(win.value, win.unit));
    set('reason', esc(room.reason || 'Waiting for the controller to make its first decision.'));
  }

  function updateBuildingHeadline() {
    const el = $('#building-headline');
    if (!el) return;
    const rooms = sortedRooms();
    const live = rooms.filter((r) => !['offline', 'waiting'].includes(airLevel(r)));
    const people = live.reduce((sum, r) => sum + (isNum(r.people) ? r.people : 0), 0);
    const poor = live.filter((r) => airLevel(r) === 'poor');
    const stuffy = live.filter((r) => airLevel(r) === 'stuffy');
    const offline = rooms.filter((r) => airLevel(r) === 'offline');

    let first = `${people} ${people === 1 ? 'person' : 'people'} across ${live.length} ${live.length === 1 ? 'room' : 'rooms'}.`;
    if (!live.length) first = 'No rooms are reporting right now.';
    let second = '';
    if (poor.length === 1) second = `${poor[0].name} needs air.`;
    else if (poor.length > 1) second = `${poor.length} rooms need air.`;
    else if (stuffy.length === 1) second = `${stuffy[0].name} is getting stuffy.`;
    else if (stuffy.length > 1) second = `${stuffy.length} rooms are getting stuffy.`;
    else if (live.length) second = 'The air is fresh everywhere.';
    if (offline.length) second += ` ${offline.length === 1 ? `${offline[0].name} is` : `${offline.length} rooms are`} offline.`;
    const text = `${first} ${second}`.trim();
    if (el.textContent !== text) el.textContent = text;
  }

  // ---------- room page

  function renderRoom(id) {
    const room = state.rooms.get(id);
    destroyCharts();
    if (!room) {
      state.view = 'missing';
      main.innerHTML = `
        <a class="crumb" href="#/">${BACK_ICON}All rooms</a>
        <div class="empty"><h2>No room called “${esc(id)}”</h2><p>Pick a room from the list of all rooms.</p></div>`;
      return;
    }
    state.view = 'room';
    state.roomId = id;
    state.lastReason = null;
    state.history = [];
    state.decisions = [];
    document.title = `${room.name} · ${state.config.siteName}`;
    const aq = state.config.airQuality;
    const rangeLabel = RANGES.find((r) => r.minutes === state.range)?.label || '';

    main.innerHTML = `
      <a class="crumb" href="#/">${BACK_ICON}All rooms</a>
      <div class="room-head">
        <h1 class="room-title" tabindex="-1" id="room-title">${esc(room.name)}</h1>
        <span class="tags" data-f="tags"></span>
        <span class="updated" data-f="updated"></span>
      </div>
      <p class="reason" id="reason"></p>

      <section class="readings" aria-label="Current readings">
        <div class="reading"><span class="metric-label">People</span><span class="metric-value" data-f="people"></span><span class="metric-sub" data-f="booked"></span></div>
        <div class="reading"><span class="metric-label">${esc(aq.label)}</span><span class="metric-value" data-f="aq"></span><span class="metric-sub" data-f="aq-sub"></span></div>
        <div class="reading"><span class="metric-label">Temperature</span><span class="metric-value" data-f="temp"></span><span class="metric-sub" data-f="outdoor"></span></div>
        <div class="reading"><span class="metric-label">Pressure</span><span class="metric-value" data-f="pressure"></span><span class="metric-sub" data-f="trend"></span></div>
        <div class="reading"><span class="metric-label">Fan</span><span class="metric-value" data-f="fan"></span><span class="metric-sub" data-f="rpm"></span></div>
        <div class="reading"><span class="metric-label">Window</span><span class="metric-value" data-f="window"></span><span class="metric-sub" data-f="mode"></span></div>
      </section>

      <div class="layout">
        <div class="primary">
        <section aria-labelledby="charts-title">
          <div class="section-head">
            <h2 class="section-title" id="charts-title">Last ${esc(rangeLabel)}</h2>
            <div class="range" role="group" aria-label="Time range">
              ${RANGES.map((r) => `<button type="button" data-range="${r.minutes}" aria-pressed="${r.minutes === state.range}">${r.label}</button>`).join('')}
            </div>
          </div>
          <div class="charts">
            ${chartSpecs()
              .map(
                (c) => `
              <figure class="chart-block" style="margin:0">
                <h3>${esc(c.title)}${c.unit ? ` <span>${esc(c.unit)}</span>` : ''}</h3>
                <div class="chart-frame"><canvas id="chart-${c.key}" role="img" aria-label="${esc(c.title)} over time"></canvas><div class="chart-empty" data-empty="${c.key}" hidden>No readings in this range yet.</div></div>
              </figure>`,
              )
              .join('')}
          </div>
          <details class="table-view">
            <summary>Show recent readings as a table</summary>
            <table class="data-table">
              <thead><tr><th scope="col">Time</th><th scope="col">People</th><th scope="col">${esc(aq.label)}</th><th scope="col">Temp</th><th scope="col">Pressure</th><th scope="col">Fan</th><th scope="col">Window</th></tr></thead>
              <tbody id="table-body"></tbody>
            </table>
          </details>
        </section>

        <section class="log-section" aria-labelledby="log-title">
          <div class="section-head"><h2 class="section-title" id="log-title">What the controller changed</h2></div>
          <ol class="log" id="log"></ol>
        </section>
        </div>

        <aside class="side">
          <section class="panel" aria-labelledby="ov-title">
            <h2 id="ov-title">Manual control</h2>
            <p class="held" id="held" hidden></p>
            <form id="override-form" novalidate>
              <div class="control">
                <label for="ov-fan"><span>Fan speed</span><output id="ov-fan-out" for="ov-fan"></output></label>
                <input type="range" id="ov-fan" min="0" max="100" step="5">
              </div>
              <div class="control">
                <label for="ov-window"><span>Window opening</span><output id="ov-window-out" for="ov-window"></output></label>
                <input type="range" id="ov-window" min="0" max="100" step="10">
              </div>
              <div class="control">
                <label for="ov-minutes">Hold for</label>
                <select id="ov-minutes">
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">1 hour</option>
                </select>
              </div>
              <div class="button-row">
                <button class="btn btn-primary" type="submit" id="ov-hold">Hold settings</button>
                <button class="btn btn-quiet" type="button" id="ov-clear" hidden>Return to automatic</button>
              </div>
              <p class="form-error" id="ov-error" role="alert" hidden></p>
            </form>
          </section>

          <section class="panel" aria-labelledby="sky-title">
            <h2 id="sky-title">Outside and schedule</h2>
            <dl class="facts">
              <dt>Rain chance</dt><dd data-f="rain"></dd>
              <dt>Pressure</dt><dd data-f="sky-trend"></dd>
              <dt>Outdoors</dt><dd data-f="sky-outdoor"></dd>
              <dt class="wide" data-f="event-label">Booked</dt><dd class="wide" data-f="event"></dd>
            </dl>
            <div class="button-row rain-demo">
              <button class="btn btn-quiet" type="button" id="rain-toggle" aria-pressed="false">Pretend rain is coming</button>
            </div>
            <p class="form-error" id="rain-error" role="alert" hidden></p>
          </section>

          <section class="panel" aria-labelledby="dev-title">
            <h2 id="dev-title">Devices</h2>
            <ul class="device-list">
              <li class="device"><span>Air sensors</span><span data-f="dev-sensors"></span></li>
              <li class="device"><span>People counter</span><span data-f="dev-camera"></span></li>
              <li class="device"><span>Controller</span><span data-f="dev-controller"></span></li>
            </ul>
          </section>

          <section class="panel" aria-labelledby="sum-title">
            <h2 id="sum-title">Last 24 hours</h2>
            <dl class="facts" id="summary"></dl>
          </section>
        </aside>
      </div>`;

    main.querySelectorAll('.range button').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.range = Number(btn.dataset.range);
        main.querySelectorAll('.range button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        $('#charts-title').textContent = `Last ${RANGES.find((r) => r.minutes === state.range).label}`;
        loadHistory();
      }),
    );
    setupOverrideForm(room);
    $('#rain-toggle').addEventListener('click', toggleRain);
    updateRainToggle();
    updateRoomLive(room);
    buildCharts();
    loadHistory();
    loadDecisions();
    loadSummary();
    if (!state.firstRoute) $('#room-title').focus();
  }

  function updateRoomLive(room) {
    const set = (f, html) => {
      const el = main.querySelector(`[data-f="${f}"]`);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    };
    const aq = state.config.airQuality;
    const unitT = `°${state.config.temperatureUnit}`;
    const level = airLevel(room);
    const win = windowValue(room);

    set('tags', tagsHtml(room));
    set('updated', room.updatedAt ? esc(`Updated ${fmtAgo(room.updatedAt)}`) : '');
    set('people', valueHtml(isNum(room.people) ? room.people : '–'));
    set('booked', isNum(room.booked) && room.booked > 0 ? esc(`${room.booked} booked`) : esc(isNum(room.capacity) ? `Seats ${room.capacity}` : ''));
    set('aq', valueHtml(fmtNum(room.aq), isNum(room.aq) ? aq.unit : ''));
    set('aq-sub', esc(LEVEL_TEXT[level]));
    set('temp', valueHtml(fmtNum(toTemp(room.temp), 1), isNum(room.temp) ? unitT : ''));
    set('outdoor', isNum(room.outdoorTemp) ? esc(`${fmtNum(toTemp(room.outdoorTemp), 0)}${unitT} outside`) : '');
    set('pressure', valueHtml(fmtNum(room.pressure, 1), isNum(room.pressure) ? 'hPa' : ''));
    set('trend', esc(trendText(room.pressureTrend)));
    set('fan', valueHtml(isNum(room.fanPct) ? room.fanPct : '–', isNum(room.fanPct) ? '%' : ''));
    set('rpm', isNum(room.fanRpm) ? esc(`${fmtNum(room.fanRpm)} rpm measured`) : '');
    set('window', valueHtml(win.value, win.unit));
    set('mode', esc(room.mode === 'manual' ? 'Manual control' : 'Automatic'));

    const forced = isNum(state.status?.forcedRain);
    set('rain', isNum(room.rainChance) ? esc(`${room.rainChance}%${forced ? ' (demo setting)' : ''}`) : '–');
    set('sky-trend', esc(isNum(room.pressure) ? trendText(room.pressureTrend) : '–'));
    set('sky-outdoor', isNum(room.outdoorTemp) ? esc(`${fmtNum(toTemp(room.outdoorTemp), 0)}${unitT}`) : '–');
    const ev = room.nextEvent;
    if (ev && ev.start) {
      const now = Date.now() >= ev.start;
      set('event-label', now ? 'Now' : 'Next');
      const who = isNum(ev.people) ? `, ${ev.people} booked` : '';
      set('event', esc(now ? `${ev.title}${who}` : `${ev.title} at ${fmtTime(ev.start)}${who}`));
    } else {
      set('event-label', 'Booked');
      set('event', 'Nothing booked');
    }

    for (const [key, label] of [['sensors', 'dev-sensors'], ['camera', 'dev-camera'], ['controller', 'dev-controller']]) {
      const seen = room.lastSeen?.[key];
      const lvl = !seen ? 'waiting' : isFresh(seen) ? 'fresh' : 'offline';
      set(label, statusHtml(lvl, seen ? fmtAgo(seen) : 'Not seen yet'));
    }

    const reasonEl = $('#reason');
    const reason = room.reason || 'Waiting for the controller to make its first decision.';
    if (reasonEl && reason !== state.lastReason) {
      reasonEl.textContent = reason;
      if (state.lastReason !== null) {
        reasonEl.classList.remove('is-changing');
        void reasonEl.offsetWidth;
        reasonEl.classList.add('is-changing');
      }
      state.lastReason = reason;
    }
    updateHeld(room);
  }

  function trendText(trend) {
    if (!isNum(trend)) return 'Measuring trend…';
    if (Math.abs(trend) < 0.15) return 'Steady';
    return `${trend < 0 ? 'Falling' : 'Rising'} ${fmtNum(Math.abs(trend), 1)} hPa/h`;
  }

  // ---------- manual override

  function setupOverrideForm(room) {
    const fan = $('#ov-fan');
    const win = $('#ov-window');
    const ov = room.override;
    fan.value = String(ov?.fan ?? snap(room.fanPct ?? 50, 5));
    win.value = String(ov?.window ?? snap(room.windowPct ?? room.windowCmd ?? 0, 10));
    const sync = () => {
      $('#ov-fan-out').textContent = `${fan.value}%`;
      $('#ov-window-out').textContent = win.value === '0' ? 'Closed' : `${win.value}%`;
    };
    fan.addEventListener('input', sync);
    win.addEventListener('input', sync);
    sync();

    $('#override-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await sendOverride('POST', { fan: Number(fan.value), window: Number(win.value), minutes: Number($('#ov-minutes').value) });
    });
    $('#ov-clear').addEventListener('click', () => sendOverride('DELETE'));
  }

  async function sendOverride(method, body) {
    const err = $('#ov-error');
    const buttons = [$('#ov-hold'), $('#ov-clear')];
    err.hidden = true;
    buttons.forEach((b) => (b.disabled = true));
    try {
      const room = await getJson(`/api/rooms/${encodeURIComponent(state.roomId)}/override`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      state.rooms.set(room.id, room);
      updateRoomLive(room);
    } catch (e) {
      err.textContent = `${e.message} Nothing was changed.`;
      err.hidden = false;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function updateHeld(room) {
    const held = $('#held');
    const clear = $('#ov-clear');
    if (!held) return;
    const ov = room.override;
    if (!ov) {
      held.hidden = true;
      clear.hidden = true;
      $('#ov-hold').textContent = 'Hold settings';
      return;
    }
    const parts = [];
    if (isNum(ov.fan)) parts.push(`fan at ${ov.fan}%`);
    if (isNum(ov.window)) parts.push(ov.window === 0 ? 'window closed' : `window ${ov.window}% open`);
    const left = Math.max(0, Math.ceil((ov.expiresAt - Date.now()) / 60000));
    const html = `Holding ${esc(parts.join(' and '))} until <strong>${esc(fmtTime(ov.expiresAt))}</strong> (${left} min left).`;
    if (held.innerHTML !== html) held.innerHTML = html;
    held.hidden = false;
    clear.hidden = false;
    $('#ov-hold').textContent = 'Update held settings';
  }

  // ---------- demo setting: pretend rain is coming

  function updateRainToggle() {
    const btn = $('#rain-toggle');
    if (!btn) return;
    const forced = isNum(state.status?.forcedRain);
    btn.textContent = forced ? 'Stop pretending it will rain' : 'Pretend rain is coming';
    btn.setAttribute('aria-pressed', String(forced));
  }

  async function toggleRain() {
    const btn = $('#rain-toggle');
    const err = $('#rain-error');
    const forced = isNum(state.status?.forcedRain);
    err.hidden = true;
    btn.disabled = true;
    try {
      state.status = await getJson('/api/weather/rain', {
        method: forced ? 'DELETE' : 'POST',
        headers: forced ? undefined : { 'Content-Type': 'application/json' },
        body: forced ? undefined : JSON.stringify({ chance: 80 }),
      });
      renderFooter();
      updateRainToggle();
    } catch (e) {
      err.textContent = `${e.message} Nothing was changed.`;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function snap(v, step) {
    return Math.min(100, Math.max(0, Math.round(v / step) * step));
  }

  // ---------- charts

  function chartSpecs() {
    const aq = state.config.airQuality;
    return [
      { key: 'people', title: 'People', unit: '', min: 0, precision: 0, digits: 0 },
      { key: 'fanPct', title: 'Fan speed', unit: '%', min: 0, max: 100, digits: 0 },
      {
        key: 'aq',
        title: aq.label,
        unit: aq.unit,
        digits: 0,
        suggestedMax: aq.poor * 1.08,
        thresholds: [
          { value: aq.good, label: 'Getting stuffy', color: 'warn' },
          { value: aq.poor, label: 'Needs air', color: 'bad' },
        ],
      },
      { key: 'pressure', title: 'Pressure', unit: 'hPa', digits: 1, minSpan: 2 },
    ];
  }

  const crosshairPlugin = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = cssVar('--muted');
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  const thresholdPlugin = {
    id: 'thresholds',
    beforeDatasetsDraw(chart, args, opts) {
      const lines = opts?.lines || [];
      if (!lines.length) return;
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      for (const line of lines) {
        const y = scales.y.getPixelForValue(line.value);
        if (y < chartArea.top - 1 || y > chartArea.bottom + 1) continue;
        ctx.strokeStyle = cssVar(`--${line.color}`);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, y);
        ctx.lineTo(chartArea.right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = cssVar('--ink-2');
        ctx.font = `12px ${cssVar('--text')}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${line.label} (${line.value})`, chartArea.left + 4, y - 3);
      }
      ctx.restore();
    },
  };

  function buildCharts() {
    destroyCharts();
    if (!window.Chart) return;
    const series = cssVar('--series');
    const ink = cssVar('--ink');
    const fog = cssVar('--fog');
    const muted = cssVar('--muted');
    const grid = cssVar('--grid');
    const font = cssVar('--text');
    Chart.defaults.font.family = font;
    Chart.defaults.font.size = 12;

    for (const spec of chartSpecs()) {
      const canvas = document.getElementById(`chart-${spec.key}`);
      if (!canvas) continue;
      state.charts[spec.key] = new Chart(canvas, {
        type: 'line',
        data: {
          datasets: [
            {
              data: [],
              borderColor: series,
              borderWidth: 2,
              pointRadius: 0,
              pointHitRadius: 12,
              pointHoverRadius: 5,
              pointHoverBackgroundColor: series,
              pointHoverBorderColor: fog,
              pointHoverBorderWidth: 2,
              tension: 0.25,
              spanGaps: 60000,
              fill: false,
            },
          ],
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          normalized: true,
          interaction: { mode: 'index', intersect: false },
          layout: { padding: { top: 6, right: 6 } },
          plugins: {
            legend: { display: false },
            thresholds: { lines: spec.thresholds || [] },
            tooltip: {
              displayColors: false,
              backgroundColor: ink,
              titleColor: fog,
              bodyColor: fog,
              padding: 10,
              cornerRadius: 8,
              titleFont: { family: font, weight: '400', size: 12 },
              bodyFont: { family: font, weight: '700', size: 14 },
              callbacks: {
                title: (items) => (items.length ? fmtTime(items[0].parsed.x) : ''),
                label: (item) => `${fmtNum(item.parsed.y, spec.digits)}${spec.unit ? ` ${spec.unit}` : ''}`,
              },
            },
          },
          scales: {
            x: {
              type: 'linear',
              grid: { display: false },
              border: { color: cssVar('--rule') },
              ticks: { color: muted, maxTicksLimit: 5, maxRotation: 0, callback: (v) => fmtTime(v) },
            },
            y: {
              min: spec.min,
              max: spec.max,
              suggestedMax: spec.suggestedMax,
              border: { display: false },
              grid: { color: grid, drawTicks: false },
              ticks: { color: muted, maxTicksLimit: 4, padding: 8, precision: spec.precision },
            },
          },
        },
        plugins: [crosshairPlugin, thresholdPlugin],
      });
    }
    redrawCharts();
  }

  function destroyCharts() {
    for (const chart of Object.values(state.charts)) chart.destroy();
    state.charts = {};
  }

  function redrawCharts() {
    const now = Date.now();
    const from = now - state.range * 60000;
    const rows = state.history.filter((r) => r.ts >= from);
    for (const spec of chartSpecs()) {
      const chart = state.charts[spec.key];
      if (!chart) continue;
      const points = rows.filter((r) => isNum(r[spec.key])).map((r) => ({ x: r.ts, y: r[spec.key] }));
      chart.data.datasets[0].data = points;
      chart.options.scales.x.min = from;
      chart.options.scales.x.max = now;
      if (spec.minSpan && points.length) {
        const ys = points.map((p) => p.y);
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        const pad = Math.max(0, (spec.minSpan - (hi - lo)) / 2);
        chart.options.scales.y.min = Math.floor((lo - pad) * 10) / 10;
        chart.options.scales.y.max = Math.ceil((hi + pad) * 10) / 10;
      }
      chart.update('none');
      const empty = main.querySelector(`[data-empty="${spec.key}"]`);
      if (empty) empty.hidden = points.length > 0;
    }
    renderTable(rows);
  }

  function renderTable(rows) {
    const body = $('#table-body');
    if (!body) return;
    const unitT = `°${state.config.temperatureUnit}`;
    const recent = rows.slice(-12).reverse();
    body.innerHTML = recent.length
      ? recent
          .map((r) => {
            const w = r.windowPct;
            return `<tr><td>${esc(fmtTime(r.ts))}</td><td>${fmtNum(r.people)}</td><td>${fmtNum(r.aq)}</td><td>${isNum(r.temp) ? esc(fmtNum(toTemp(r.temp), 1) + unitT) : '–'}</td><td>${fmtNum(r.pressure, 1)}</td><td>${isNum(r.fanPct) ? r.fanPct + '%' : '–'}</td><td>${isNum(w) ? (w === 0 ? 'Closed' : w + '%') : '–'}</td></tr>`;
          })
          .join('')
      : '<tr><td colspan="7">No readings in this range yet.</td></tr>';
  }

  async function loadHistory() {
    const id = state.roomId;
    try {
      const rows = await getJson(`/api/rooms/${encodeURIComponent(id)}/history?minutes=${state.range}`);
      if (state.roomId !== id) return;
      state.history = rows;
      redrawCharts();
    } catch (e) {
      console.error(e);
    }
  }

  function addReading(reading) {
    if (state.view !== 'room' || reading.room !== state.roomId) return;
    state.history.push(reading);
    const cutoff = Date.now() - state.range * 60000;
    while (state.history.length && state.history[0].ts < cutoff) state.history.shift();
    redrawCharts();
  }

  // ---------- decisions and summary

  async function loadDecisions() {
    const id = state.roomId;
    try {
      const rows = await getJson(`/api/rooms/${encodeURIComponent(id)}/decisions?limit=12`);
      if (state.roomId !== id) return;
      state.decisions = rows;
      renderDecisions();
    } catch (e) {
      console.error(e);
    }
  }

  function addDecision(decision) {
    if (state.view !== 'room' || decision.room !== state.roomId) return;
    state.decisions.unshift(decision);
    state.decisions = state.decisions.slice(0, 12);
    renderDecisions();
  }

  function renderDecisions() {
    const list = $('#log');
    if (!list) return;
    if (!state.decisions.length) {
      list.innerHTML = '<li><span></span><span></span><span class="why">No changes yet. Each time the controller changes the fan or window, it appears here with its reason.</span></li>';
      return;
    }
    list.innerHTML = state.decisions
      .map((d) => {
        const fan = isNum(d.fan) ? `Fan ${d.fan}%` : 'Fan unchanged';
        const win = isNum(d.window) ? (d.window === 0 ? 'window closed' : `window ${d.window}% open`) : '';
        const action = [fan, win].filter(Boolean).join(', ') + (d.mode === 'manual' ? ' (manual)' : '');
        return `<li><time datetime="${new Date(d.ts).toISOString()}">${esc(fmtTime(d.ts))}</time><span class="action">${esc(action)}</span><span class="why">${esc(d.reason || '')}</span></li>`;
      })
      .join('');
  }

  async function loadSummary() {
    const id = state.roomId;
    if (!id) return;
    try {
      const s = await getJson(`/api/rooms/${encodeURIComponent(id)}/summary?hours=24`);
      if (state.roomId !== id) return;
      const el = $('#summary');
      if (!el) return;
      const aq = state.config.airQuality;
      el.innerHTML = s.samples
        ? `<dt>Most people</dt><dd>${fmtNum(s.peakPeople)}</dd>
           <dt>Average ${esc(aq.label)}</dt><dd>${fmtNum(s.avgAq)} ${esc(aq.unit)}</dd>
           <dt>Time needing air</dt><dd>${fmtNum(s.minutesPoorAir)} min</dd>
           <dt>Readings stored</dt><dd>${fmtNum(s.samples)}</dd>`
        : '<dt>No readings stored yet</dt><dd></dd>';
    } catch (e) {
      console.error(e);
    }
  }

  // ---------- footer and connection

  function renderFooter() {
    const s = state.status;
    const footer = $('#footer');
    if (!s) return;
    const store =
      s.store === 'mongodb'
        ? `MongoDB${s.timeseries ? ', time series collection' : ''}`
        : 'in memory only. Set MONGODB_URI to keep history';
    const mqtt =
      s.mqtt === 'off' ? 'not listening. Set MQTT_URL' : `MQTT ${s.mqtt}${s.embeddedBroker ? ' (built-in broker)' : ''}`;
    const simulated = (s.simulated || []).map((id) => state.rooms.get(id)?.name || id);
    footer.innerHTML = `
      <span><strong>Data</strong> ${esc(store)}</span>
      <span><strong>Devices</strong> ${esc(mqtt)}</span>
      ${simulated.length ? `<span><strong>Simulated rooms</strong> ${esc(simulated.join(', '))}</span>` : ''}
      ${isNum(s.forcedRain) ? `<span><strong>Demo setting</strong> rain chance forced to ${esc(s.forcedRain)}%</span>` : ''}`;
  }

  function setLive(mode) {
    const el = $('#live');
    el.dataset.state = mode;
    $('#live-text').textContent = mode === 'live' ? 'Live' : mode === 'lost' ? 'Reconnecting' : 'Connecting';
    $('#offline-banner').hidden = mode !== 'lost';
  }

  // ---------- routing

  function route() {
    const hash = location.hash || '#/';
    const match = hash.match(/^#\/room\/([^/]+)/);
    if (match) renderRoom(decodeURIComponent(match[1]));
    else renderOverview();
    if (!state.firstRoute && !match) main.focus();
    state.firstRoute = false;
  }

  function onRoomUpdate(room) {
    const isNew = !state.rooms.has(room.id);
    state.rooms.set(room.id, room);
    if (state.view === 'overview') {
      if (isNew) renderOverview();
      else {
        updateRow(room);
        updateBuildingHeadline();
      }
    } else if (state.view === 'room' && room.id === state.roomId) {
      updateRoomLive(room);
    }
  }

  async function refreshRooms() {
    const rooms = await getJson('/api/rooms');
    state.rooms = new Map(rooms.map((r) => [r.id, r]));
  }

  async function start() {
    try {
      state.config = await getJson('/api/config');
      await refreshRooms();
    } catch (e) {
      main.innerHTML = `<div class="empty"><h2>Can't reach the server</h2><p>${esc(e.message)} Check that the server is running, then reload this page.</p></div>`;
      return;
    }
    $('#site-name').textContent = state.config.siteName;
    $('#building-name').textContent = state.config.buildingName || '';
    route();
    window.addEventListener('hashchange', route);

    const socket = io();
    socket.on('connect', async () => {
      setLive('live');
      try {
        await refreshRooms();
        if (state.view === 'room') {
          updateRoomLive(state.rooms.get(state.roomId));
          loadHistory();
          loadDecisions();
        } else if (state.view === 'overview') renderOverview();
      } catch (e) {
        console.error(e);
      }
    });
    socket.on('disconnect', () => setLive('lost'));
    socket.on('room', onRoomUpdate);
    socket.on('reading', addReading);
    socket.on('decision', addDecision);
    socket.on('status', (s) => {
      state.status = s;
      renderFooter();
      updateRainToggle();
    });

    // Relative times, staleness and countdowns
    setInterval(() => {
      if (state.view === 'overview') {
        for (const room of state.rooms.values()) updateRow(room);
        updateBuildingHeadline();
      } else if (state.view === 'room') {
        const room = state.rooms.get(state.roomId);
        if (room) updateRoomLive(room);
      }
    }, 1000);
    setInterval(() => state.view === 'room' && loadSummary(), 60000);

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.view === 'room') buildCharts();
    });
  }

  start();
})();
