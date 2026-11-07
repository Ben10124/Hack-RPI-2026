// Control rules (master doc, section 10). One implementation shared by the
// real-room controller (server/controller.js) and the simulator
// (server/sim-engine.js), so both always follow exactly the same rules.
//
// Air quality values are on whatever scale config/rooms.json sets
// (airQuality.good / airQuality.poor), so the same rules work for a true
// CO₂ sensor in ppm or a relative gas sensor.

const CFM_PER_PERSON = 10; // ASHRAE 62.1 classroom outdoor-air rate per person
const CFM_PER_SQFT = 0.12; // ASHRAE 62.1 classroom outdoor-air rate per floor area
const RAIN_LIKELY = 50; // % chance at or above which the window stays closed
const PRESSURE_FALLING = -0.5; // hPa per hour at or below which weather is worsening
const PREVENT_MINUTES = 10; // start airing out this long before a booked event
const WINDOW_CFM_SHARE = 0.5; // a fully open window moves about half the fan's max airflow
const FAN_MIN_STUFFY = 40; // % fan at least, when the air is getting stuffy
const FAN_MIN_POOR = 70; // % fan at least, when the air needs it

function maxCfm(capacity, areaSqft) {
  return CFM_PER_PERSON * capacity + CFM_PER_SQFT * areaSqft;
}

// "near" is where the window starts opening, a little below "getting stuffy"
// (650 ppm on the default 800 / 1200 ppm CO₂ scale).
function airLevels(airQuality) {
  const good = airQuality?.good ?? 800;
  const poor = airQuality?.poor ?? 1200;
  return { good, poor, near: good - 0.375 * (poor - good) };
}

// Convert a CO₂ ppm value onto the configured scale, anchoring 800 ppm to
// "good" and 1200 ppm to "poor". The identity on the default CO₂ config.
// The simulator models CO₂ physically and publishes through this.
function fromPpm(ppm, airQuality) {
  const { good, poor } = airLevels(airQuality);
  return Math.max(0, good + ((ppm - 800) * (poor - good)) / 400);
}

