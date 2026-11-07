#!/usr/bin/env python3
"""
controller.py - Nimbus controller: decides fan % and window % and publishes them over MQTT.

Follows NIMBUS_PROJECT.md: message contract (section 9), control rules (section 10) and
safety rules (section 11). Runs on the Pi 4 next to people_counter.py. The broker is the
Node server's built-in one on the laptop, so point --broker at the LAPTOP's IP.

Install:
    pip install "paho-mqtt>=1.6" requests icalendar recurring-ical-events
(requests / icalendar / recurring-ical-events are optional. Without them the weather or the
calendar is simply off, and the window stays closed when the weather is unknown.)

Run:
    python controller.py --broker <laptop-ip> --room room1 \
        --config ../nimbus-dashboard/config/rooms.json \
        --ical-url "https://.../room.ics" --lat 42.73 --lon -73.69
    python controller.py --self-test        # decision-logic tests, no broker needed

Room size, capacity and the air-quality thresholds are read from rooms.json when --config
is given (so they cannot drift from the dashboard); explicit flags override the file.

MQTT (room = room1; all JSON; add --prefix if the server uses MQTT_PREFIX)
  IN   room1/sensors     {"temp":..,"pressure":..,"aq":..,"rpm":..,"window":..}   UNO Q
  IN   room1/occupancy   {"people":7,...}                                         people_counter.py
  IN   room1/occupancy_status  "online"|"camera_error"|"offline"                  people_counter.py
  IN   room1/override    {"mode":"manual","fan":80,"window":null,"expiresAt":"<ISO>"} or {"mode":"auto"}
  OUT  room1/cmd         {"fan":65,"window":40,"reason":"...","mode":"auto"}   every ~5 s + on override
  OUT  room1/heartbeat   {"t":..}   every 2 s (the UNO Q closes the window if this stops for 10 s)
  OUT  room1/context     {"booked":..,"rainChance":..,"outdoorTemp":..,"nextEvent":{..}}   every ~20 s
  OUT  room1/controller_status  "online" / "offline" (last-will)

Control rules (section 10), in order
  1. needed_cfm = 10*people + 0.12*area ;  max_cfm = 10*capacity + 0.12*area
  2. Pre-ventilation: event within 10 min and more booked than present -> needed >= 60% of booked load
  3. Air quality: above the "stuffy" threshold, needed x up to 1.6 as air nears "poor"
  4. Window: open only if rain chance < 50%, pressure not falling fast, room occupied, and air
     near/above stuffy. 40% when stuffy, 70% when poor.
  5. Fan % = (needed - window_cfm) / max_cfm; clamped 20-100% occupied, 0-15% empty
  6. Manual override wins until it expires
  7. Publish cmd with a reason sentence
"""

import argparse
import json
import re
import signal
import threading
import time
from collections import deque
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

try:
    import requests
except ImportError:  # weather disabled
    requests = None
try:
    from icalendar import Calendar
except ImportError:  # calendar disabled
    Calendar = None
try:
    import recurring_ical_events
except ImportError:  # recurring events not expanded
    recurring_ical_events = None

running = True
DEFAULTS = {"area_sqft": 900.0, "capacity": 30.0, "aq_good": 800.0, "aq_poor": 1200.0, "aq_unit": "ppm"}


def _stop(*_):
    global running
    running = False


# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Nimbus ventilation controller")
    p.add_argument("--room", default="room1")
    p.add_argument("--prefix", default="", help="MQTT topic prefix, e.g. 'nimbus/' (server MQTT_PREFIX)")
    p.add_argument("--broker", default="localhost", help="the laptop's IP (embedded broker)")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--interval", type=float, default=5.0, help="seconds between decisions")
    p.add_argument("--context-interval", type=float, default=20.0)
    p.add_argument("--config", default=None, help="path to the dashboard's config/rooms.json")

    g = p.add_argument_group("room (default: from --config, else built-in)")
    g.add_argument("--area-sqft", type=float, default=None)
    g.add_argument("--capacity", type=float, default=None)
    g.add_argument("--aq-stuffy", dest="aq_good", type=float, default=None,
                   help="'good' limit in rooms.json: above this the air is getting stuffy")
    g.add_argument("--aq-poor", type=float, default=None, help="'poor' limit: air needs fresh air")
    g.add_argument("--aq-unit", default=None)
    g.add_argument("--cfm-per-person", type=float, default=10.0)
    g.add_argument("--cfm-per-sqft", type=float, default=0.12)
    g.add_argument("--window-cfm-frac", type=float, default=0.25,
                   help="ASSUMPTION: airflow of a fully open window as a fraction of max_cfm. "
                        "Match server/sim-engine.js if it defines window airflow differently.")

    g = p.add_argument_group("calendar")
    g.add_argument("--ical-url", default=None)
    g.add_argument("--ical-file", default=None)
    g.add_argument("--event-people", type=int, default=6, help="headcount when an event doesn't say")
    g.add_argument("--prevent-min", type=float, default=10.0)
    g.add_argument("--noshow-ratio", type=float, default=0.5, help="present <= this x booked = no-show")

    g = p.add_argument_group("weather / window")
    g.add_argument("--lat", type=float, default=42.73, help="default: Troy, NY")
    g.add_argument("--lon", type=float, default=-73.69)
    g.add_argument("--rain-prob", type=float, default=50.0, help="%% chance that keeps the window closed")
    g.add_argument("--rain-soon-min", type=float, default=60.0, help="close if rain is forecast within this")
    g.add_argument("--pressure-drop", type=float, default=1.5, help="hPa/h falling faster than this = fast")

    g = p.add_argument_group("smoothing / safety")
    g.add_argument("--stale-s", type=float, default=15.0, help="data older than this counts as unknown")
    g.add_argument("--fan-step-up", type=int, default=25)
    g.add_argument("--fan-step-down", type=int, default=10)
    g.add_argument("--hold-down-s", type=float, default=60.0)
    g.add_argument("--window-hold-s", type=float, default=60.0)
    g.add_argument("--fallback-fan", type=int, default=50, help="matches the UNO Q's own failsafe")
    g.add_argument("--override-max-min", type=float, default=60.0, help="hard cap on any override")
    g.add_argument("--allow-fake", action="store_true", help="accept occupancy with source=fake")
    p.add_argument("--self-test", action="store_true")
    cfg = p.parse_args(argv)
    resolve_config(cfg)
    return cfg


def resolve_config(cfg):
    from_file = {}
    if cfg.config:
        try:
            with open(cfg.config, encoding="utf-8") as f:
                data = json.load(f)
            aq = data.get("airQuality", {})
            room = next((r for r in data.get("rooms", []) if r.get("id") == cfg.room), None)
            if room is None:
                print("[controller] WARNING: room '%s' not found in %s" % (cfg.room, cfg.config))
                room = {}
            from_file = {"area_sqft": room.get("areaSqft"), "capacity": room.get("capacity"),
                         "aq_good": aq.get("good"), "aq_poor": aq.get("poor"), "aq_unit": aq.get("unit")}
        except Exception as exc:
            print("[controller] WARNING: could not read %s (%s); using built-in defaults" % (cfg.config, exc))
    for key, default in DEFAULTS.items():
        if getattr(cfg, key) is None:
            v = from_file.get(key)
            setattr(cfg, key, v if v is not None else default)
    for key in ("area_sqft", "capacity", "aq_good", "aq_poor"):
        setattr(cfg, key, float(getattr(cfg, key)))


# --------------------------------------------------------------------------------------
# Pure helpers (section 10)
# --------------------------------------------------------------------------------------
def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def quantize(pct, step=5):
    return int(round(pct / step) * step)


def aq_fraction(aq, good, poor):
    """0.0 at/below the stuffy limit, 1.0 at/above the poor limit, None if unknown."""
    if aq is None:
        return None
    if poor <= good:
        return 0.0
    return clamp((aq - good) / (poor - good), 0.0, 1.0)


def max_cfm(cfg):
    return cfg.cfm_per_person * cfg.capacity + cfg.cfm_per_sqft * cfg.area_sqft


def needed_cfm(cfg, people, frac, preventilating, booked):
    base = cfg.cfm_per_person * people + cfg.cfm_per_sqft * cfg.area_sqft
    if preventilating and booked and booked > people:
        booked_load = cfg.cfm_per_person * booked + cfg.cfm_per_sqft * cfg.area_sqft
        base = max(base, 0.6 * booked_load)
    return base * (1.0 + 0.6 * (frac or 0.0))


