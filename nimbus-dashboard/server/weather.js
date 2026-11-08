// Outdoor weather for the window decision: rain chance for the current hour
// and outdoor temperature from Open-Meteo (free, no key), refreshed every
// 10 minutes. The last good values are kept if a request fails.
//
// A demo setting can force the rain chance (FORCE_RAIN in .env, or the
// "Pretend rain is coming" button on the dashboard) so the rain behavior can
// be shown on a dry day. The dashboard labels it as a demo setting.

const REFRESH_MS = 10 * 60 * 1000;

class Weather {
  constructor({ lat, lon, forced = null }) {
    this.lat = lat;
    this.lon = lon;
    this.forced = forced;
    this.rainChance = null;
    this.outdoorTemp = null;
    this.fetchedAt = null;
    this.failing = false;
  }

  start() {
    if (!isNum(this.lat) || !isNum(this.lon)) {
      console.log('[weather] WEATHER_LAT / WEATHER_LON not set, no forecast');
      return;
    }
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async refresh() {
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${this.lat}&longitude=${this.lon}` +
      '&hourly=precipitation_probability&current=temperature_2m&forecast_days=2&timezone=GMT';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const hour = `${new Date().toISOString().slice(0, 13)}:00`;
      const i = data.hourly?.time?.indexOf(hour) ?? -1;
      const rain = i >= 0 ? data.hourly.precipitation_probability?.[i] : null;
      if (isNum(rain)) this.rainChance = rain;
      if (isNum(data.current?.temperature_2m)) this.outdoorTemp = data.current.temperature_2m;
      this.fetchedAt = Date.now();
      if (this.failing) console.log('[weather] forecast is back');
      this.failing = false;
    } catch (err) {
      if (!this.failing) console.warn(`[weather] could not fetch the forecast (${err.message}); keeping the last values`);
      this.failing = true;
    }
  }

  setForced(chance) {
    this.forced = isNum(chance) ? Math.min(100, Math.max(0, Math.round(chance))) : null;
  }

  current() {
    return {
      rainChance: this.forced ?? this.rainChance,
      outdoorTemp: this.outdoorTemp,
      forced: this.forced !== null,
    };
  }
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

module.exports = { Weather };