// input: { people, aq, areaSqft, capacity, rainChance, pressureTrend,
//          current, next, override, now }
//   people / aq / rainChance / pressureTrend may be null when unknown.
//   current / next: { title, start, end, booked } (ms timestamps) or null.
//   override: { fan, window } where null means "decide that one automatically".
// Returns { fan, window, reason, mode }.
function decide(input, airQuality) {
  const { good, poor, near } = airLevels(airQuality);
  const area = input.areaSqft || 600;
  const capacity = input.capacity || 20;
  const max = maxCfm(capacity, area);
  const now = input.now ?? Date.now();
  const { current, next, override } = input;

  const people = isNum(input.people) ? input.people : null;
  const aq = isNum(input.aq) ? input.aq : null;
  const rain = isNum(input.rainChance) ? input.rainChance : null;
  const trend = isNum(input.pressureTrend) ? input.pressureTrend : null;
  const raining = rain !== null && rain >= RAIN_LIKELY;
  const falling = trend !== null && trend <= PRESSURE_FALLING;
  // Without a people count, treat the room as occupied when the air is building up.
  const occupied = people !== null ? people > 0 : aq !== null && aq >= near;

  // 1. Base airflow: people here plus the floor area.
  let needed = CFM_PER_PERSON * (people ?? 0) + CFM_PER_SQFT * area;

  // 2. Pre-ventilation before a booked event.
  const minsToNext = next ? (next.start - now) / 60000 : Infinity;
  let preVent = false;
  if (next && minsToNext <= PREVENT_MINUTES && isNum(next.booked) && next.booked > (people ?? 0)) {
    const ahead = 0.6 * (CFM_PER_PERSON * next.booked + CFM_PER_SQFT * area);
    if (ahead > needed) {
      needed = ahead;
      preVent = true;
    }
  }

  // 3. Air quality feedback: push harder as the air gets worse.
  if (aq !== null && aq > good) needed *= 1 + Math.min(1, (aq - good) / (poor - good)) * 0.6;

  // 4. Window: open only when the air needs it, it isn't likely to rain and
  //    the pressure isn't falling. Remember why it stayed closed.
  let window = 0;
  let closedBy = null;
  if (occupied && aq !== null && aq >= near) {
    if (raining) closedBy = 'rain';
    else if (falling) closedBy = 'pressure';
    else window = aq >= poor ? 70 : 40;
  }

  // 5. Fan makes up the rest.
  const windowCfm = (window / 100) * WINDOW_CFM_SHARE * max;
  let fan = Math.round(((needed - windowCfm) / max) * 100);
  fan = !occupied && !preVent ? clamp(fan, 0, 15) : clamp(fan, 20, 100);
  // Bad air always gets a strong fan, even when the window carries most of the
  // airflow or the room has just emptied, so the fan visibly works harder as
  // the air gets worse.
  if (aq !== null && aq >= poor) fan = Math.max(fan, FAN_MIN_POOR);
  else if (aq !== null && aq >= good) fan = Math.max(fan, FAN_MIN_STUFFY);

  // 6. Manual override wins, field by field.
  if (override) {
    const heldFan = isNum(override.fan);
    const heldWindow = isNum(override.window);
    if (heldFan) fan = override.fan;
    if (heldWindow) window = override.window;
    const fanText = heldFan ? `Fan held at ${fan}%` : `Fan set automatically to ${fan}%`;
    const windowText = heldWindow ? `window held ${windowWords(window)}` : `window set automatically: ${windowWords(window)}`;
    return { fan, window, reason: `Manual override from the dashboard. ${fanText}, ${windowText}.`, mode: 'manual' };
  }

  // 7. Explain it: one sentence for the cause, one for the action.
  const air = aq === null ? 'the air sensor is not reporting' : `the air is ${airWord(aq, near, good, poor)} (${reading(aq, airQuality)})`;
  let cause;
  if (preVent) {
    cause = `${next.title} starts in ${Math.max(1, Math.round(minsToNext))} min with ${next.booked} booked, so the room is being aired out ahead of time.`;
  } else if (current && people !== null && isNum(current.booked) && current.booked >= 6 && people < current.booked * 0.5) {
    cause = `${current.title} was booked for ${current.booked} but only ${people} came, so ventilation is scaled down to save energy.`;
  } else if (people === null) {
    cause = `No people count yet, and ${air}.`;
  } else if (people === 0) {
    cause = `Room is empty and ${air}.`;
  } else {
    cause = `${people} ${people === 1 ? 'person' : 'people'} here and ${air}.`;
  }

  let action;
  if (window > 0) action = `Fan at ${fan}%, window open ${window}%${rain !== null ? " while it's dry outside" : ''}.`;
  else if (closedBy === 'rain') action = `Fan at ${fan}%, window kept closed because rain is likely (${Math.round(rain)}%).`;
  else if (closedBy === 'pressure') action = `Fan at ${fan}%, window kept closed because the pressure is falling (${trend.toFixed(1)} hPa/h), a sign of worsening weather.`;
  else action = `Fan at ${fan}%, window closed.`;

  return { fan, window, reason: `${cause} ${action}`, mode: 'auto' };
}

function airWord(aq, near, good, poor) {
  if (aq >= poor) return 'stale';
  if (aq >= good) return 'getting stuffy';
  if (aq >= near) return 'starting to build up';
  return 'fresh';
}

function reading(aq, airQuality) {
  const label = airQuality?.label || 'Air quality';
  const unit = airQuality?.unit ? ` ${airQuality.unit}` : '';
  return `${label} ${Math.round(aq)}${unit}`;
}

function windowWords(w) {
  return w === 0 ? 'closed' : `${w}% open`;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

module.exports = { decide, maxCfm, fromPpm, airLevels, RAIN_LIKELY, PRESSURE_FALLING };