def window_target_pct(cfg, aq, occupied):
    """40% when stuffy, 70% when poor; 0 if empty or air quality unknown."""
    if aq is None or not occupied:
        return 0
    if aq >= cfg.aq_poor:
        return 70
    if aq >= 0.9 * cfg.aq_good:  # "near or above the stuffy threshold"
        return 40
    return 0


def fan_pct(cfg, needed, window_pct, occupied):
    mx = max_cfm(cfg)
    window_cfm = (window_pct / 100.0) * cfg.window_cfm_frac * mx
    raw = quantize((needed - window_cfm) / mx * 100.0)
    return int(clamp(raw, 20, 100) if occupied else clamp(raw, 0, 15))


def window_allowed(cfg, weather, pressure_trend):
    """Returns (allowed, short reason for the closed-window sentence)."""
    if weather is None or not weather.get("ok"):
        return False, "weather data is unavailable"
    rain_in = weather.get("rain_in_min")
    if rain_in is not None and rain_in <= cfg.rain_soon_min:
        return False, ("it is raining now" if rain_in <= 0 else "rain is expected in %d min" % rain_in)
    prob = weather.get("rain_prob")
    if prob is not None and prob >= cfg.rain_prob:
        return False, "rain is likely (%d%%)" % round(prob)
    if pressure_trend is not None and pressure_trend <= -cfg.pressure_drop:
        return False, "pressure is falling fast"
    return True, ""


def pressure_trend_hpa_per_h(samples):
    """Least-squares slope of [(epoch_s, hPa), ...]; None until >= 10 min of data."""
    if len(samples) < 5:
        return None
    t0 = samples[0][0]
    if samples[-1][0] - t0 < 10 * 60:
        return None
    xs = [(t - t0) / 3600.0 for t, _ in samples]
    ys = [p for _, p in samples]
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


class Smoother:
    """Fan: fast up, slow down. Window: closing for safety is immediate, other changes rate-limited."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.fan = 0
        self.lower_since = None
        self.window = 0
        self.window_changed_at = -1e9

    def fan_step(self, target, now):
        cfg = self.cfg
        if target > self.fan:
            self.lower_since = None
            self.fan = min(target, self.fan + cfg.fan_step_up)
        elif target < self.fan:
            if self.lower_since is None:
                self.lower_since = now
            if now - self.lower_since >= cfg.hold_down_s:
                self.fan = max(target, self.fan - cfg.fan_step_down)
        else:
            self.lower_since = None
        return self.fan

    def window_step(self, target, allowed, now):
        if not allowed:
            if self.window != 0:
                self.window = 0
                self.window_changed_at = now
            return self.window
        if target != self.window and now - self.window_changed_at >= self.cfg.window_hold_s:
            self.window = target
            self.window_changed_at = now
        return self.window


# --------------------------------------------------------------------------------------
# Reason sentences (section 10.5: one sentence for the cause, one for the action)
# --------------------------------------------------------------------------------------
def _air_phrase(cfg, aq):
    v = int(round(aq))
    if aq >= cfg.aq_poor:
        return "poor at %d %s" % (v, cfg.aq_unit)
    if aq > cfg.aq_good:
        return "getting stuffy at %d %s" % (v, cfg.aq_unit)
    return "fresh at %d %s" % (v, cfg.aq_unit)


def action_sentence(fan, window, wanted, allowed, closed_reason):
    if window > 0:
        w = "window open %d%%" % window + (" while it's dry outside" if allowed else "")
    elif wanted > 0 and not allowed and closed_reason:
        w = "window kept closed because %s" % closed_reason
    else:
        w = "window closed"
    return "Fan at %d%%, %s." % (fan, w)


def cause_sentence(cfg, s):
    n, aq = s["people_live"], s["aq"]
    if s["nothing_known"]:
        return "No people count or air readings are available, so the room is on a safe default."
    if s["prevent"]:
        ev = s["soon"]
        mins = max(1, int((ev["start"] - s["now"]) / 60))
        return "%s starts in %d min with %d booked, so the room is being aired out ahead of time." % (
            ev["title"][:30], mins, ev["people"])
    if s["noshow"]:
        ev = s["active"]
        return "%s was booked for %d but only %d came, so ventilation is scaled down to save energy." % (
            ev["title"][:30], ev["people"], n)
    if n is None and s["active"] is not None:
        return "The people counter is offline, so the room's booking (%d people) is being used." % s["active"]["people"]
    if n is None:
        return "The people counter is offline, so the air quality alone is driving the fan."
    air = (" and the air is %s" % _air_phrase(cfg, aq)) if aq is not None else ""
    if n == 0:
        return "Room is empty%s." % air
    return "%d %s here%s." % (n, "person" if n == 1 else "people", air)


# --------------------------------------------------------------------------------------
# Calendar (iCal)
# --------------------------------------------------------------------------------------
def _to_epoch(dt):
    if not hasattr(dt, "hour"):  # all-day date -> ignore
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()  # assume local time
    return dt.timestamp()


def _headcount(event, default):
    att = event.get("ATTENDEE")
    if att:
        return len(att) if isinstance(att, list) else 1
    m = re.search(r"(?:people|headcount|attendees)\D{0,3}(\d+)", str(event.get("DESCRIPTION", "")), re.I)
    return int(m.group(1)) if m else default


def load_events(cfg, now_s):
    """Events in roughly [now-1h, now+24h] as dicts {title,start,end,people}, or None."""
    if Calendar is None or not (cfg.ical_url or cfg.ical_file):
        return None
    try:
        if cfg.ical_url:
            if requests is None:
                return None
            r = requests.get(cfg.ical_url, timeout=10)
            r.raise_for_status()
            raw = r.content
        else:
            with open(cfg.ical_file, "rb") as f:
                raw = f.read()
        cal = Calendar.from_ical(raw)
        lo = datetime.fromtimestamp(now_s - 3600, tz=timezone.utc)
        hi = datetime.fromtimestamp(now_s + 24 * 3600, tz=timezone.utc)
        comps = recurring_ical_events.of(cal).between(lo, hi) if recurring_ical_events else cal.walk("VEVENT")
        out = []
        for ev in comps:
            s = _to_epoch(ev.get("DTSTART").dt) if ev.get("DTSTART") else None
            e = _to_epoch(ev.get("DTEND").dt) if ev.get("DTEND") else None
            if s is None:
                continue
            e = e if e is not None else s + 3600
            if e < now_s - 3600 or s > now_s + 24 * 3600:
                continue
            out.append({"title": str(ev.get("SUMMARY", "Event")), "start": s, "end": e,
                        "people": _headcount(ev, cfg.event_people)})
        out.sort(key=lambda x: x["start"])
        return out
    except Exception as exc:
        print("[controller] calendar error: %s" % exc)
        return None


def calendar_status(events, now_s, prevent_min):
    """(active_event, event_starting_within_prevent_window, next_event)."""
    if not events:
        return None, None, None
    active = next((e for e in events if e["start"] <= now_s < e["end"]), None)
    nxt = next((e for e in events if e["start"] > now_s), None)
    soon = nxt if nxt and nxt["start"] - now_s <= prevent_min * 60 else None
    return active, soon, nxt


# --------------------------------------------------------------------------------------
# Weather (Open-Meteo, no key)
# --------------------------------------------------------------------------------------
def fetch_weather(cfg):
    if requests is None:
        return None
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": cfg.lat, "longitude": cfg.lon, "timezone": "auto",
                    "current": "temperature_2m,precipitation",
                    "minutely_15": "precipitation", "forecast_minutely_15": 8,
                    "hourly": "precipitation_probability", "forecast_hours": 2},
            timeout=10)
        r.raise_for_status()
        d = r.json()
        cur = d.get("current", {})
        rain_in = 0 if (cur.get("precipitation") or 0) > 0 else None
        if rain_in is None:
            for i, v in enumerate(d.get("minutely_15", {}).get("precipitation", []) or []):
                if v and v > 0:
                    rain_in = i * 15
                    break
        probs = [x for x in (d.get("hourly", {}).get("precipitation_probability", []) or []) if x is not None]
        return {"ok": True, "rain_in_min": rain_in, "rain_prob": probs[0] if probs else None,
                "outdoor_temp": cur.get("temperature_2m"), "fetched": time.time()}
    except Exception as exc:
        print("[controller] weather error: %s" % exc)
        return None


# --------------------------------------------------------------------------------------
# Override parsing
# --------------------------------------------------------------------------------------
def parse_expires(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        v = float(v)
        return v / 1000.0 if v > 1e12 else v
    s = str(v).strip()
    if s.replace(".", "", 1).isdigit():
        return parse_expires(float(s))
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.timestamp()


# --------------------------------------------------------------------------------------
# Controller
# --------------------------------------------------------------------------------------
class Controller:
    def __init__(self, cfg):
        self.cfg = cfg
        self.base = "%s%s" % (cfg.prefix, cfg.room)
        self.lock = threading.Lock()
        self.occ = None
        self.occ_status = None
        self.sensors = None
        self.pressure_hist = deque()  # (epoch_s, hPa), 1 sample / 30 s, last hour
        self.override = None
        self.force = False  # decide right away (set when an override arrives)
        self.smoother = Smoother(cfg)
        self.events = None
        self.events_at = -1e9
        self.weather = None
        self.weather_at = -1e9

    # ---- inbound ----
    def on_message(self, topic, payload):
        try:
            text = payload.decode("utf-8", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload)
            with self.lock:
                if topic == self.base + "/occupancy_status":
                    self.occ_status = text.strip().strip('"')
                elif topic == self.base + "/occupancy":
                    d = json.loads(text)
                    if not isinstance(d, dict):  # bare number is also valid in the contract
                        d = {"people": d}
                    self.occ = {"people": int(d["people"]), "ts": float(d.get("ts", time.time())),
                                "source": d.get("source", "camera")}
                elif topic == self.base + "/sensors":
                    d = json.loads(text)
                    now = time.time()
                    d["_recv"] = now
                    self.sensors = d
                    pr = d.get("pressure")
                    if pr is not None and (not self.pressure_hist or now - self.pressure_hist[-1][0] >= 30):
                        self.pressure_hist.append((now, float(pr)))
                    while self.pressure_hist and now - self.pressure_hist[0][0] > 3600:
                        self.pressure_hist.popleft()
                elif topic == self.base + "/override":
                    self._set_override(json.loads(text), time.time())
        except Exception as exc:
            print("[controller] bad message on %s: %s (%s)" % (topic, exc, str(payload)[:80]))

    def _set_override(self, d, now):
        self.force = True
        if d.get("mode") == "auto" or d.get("auto"):
            self.override = None
            print("[controller] override cleared")
            return
        fan, win = d.get("fan"), d.get("window")
        if fan is None and win is None:
            self.override = None  # nothing held; keep deciding both automatically
            return
        until = parse_expires(d.get("expiresAt"))
        cap = now + self.cfg.override_max_min * 60
        until = cap if until is None else min(until, cap)
        if until <= now:
            self.override = None  # e.g. an expired retained message after a restart
            print("[controller] ignored expired override")
            return
        self.override = {"fan": None if fan is None else int(clamp(fan, 0, 100)),
                         "window": None if win is None else int(clamp(win, 0, 100)),
                         "until": until}
        print("[controller] override set: %s" % self.override)

    # ---- slow data ----
    def refresh_slow_data(self, now):
        if now - self.events_at > 300:
            self.events_at = now
            ev = load_events(self.cfg, now)
            if ev is not None:
                self.events = ev
        if now - self.weather_at > 600:
            self.weather_at = now
            w = fetch_weather(self.cfg)
            if w is not None:
                self.weather = w
        if self.weather and now - self.weather["fetched"] > 1800:
            self.weather = None  # cached value too old to trust

    # ---- context message ----
    def build_context(self, now):
        ctx = {}
        active, soon, nxt = calendar_status(self.events, now, self.cfg.prevent_min)
        ev = active or nxt
        if active or soon:
            ctx["booked"] = (active or soon)["people"]
        if ev:
            ctx["nextEvent"] = {"title": ev["title"],
                                "start": datetime.fromtimestamp(ev["start"]).astimezone().isoformat(timespec="seconds"),
                                "people": ev["people"]}
        w = self.weather
        if w:
            if w.get("rain_prob") is not None:
                ctx["rainChance"] = int(round(w["rain_prob"]))
            if w.get("outdoor_temp") is not None:
                ctx["outdoorTemp"] = round(w["outdoor_temp"], 1)
        return ctx  # fields we don't have are omitted so the server keeps their last value

    # ---- the decision ----
    def decide(self, now):
        cfg = self.cfg
        with self.lock:
            occ, occ_status, sensors = self.occ, self.occ_status, self.sensors
            trend = pressure_trend_hpa_per_h(list(self.pressure_hist))
            override = self.override
            if override and override["until"] <= now:
                self.override = override = None

        # occupancy: only trust fresh, real, online data
        people_live = None
        if occ is not None and occ_status in (None, "online") and now - occ["ts"] <= cfg.stale_s \
                and (occ["source"] != "fake" or cfg.allow_fake):
            people_live = occ["people"]

        aq = None
        if sensors is not None and now - sensors["_recv"] <= cfg.stale_s:
            aq = sensors.get("aq")

        active, soon, _ = calendar_status(self.events, now, cfg.prevent_min)
        prevent = soon is not None and active is None
        people = people_live
        if people is None and active is not None:
            people = active["people"]  # camera down but the room is booked
        noshow = (active is not None and people_live is not None and active["people"] >= 4
                  and people_live <= cfg.noshow_ratio * active["people"])

        nothing_known = people_live is None and aq is None and active is None and not prevent
        s = {"now": now, "people_live": people_live, "aq": aq, "prevent": prevent, "soon": soon,
             "active": active, "noshow": noshow, "nothing_known": nothing_known}

        wanted, allowed, closed_reason = 0, True, ""
        if nothing_known:
            window = self.smoother.window_step(0, False, now)
            fan = self.fan_target = cfg.fallback_fan
            self.smoother.fan = fan
        else:
            p = people if people is not None else 0
            occupied = people is None or p > 0 or prevent  # unknown occupancy: assume occupied
            frac = aq_fraction(aq, cfg.aq_good, cfg.aq_poor)
            wanted = window_target_pct(cfg, aq, occupied)
            allowed, closed_reason = window_allowed(cfg, self.weather, trend)
            window = self.smoother.window_step(wanted, allowed, now)
            booked = soon["people"] if prevent else None
            self.fan_target = fan_pct(cfg, needed_cfm(cfg, p, frac, prevent, booked), window, occupied)
            fan = self.smoother.fan_step(self.fan_target, now)

        mode = "auto"
        if override:
            mode = "manual"
            if override["fan"] is not None:
                fan = override["fan"]
            if override["window"] is not None:
                window = override["window"]
            reason = "Manual override from the dashboard. Fan held at %d%%, window %s." % (
                fan, "closed" if window == 0 else "open %d%%" % window)
        else:
            reason = "%s %s" % (cause_sentence(cfg, s), action_sentence(fan, window, wanted, allowed, closed_reason))

        return {"fan": int(fan), "window": int(window), "reason": reason, "mode": mode}


# --------------------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------------------
def self_test():
    cfg = parse_args([])  # built-in defaults: 900 sqft, capacity 30, stuffy 800, poor 1200
    assert max_cfm(cfg) == 10 * 30 + 0.12 * 900 == 408

    # fan %: 8 people, air at the stuffy limit, window closed -> 188/408 = 46% -> 45
    assert fan_pct(cfg, needed_cfm(cfg, 8, 0.0, False, None), 0, True) == 45
    # air at "poor": x1.6 -> 73.7% -> 75; with the window 70% open the fan drops to 55
    n = needed_cfm(cfg, 8, 1.0, False, None)
    assert fan_pct(cfg, n, 0, True) == 75 and fan_pct(cfg, n, 70, True) == 55
    # empty room is clamped to 15%; occupied floor is 20%
    assert fan_pct(cfg, needed_cfm(cfg, 0, 0.0, False, None), 0, False) == 15
    assert fan_pct(cfg, 0, 0, True) == 20
    # pre-ventilation: empty room, 24 booked -> 60% of booked load (208.8 cfm) -> 50%
    assert fan_pct(cfg, needed_cfm(cfg, 0, 0.0, True, 24), 0, True) == 50

    # window targets
    assert window_target_pct(cfg, 500, True) == 0
    assert window_target_pct(cfg, 750, True) == 40
    assert window_target_pct(cfg, 1200, True) == 70
    assert window_target_pct(cfg, 1200, False) == 0 and window_target_pct(cfg, None, True) == 0

    # window permission
    ok_w = {"ok": True, "rain_in_min": None, "rain_prob": 10}
    assert window_allowed(cfg, ok_w, 0.2)[0]
    assert window_allowed(cfg, None, 0.0) == (False, "weather data is unavailable")
    assert window_allowed(cfg, {"ok": True, "rain_in_min": 20, "rain_prob": 0}, 0.0)[1] == "rain is expected in 20 min"
    assert window_allowed(cfg, {"ok": True, "rain_in_min": None, "rain_prob": 70}, 0.0)[1] == "rain is likely (70%)"
    assert window_allowed(cfg, ok_w, -2.0)[1] == "pressure is falling fast"

    # pressure trend
    s = [(i * 60.0, 1013.0 - 3.0 * (i * 60.0) / 3600.0) for i in range(61)]
    tr = pressure_trend_hpa_per_h(s)
    assert tr is not None and abs(tr + 3.0) < 0.05 and pressure_trend_hpa_per_h(s[:5]) is None

    # smoother
    sm = Smoother(cfg)
    assert [sm.fan_step(65, t) for t in (0, 5, 10)] == [25, 50, 65]
    assert sm.fan_step(20, 20) == 65 and sm.fan_step(20, 85) == 55
    assert sm.window_step(40, True, 100) == 40 and sm.window_step(40, False, 101) == 0

    # override parsing: ISO "Z", cap, auto, null = keep automatic, expired retained message
    c = Controller(cfg)
    now = 1_000_000.0
    iso = datetime.fromtimestamp(now + 1800, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    c._set_override({"mode": "manual", "fan": 80, "window": None, "expiresAt": iso}, now)
    assert c.override["fan"] == 80 and c.override["window"] is None and abs(c.override["until"] - (now + 1800)) < 1
    c._set_override({"mode": "manual", "fan": 150, "window": 0, "expiresAt": now + 99999}, now)
    assert c.override["fan"] == 100 and c.override["until"] == now + cfg.override_max_min * 60
    c._set_override({"mode": "auto"}, now)
    assert c.override is None
    c._set_override({"mode": "manual", "fan": 50, "window": 0, "expiresAt": now - 5}, now)
    assert c.override is None

    def fresh(**kw):
        k = Controller(cfg)
        k.weather = kw.get("weather", {"ok": True, "rain_in_min": None, "rain_prob": 10, "fetched": time.time()})
        k.events = kw.get("events")
        t = time.time()
        if "aq" in kw:
            k.on_message(k.base + "/sensors", json.dumps({"aq": kw["aq"], "temp": 21, "pressure": 1012}).encode())
        if "people" in kw:
            k.on_message(k.base + "/occupancy", json.dumps(
                {"people": kw["people"], "ts": t - kw.get("age", 0), "source": kw.get("source", "camera")}).encode())
        if "status" in kw:
            k.on_message(k.base + "/occupancy_status", kw["status"].encode())
        return k, t

    # nothing known -> safe default fan, window closed
    k, t = fresh()
    cmd = k.decide(t)
    assert cmd["fan"] == 50 and cmd["window"] == 0 and "safe default" in cmd["reason"], cmd

    # stale / fake / camera_error occupancy is not trusted
    for kw, text in [({"age": 300}, "counter is offline"), ({"source": "fake"}, "counter is offline"),
                     ({"status": "camera_error"}, "counter is offline")]:
        k, t = fresh(aq=500, people=9, **kw)
        assert text in k.decide(t)["reason"], kw

    # stuffy room, rain likely -> window stays closed, and the reason says why
    k, t = fresh(aq=950, people=8, weather={"ok": True, "rain_in_min": None, "rain_prob": 70, "fetched": time.time()})
    cmd = k.decide(t)
    assert cmd["window"] == 0 and cmd["mode"] == "auto"
    assert cmd["reason"].startswith("8 people here and the air is getting stuffy at 950 ppm.")
    assert "window kept closed because rain is likely (70%)" in cmd["reason"], cmd["reason"]

    # same room, dry -> window opens 40%
    k, t = fresh(aq=950, people=8)
    cmd = k.decide(t)
    assert cmd["window"] == 40 and "window open 40% while it's dry outside" in cmd["reason"], cmd

    # pre-ventilation from the calendar
    ev = [{"title": "Physics lecture", "start": time.time() + 360, "end": time.time() + 3960, "people": 24}]
    k, t = fresh(aq=500, people=0, events=ev)
    k.events[0]["start"] = t + 360
    cmd = k.decide(t)
    assert "starts in 6 min with 24 booked, so the room is being aired out ahead of time." in cmd["reason"]
    assert k.fan_target == 50, k.fan_target

    # no-show: booked for 20, only 4 came
    ev = [{"title": "Physics lecture", "start": time.time() - 600, "end": time.time() + 3000, "people": 20}]
    k, t = fresh(aq=900, people=4, events=ev)
    cmd = k.decide(t)
    assert "was booked for 20 but only 4 came" in cmd["reason"] and k.fan_target == 30, (cmd, k.fan_target)

    # camera down during a booked event: use the booking, and say so
    ev = [{"title": "Lab", "start": time.time() - 600, "end": time.time() + 3000, "people": 10}]
    k, t = fresh(aq=500, status="camera_error", events=ev)
    assert "booking (10 people) is being used" in k.decide(t)["reason"]

    # manual override beats everything and is explained
    k, t = fresh(aq=950, people=8)
    k.on_message(k.base + "/override", json.dumps(
        {"mode": "manual", "fan": 85, "window": 0, "expiresAt": datetime.fromtimestamp(t + 900, tz=timezone.utc).isoformat()}).encode())
    cmd = k.decide(t)
    assert cmd["mode"] == "manual" and cmd["fan"] == 85 and cmd["reason"].startswith("Manual override"), cmd

    # context message omits what it doesn't have
    k, t = fresh()
    k.weather = None
    assert k.build_context(t) == {}
    k, t = fresh(events=[{"title": "Lab", "start": time.time() + 3600, "end": time.time() + 7200, "people": 12}])
    ctx = k.build_context(t)
    assert ctx["nextEvent"]["people"] == 12 and "T" in ctx["nextEvent"]["start"] and "rainChance" in ctx
    print("self-test OK")


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------
def main():
    cfg = parse_args()
    if cfg.self_test:
        self_test()
        return
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    ctl = Controller(cfg)
    base = ctl.base
    status_topic = base + "/controller_status"

    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    else:
        client = mqtt.Client(client_id="%s-controller" % cfg.room)

    def on_connect(c, userdata, flags, rc, properties=None):
        print("[controller] MQTT connected to %s:%d" % (cfg.broker, cfg.port))
        for t in ("occupancy", "occupancy_status", "sensors", "override"):  # re-subscribe on reconnect
            c.subscribe("%s/%s" % (base, t), qos=1)
        c.publish(status_topic, "online", qos=1, retain=True)

    client.on_connect = on_connect
    client.on_message = lambda c, u, msg: ctl.on_message(msg.topic, msg.payload)
    client.will_set(status_topic, "offline", qos=1, retain=True)
    client.connect_async(cfg.broker, cfg.port, keepalive=30)
    client.loop_start()

    print("[controller] %s: %.0f sqft, capacity %.0f, max %.0f cfm, air %s/%s %s (Ctrl+C to stop)" % (
        cfg.room, cfg.area_sqft, cfg.capacity, max_cfm(cfg), cfg.aq_good, cfg.aq_poor, cfg.aq_unit))
    last_hb = last_decide = last_ctx = 0.0
    while running:
        now = time.time()
        # Heartbeat is sent from this same loop on purpose: if the loop hangs it stops,
        # and the UNO Q closes the window and runs the fan at 50% after ~10 s of silence.
        if now - last_hb >= 2.0:
            client.publish(base + "/heartbeat", json.dumps({"t": int(now)}), qos=0)
            last_hb = now
        if ctl.force or now - last_decide >= cfg.interval:
            ctl.force = False
            last_decide = now
            try:
                ctl.refresh_slow_data(now)
                cmd = ctl.decide(now)
                client.publish(base + "/cmd", json.dumps(cmd), qos=0, retain=False)
                print("[controller] fan=%d window=%d mode=%s | %s" % (cmd["fan"], cmd["window"], cmd["mode"], cmd["reason"]))
            except Exception as exc:
                print("[controller] decision error: %s" % exc)
        if now - last_ctx >= cfg.context_interval:
            last_ctx = now
            try:
                ctx = ctl.build_context(now)
                if ctx:
                    client.publish(base + "/context", json.dumps(ctx), qos=0)
            except Exception as exc:
                print("[controller] context error: %s" % exc)
        time.sleep(0.25)

    print("[controller] shutting down")
    try:
        client.publish(status_topic, "offline", qos=1, retain=True).wait_for_publish(timeout=1)
    except Exception:
        pass
    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
