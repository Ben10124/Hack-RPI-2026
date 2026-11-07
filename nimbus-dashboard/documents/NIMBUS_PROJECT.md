# Nimbus: Occupancy-Aware Ventilation

Master project document. Theme: **"In the clouds."**
Team of 4. Build window: 6 hours on day 1 (≈2:40–8:35 PM), 3 hours on day 2 (8:00–11:00).

| | |
|---|---|
| **Status** | In build. Server, database layer and dashboard done; UNO Q, people counter and controller in progress |
| **Last updated** | Saturday, November 7, 2026 |
| **Document owner** | TDS (lead) |
| **Source of truth for** | Message formats (section 9), control rules (section 10), safety rules (section 11). If code and this document disagree, fix one of them and note it in section 25. |

---

## Contents

1. [Summary](#1-summary)
2. [Problem](#2-problem)
3. [Solution](#3-solution)
4. [How it fits the theme and judging criteria](#4-how-it-fits-the-theme-and-judging-criteria)
5. [System architecture](#5-system-architecture)
6. [Hardware](#6-hardware)
7. [Wiring](#7-wiring)
8. [Software components and languages](#8-software-components-and-languages)
9. [Network and MQTT message contract](#9-network-and-mqtt-message-contract)
10. [Control logic](#10-control-logic)
11. [Safety and fail-safes](#11-safety-and-fail-safes)
12. [Database (MongoDB)](#12-database-mongodb)
13. [Dashboard and server](#13-dashboard-and-server)
14. [Configuration and environment](#14-configuration-and-environment)
15. [Repository structure](#15-repository-structure)
16. [Setup and run instructions](#16-setup-and-run-instructions)
17. [Team roles and schedule](#17-team-roles-and-schedule)
18. [Testing and checkpoints](#18-testing-and-checkpoints)
19. [Demo plan](#19-demo-plan)
20. [Risks and cut list](#20-risks-and-cut-list)
21. [Privacy and ethics](#21-privacy-and-ethics)
22. [Future implications and roadmap](#22-future-implications-and-roadmap)
23. [Open questions](#23-open-questions)
24. [Submission checklist](#24-submission-checklist)
25. [Decision log](#25-decision-log)
26. [Troubleshooting](#26-troubleshooting)
27. [Glossary](#27-glossary)

---

## 1. Summary

**One-liner:** Nimbus watches how many people are in a room and how stale the air is, then runs the fan and opens or closes the window on its own, closing it before rain arrives, and explains every decision on a live dashboard.

**Core idea:** Ventilation should follow people, not a fixed schedule. A camera counts occupants (privately, on the device), sensors measure the air, a controller decides fan speed and window position, and everything streams to a cloud database and a live web dashboard.

**Name:** "Nimbus" (a rain cloud) is the working name. Alternatives considered: "Silver Lining," "SkyVent." Change `siteName` in `config/rooms.json` if the team picks another.

**Tagline for the close of the pitch:** "Ventilation that follows people, reads the clouds, and explains itself."

---

## 2. Problem

- Classrooms, dorms and meeting rooms fill up fast and the air goes stale. Elevated indoor CO₂ has been linked in studies to lower concentration and decision-making.
- Most rooms have no sensors at all. Ventilation either runs on a fixed schedule (wasting energy on empty rooms) or doesn't run enough (when a room is packed).
- Opening a window helps, but brings new problems: rain gets in, smoke or haze drifts in, and heat escapes in cold weather.
- Booked rooms often go unused (no-shows), but systems still ventilate them as if they were full.

**Who has the problem:** students and teachers in classrooms, people in dorms and meeting rooms, building managers paying for energy, and anyone during wildfire-smoke season.

---

## 3. Solution

Nimbus combines four inputs to decide two outputs, and shows its reasoning.

| Inputs | Outputs |
|---|---|
| People count (camera, on-device AI) | Fan speed (0–100%) |
| Air quality (air quality sensor) | Window opening (0–100%) |
| Pressure trend + temperature (barometer) | A plain-language reason for each decision |
| Calendar bookings + weather forecast | Live dashboard + stored history |

**Key behaviors**

- **Demand-controlled ventilation:** airflow scales with the number of people, using the ASHRAE 62.1 classroom rate.
- **Pre-ventilation:** starts airing out a room about 10 minutes before a booked event.
- **No-show detection:** if a room booked for 30 has only 6 people, it trusts the camera and scales down to save energy.
- **Weather-aware window:** opens the window when it's dry; keeps it closed and uses the fan when rain is likely or pressure is falling.
- **Explainable:** every decision comes with a sentence such as "8 people here and CO₂ rising. Fan at 65%, window kept closed because rain is likely."
- **Manual override:** anyone can hold the fan and window from their phone for 15–60 minutes; it expires automatically.

---

## 4. How it fits the theme and judging criteria

**Theme ("In the clouds"), three connections to state in the pitch:**

1. **Breath clouds:** exhaled breath is an invisible cloud of CO₂ and aerosols. Nimbus measures and clears it.
2. **Weather clouds:** rain clouds (via barometric pressure trend and forecast) decide whether the window opens.
3. **The cloud:** all data streams to MongoDB Atlas and a live web dashboard.

| Criterion | How Nimbus scores |
|---|---|
| Theme adherence | Three distinct meanings of "cloud," all doing real work |
| Effort | Four coordinated subsystems: firmware, computer vision, control logic, full-stack web + cloud database |
| Technical difficulty | On-device people detection, sensor fusion, physics-based airflow model, closed-loop control, MQTT messaging, time series database, live web updates |
| Creativity | Calendar + camera + weather combined; explains its own decisions in plain language |
| Practicality and utility | Cheap hardware, a real everyday problem, saves energy on empty rooms, improves air in full ones |

---

## 5. System architecture

```
                         ┌─────────────────────────── Cloud ───────────────────────────┐
                         │  MongoDB Atlas (rooms, readings, decisions, overrides)       │
                         │  Open-Meteo weather API      Room calendar (iCal / Google)   │
                         └───────────────▲──────────────────────────▲───────────────────┘
                                         │ writes/reads              │ HTTPS
┌──────────── Laptop (or Pi 4) ──────────┴───────┐        ┌─────────┴──────── Raspberry Pi 4 ───────────┐
│ Node.js server                                  │        │ Camera → people counter (Python, YOLO nano) │
│  • built-in MQTT broker (port 1883)             │◄──────►│ Controller (Python): decides fan + window   │
│  • REST API + Socket.IO (port 3000)             │  MQTT  │   publishes room1/cmd, room1/context        │
│  • serves the dashboard                         │        │   listens on room1/override                 │
└───────────────▲─────────────────────────────────┘        └─────────────────────────────────────────────┘
                │ MQTT over Wi-Fi (phone hotspot)
┌───────────────┴──────────── Arduino UNO Q ─────────────────────────┐
│ Linux side (Python): Bridge ↔ MQTT, publishes room1/sensors         │
│ MCU side (C++ sketch): reads sensors, drives fan + servo, safety    │
└───────▲───────────────────────────────▲─────────────────────────────┘
        │ I2C / analog                  │ PWM
  Barometer, air quality, temp     Fan (with RPM readback), window servo

Browser (phone / laptop / projector) ◄── live updates ── Node.js server
```

**Design principles**

- **Split by responsibility:** the UNO Q microcontroller does real-time control and safety; the Pi 4 does vision and decisions; the server does storage and display.
- **Safety stays local:** the microcontroller closes the window on its own if it stops hearing from the controller. Losing Wi-Fi or the cloud never leaves the window stuck open.
- **Edge first, cloud second:** decisions happen on the local network. The cloud stores history and serves the dashboard, but isn't required for the room to keep working.
- **Privacy by design:** camera frames never leave the Pi 4; only a number (people count) is sent.

---

## 6. Hardware

### 6.1 Boards

| Device | Role | Key facts |
|---|---|---|
| **Arduino UNO Q** | Sensors, actuators, safety | Two processors: Qualcomm Dragonwing QRB2210 running Debian Linux, plus STM32U585 microcontroller running Arduino sketches (Zephyr). They talk through Arduino's Bridge (RPC). Header pins use **3.3 V logic** (most digital pins tolerate 5 V; A0 and A1 do not). Qwiic connector is I2C at 3.3 V (`Wire1`). Built-in Wi-Fi and Bluetooth (on the Linux side; a sketch reaches the network only through the Bridge). 8×13 LED matrix driven from the sketch. Power: USB-C 5 V up to 3 A, or VIN 7–24 V. Default PWM frequency 500 Hz. |
| **Raspberry Pi 4** | Camera people counter + controller | Camera Module on the CSI ribbon port. Runs Python. |
| **Raspberry Pi 3B** | Optional | Second room node or a kiosk screen for the dashboard. Wi-Fi is 2.4 GHz only. |
| **Laptop** | Server, broker, dashboard host | Runs Node.js 20+. |
| **Battery** | Portable power | Not enough to run both boards plus a fan. Use wall power for the boards during the demo. |

### 6.2 Sensors

| Sensor | Measures | Interface | Notes |
|---|---|---|---|
| **Grove Barometer SPA06-003** | Air pressure 300–1100 hPa (±0.3 hPa absolute, about ±0.03 hPa relative); temperature −40 to 85 °C (±1 °C) | I2C, address **0x77** (default) | No humidity, no air quality. Don't touch or shake it while running. Power at 3.3 V. |
| **Air quality sensor** | **Model to confirm** (see table below) | I2C or analog | Determines units, thresholds and what we can claim. |
| **Temperature sensor** | **Model to confirm** | Analog or I2C | Optional if the barometer's temperature is enough. |
| **Pi Camera** | Visible-light images (not thermal) | CSI | Only used to count people. |

**Likely air quality sensor models and what each means for us**

| Model | Measures | What to call it |
|---|---|---|
| Grove Air Quality v1.3 | Analog voltage rising with a mix of gases (CO, alcohol, acetone, formaldehyde). No ppm. Not CO₂. | "Air quality" (relative) |
| SGP30 | TVOC 0–60,000 ppb, estimated CO₂ 400–60,000 ppm (calculated, not measured) | "Estimated CO₂" |
| SCD30 | True CO₂ 400–10,000 ppm (±30 ppm + 3%), plus temperature and humidity | "CO₂" |
| SCD40 | True CO₂ 400–2,000 ppm (±50 ppm + 5%), plus temperature and humidity | "CO₂" |
| HM3301 | PM1.0 / PM2.5 / PM10 particles in µg/m³ | "Particles / smoke" |

Gas sensors need several minutes to warm up. Record a fresh-air baseline at startup.

### 6.3 Actuators and parts list

| Part | Purpose | Notes |
|---|---|---|
| 4-pin PC fan (12 V) | Ventilation | PWM speed control + tach wire for real RPM. 4-pin fans expect ~25 kHz PWM; the UNO Q defaults to 500 Hz, so raise the frequency or switch a simpler fan with a MOSFET. |
| 12 V supply for the fan | Power | Grounds tied together with the UNO Q. |
| Servo (MG996R or SG90) | Opens the window flap | MG996R for acrylic, SG90 for foam board. |
| 5 V supply for the servo | Power | **Never** power an MG996R from the board's 5 V pin; the voltage dip resets the board. |
| Grove-to-jumper cable | Barometer to header pins | The Grove plug doesn't fit the Qwiic port. A Grove-to-Qwiic cable also works. |
| Optional: limit or reed switch | Confirms window is closed | |
| Optional: INA219 current sensor | Detects a blocked window (pinch protection) | Better than ACS712 at small currents. |
| Optional: rain-drop sensor board | Local rain detection on the sill | Forces window closed. |
| Foam board / cardboard, hinge tape, hot glue, breadboard, jumper wires | Model room | |

### 6.4 Model room

- Shoebox-sized box = the "room." Small volume makes CO₂ respond within seconds when someone breathes into it.
- Rectangular opening on one side with a **top-hinged** flap (like a real awning window, which sheds rain).
- Servo inside near the hinge, connected to the flap with a stiff wire pushrod. 0° = closed, ~70–90° = fully open.
- Fan mounted in a second opening as the exhaust.
- Demo "cloud": breath, a kettle, or a small ultrasonic humidifier. For gas sensors, a hand-sanitizer wipe causes a reliable spike.

---

## 7. Wiring

All sensor logic at **3.3 V**. Connect every ground together (UNO Q, fan supply, servo supply).

| Connection | UNO Q pin | Notes |
|---|---|---|
| Barometer SDA / SCL | Header SDA / SCL (`Wire`) or Qwiic (`Wire1`) | Grove colors: black GND, red VCC (3.3 V), white SDA, yellow SCL |
| Air quality sensor | I2C bus, or A2–A5 if analog | Power analog sensors at 3.3 V so the signal stays in range |
| Temperature sensor | I2C bus or analog pin | |
| Fan PWM | D9 | PWM-capable (~) pin |
| Fan tach (RPM) | D2 | Interrupt input, pull-up to 3.3 V |
| Window servo signal | D10 | PWM-capable pin; servo powered from its own 5 V supply |
| Optional closed switch | D3 | `INPUT_PULLUP` |
| Optional rain sensor | A3 | |
| Pi 4 ↔ UNO Q | Wi-Fi (MQTT) | Same hotspot |

I2C addresses don't collide: barometer 0x77, SGP30 0x58, SCD30 0x61, SCD40 0x62, INA219 0x40.

---

## 8. Software components and languages

| Component | Runs on | Language | Main libraries | Job |
|---|---|---|---|---|
| UNO Q sketch | STM32U585 (Zephyr) | C++ (Arduino) | Wire, Servo, Bridge | Read sensors every 1–2 s, drive fan PWM, read RPM, move servo, safety watchdog, LED matrix status |
| UNO Q bridge | QRB2210 (Debian) | Python | Bridge, `paho-mqtt` | Pass readings to MQTT (`room1/sensors`) and commands from MQTT (`room1/cmd`) to the sketch |
| People counter | Pi 4 | Python | Picamera2, Ultralytics YOLO (nano) or TFLite, OpenCV | Count people every ~2 s; publish `room1/occupancy`; never store frames |
| Controller | Pi 4 | Python | `paho-mqtt`, `requests`, `icalendar`, SQLite (optional) | Decide fan % and window %; publish `room1/cmd` + `room1/context`; obey `room1/override` |
| Server | Laptop (or Pi 4) | JavaScript (Node.js 20+) | Express, Socket.IO, `mqtt`, `mongodb` driver 6.x, Aedes (built-in broker) | MQTT ingest, MongoDB storage, REST API, live updates, override publishing, simulation |
| Dashboard | Browser | HTML, CSS, JavaScript | Chart.js, Socket.IO client; fonts Bricolage Grotesque + Atkinson Hyperlegible (served locally) | Overview, room detail, charts, override controls, decision log |
| Database | MongoDB Atlas | — | Time series collection, aggregation pipeline | Live state, history, decisions, overrides |
| Weather | Open-Meteo API | HTTP/JSON | — | Rain probability for window decisions |
| Calendar | iCal feed or Google Calendar API | — | `icalendar` | Bookings for pre-ventilation and no-show detection |

### 8.1 Component specs

**UNO Q sketch (C++)**
- Read sensors every 1–2 s and pass them to the Linux side through the Bridge.
- Accept `set_fan(percent)` and `set_window(percent)` from the Linux side; clamp to 0–100.
- Fan: PWM on D9; count tach pulses on D2 (most PC fans give 2 pulses per revolution) and report RPM.
- Window: servo on D10, mapping 0% → closed angle and 100% → fully open angle (calibrate on the model).
- Safety watchdog: if no command or heartbeat arrives for 10 s, close the window and set the fan to 50% (section 11).
- LED matrix: show the room status at a glance (for example a check for fresh air, an exclamation mark for needs air, a slash when the controller is lost).
- If the window has no position feedback, report the last commanded position as `window` in `sensors`.

**UNO Q bridge (Python, Linux side)**
- Build the sketch and this script together as one Arduino App Lab app.
- Publish `room1/sensors` every 1–2 s.
- Subscribe to `room1/cmd` (apply fan and window) and `room1/heartbeat` (reset the watchdog).
- Reconnect to the broker automatically; never let a network error stop the sketch.

**People counter (Python, Pi 4)**
- Camera at a low resolution (for example 640×480) for speed.
- Person detection with a small model (YOLO nano; exporting it to NCNN or TFLite speeds it up on the Pi). Count only the "person" class above a confidence threshold of about 0.5.
- Smooth the count: publish the median of the last 3–5 frames so one bad frame doesn't make the fan jump.
- Publish `room1/occupancy` every ~2 s. Never save, display remotely or transmit frames.

**Controller (Python, Pi 4)**
- Subscribe to `room1/sensors`, `room1/occupancy` and `room1/override`.
- Every ~5 s: run the rules in section 10 and publish `room1/cmd` with a reason sentence.
- Every 2 s: publish `room1/heartbeat`.
- Every 15–30 s: publish `room1/context` (bookings, rain chance, outdoor temperature, next event).
- Weather: fetch rain probability from Open-Meteo about every 10 minutes, for example `https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&hourly=precipitation_probability,temperature_2m&forecast_days=1`, and use the value for the current hour. Cache the last good value if the request fails.
- Calendar: read the room's iCal feed (or one hardcoded event for the demo) every few minutes.
- Override: obey a `manual` override until `expiresAt`, then resume automatic. A `null` fan or window value means keep deciding that one automatically.

---

## 9. Network and MQTT message contract

### 9.1 Network

- **One phone hotspot** for all devices. Venue Wi-Fi often blocks device-to-device traffic. On iPhone, turn on **Maximize Compatibility** (2.4 GHz) for the Pi 3B.
- **Broker:** the server's built-in broker on the laptop (`EMBEDDED_BROKER=1`), port 1883, no login. Devices connect to the **laptop's IP**. Recheck the IP whenever the laptop reconnects.
- Alternative: Mosquitto on the Pi 4, with `MQTT_URL=mqtt://<pi-ip>:1883` on the server.

### 9.2 Topics

Room id = `room1` (from `config/rooms.json`). Optional prefix via `MQTT_PREFIX`. All payloads are JSON.

| Topic | Publisher | Subscriber | Payload |
|---|---|---|---|
| `room1/sensors` | UNO Q | Server, controller | `{"temp": 21.4, "pressure": 1012.6, "aq": 840, "rpm": 1450, "window": 40}` |
| `room1/occupancy` | People counter | Server, controller | `{"people": 7}` (bare `7` also accepted) |
| `room1/cmd` | Controller | UNO Q, server | `{"fan": 65, "window": 40, "reason": "8 people and CO₂ rising. Fan at 65%, window open 40%.", "mode": "auto"}` |
| `room1/context` | Controller | Server | `{"booked": 24, "rainChance": 70, "outdoorTemp": 8, "nextEvent": {"title": "Physics lecture", "start": "2026-11-07T15:00:00-05:00", "people": 24}}` |
| `room1/override` | Server (retained) | Controller | `{"mode": "manual", "fan": 80, "window": 0, "expiresAt": "2026-11-07T19:15:00.000Z"}` or `{"mode": "auto"}` |
| `room1/heartbeat` | Controller (every 2 s) | UNO Q | `{"t": 1730999999}` (any payload) |

### 9.3 Field rules

- Temperatures in **°C** (the dashboard converts to °F). Pressure in **hPa**. Air quality (`aq`) in the unit set in `config/rooms.json`.
- `sensors` also accepts `humidity` (percent) if a humidity sensor is added.
- Send only the fields you have. Missing fields keep their last value.
- Percentages 0–100, rounded to integers.
- `window` in `sensors` = measured/actual position; `window` in `cmd` = commanded position.
- `reason` = one or two plain sentences, written for someone reading from across the room. It becomes the dashboard headline.
- In an override, `null` for fan or window means "keep deciding that one automatically."
- Accepted aliases: `co2`/`air`/`airQuality` → `aq`; `temperature` → `temp`; `count` → `people`; `fanRpm`/`fan_rpm` → `rpm`; `windowPct` → `window`.
- Unknown fields are ignored. A message with no recognized fields is logged once as a warning in the server terminal.

### 9.4 Publish rates and offline detection

| Topic | Rate |
|---|---|
| `room1/sensors` | Every 1–2 s |
| `room1/occupancy` | Every ~2 s |
| `room1/cmd` | Every ~5 s, and immediately after a change |
| `room1/context` | Every 15–30 s |
| `room1/heartbeat` | Every 2 s |
| `room1/override` | Only when a hold is set, cleared or expires (retained, QoS 1) |

The dashboard marks a device **Offline** after `staleAfterSeconds` (default 30 s) without a message from it. "Air sensors" tracks `sensors`, "People counter" tracks `occupancy`, "Controller" tracks `cmd` and `context`.

---

## 10. Control logic

Runs on the Pi 4 controller every ~5 seconds. The server's simulator implements the same rules, so it doubles as a reference implementation (`server/sim-engine.js`).

### 10.1 Base airflow (ASHRAE 62.1, classroom)

```
needed_cfm = 10 cfm × people + 0.12 cfm × floor_area_sqft
max_cfm    = 10 × capacity + 0.12 × floor_area_sqft
```

### 10.2 Adjustments, in order

1. **Pre-ventilation:** if an event starts within 10 minutes and more people are booked than present, raise `needed_cfm` to 60% of the booked load.
2. **Air quality feedback:** above the "stuffy" threshold, multiply `needed_cfm` by up to 1.6 as air approaches the "needs air" threshold.
3. **Window decision:** open only if rain chance < 50%, pressure isn't falling fast, the room is occupied, and air is near or above the stuffy threshold. 40% when stuffy, 70% when poor.
4. **Fan speed:** `fan % = (needed_cfm − window_cfm) / max_cfm × 100`, clamped to 20–100% when occupied and 0–15% when empty.
5. **Manual override wins** until it expires.
6. **Publish** `cmd` with a reason sentence.

### 10.3 Room air model (for prediction and the "physics" talking point)

```
dC/dt = (G × people − Q × (C − C_outdoor)) / V
```

- `C` = indoor CO₂, `C_outdoor` ≈ 420 ppm
- `G` ≈ 0.011 cfm of CO₂ per seated adult
- `Q` = total airflow (fan + window + infiltration), `V` = room volume

Uses: predict when CO₂ will cross a threshold and ventilate early; measure the room's actual air-change rate from the CO₂ decay when the window opens; estimate occupancy from the CO₂ rise rate as a cross-check on the camera.

### 10.4 Pressure trend

The server fits a least-squares line to the last hour of pressure readings and reports **hPa per hour**. "Steady" within ±0.15 hPa/h. A steady fall signals worsening weather. It needs at least 3 minutes of readings before it shows a value.

### 10.5 Reason sentences

The reason is the dashboard headline, so keep the wording consistent. One sentence for the cause, one for the action. Examples the simulator already uses:

- "Physics lecture starts in 6 min with 24 booked, so the room is being aired out ahead of time. Fan at 55%, window closed."
- "Physics lecture was booked for 20 but only 4 came, so ventilation is scaled down to save energy. Fan at 30%, window open 40% while it's dry outside."
- "8 people here and the air is getting stuffy at 950 ppm. Fan at 72%, window kept closed because rain is likely (70%)."
- "Room is empty and the air is fresh at 520 ppm. Fan at 10%, window closed."
- "Manual override from the dashboard. Fan held at 85%, window closed."

The decision log ignores numbers when comparing reasons, so a changing count doesn't create a new log entry; only a change in the kind of reason does.

---

## 11. Safety and fail-safes

The UNO Q microcontroller owns safety and does not depend on the Pi, Wi-Fi or the cloud.

| Condition | Response |
|---|---|
| No heartbeat or command from the controller for 10 s | Close window, run fan at a medium default |
| Rain sensor wet (if fitted) | Close window immediately |
| Servo current spikes while moving (if INA219 fitted) | Stop, back off (pinch protection) |
| Closed switch doesn't trigger within a few seconds of a close command | Report a fault |
| Corrupted or invalid command | Ignore; keep last safe state |
| Dashboard override expires | Server publishes `{"mode": "auto"}`; controller resumes |

**Failure demo for judges:** unplug the Wi-Fi or stop the Pi, then show the window closing safely on its own.

---

## 12. Database (MongoDB)

Connected through `MONGODB_URI` (Atlas). Falls back to an in-memory store if not set or unreachable.

| Collection | Contents | Indexes / type |
|---|---|---|
| `rooms` | One document per room (`_id` = room id): live state shown on the dashboard | — |
| `readings` | Snapshot of each room every `READING_INTERVAL_SECONDS` (default 10 s): people, aq, temp, pressure, fanPct, fanRpm, windowPct | **Time series collection** (timeField `ts`, metaField `room`, granularity seconds), expires after 7 days; index `{room: 1, ts: 1}`. Regular collection + TTL index on servers without time series support |
| `decisions` | Each real change of plan: fan, window, reason, mode, people, aq | `{room: 1, ts: -1}` |
| `overrides` | Each manual hold set, cleared or expired | `{room: 1, ts: -1}` |

**Room document fields:** `id, name, areaSqft, capacity, simulated, people, booked, aq, temp, humidity, pressure, pressureTrend, fanPct, fanRpm, windowPct, windowCmd, reason, mode, rainChance, outdoorTemp, nextEvent{title,start,people}, override{fan,window,setAt,expiresAt,by}, lastSeen{sensors,camera,controller}, updatedAt`

**Write budget:** room documents are saved at most once per second per room; readings every 10 s (≈8,640 per room per day). Well within the Atlas free tier for a demo.

**Aggregation:** the "Last 24 hours" panel uses one pipeline (`$match` → `$group` with `$max`, `$avg`, `$sum`/`$cond`) to compute peak people, average air quality and minutes above the "needs air" threshold.

**Decision logging rule:** log when the reason's wording changes (numbers ignored), the mode changes, the window moves ≥ 5%, or the fan moves ≥ 10% (at most every 20 s). Prevents log spam.

---

## 13. Dashboard and server

### 13.1 Dashboard (browser)

- **Overview:** one-sentence building summary ("23 people across 3 rooms. Room 204 needs air.") and a row per room with status (icon + label), people, air quality, fan, window, reason, and Manual/Simulated tags.
- **Room page:**
  - Reason headline (the memorable element)
  - Readings strip: people (with booked), air quality, temperature (+ outdoor), pressure (+ trend), fan (+ measured RPM), window (+ mode)
  - Charts: people, fan speed, air quality (with "stuffy" and "needs air" threshold lines), pressure, for 15 min / 1 h / 6 h / 24 h, plus a table view
  - Manual control: fan and window sliders, hold for 15/30/60 min, return to automatic
  - Outside and schedule: rain chance, pressure trend, outdoor temperature, now/next booking
  - Devices: last seen for air sensors, people counter and controller
  - Last 24 hours: stats from the aggregation pipeline
  - Decision log: what the controller changed and why
- **Status levels:** Fresh air / Getting stuffy / Needs air / Offline / Waiting for data. Always icon + label, never color alone.
- **Footer:** shows the data store (MongoDB, time series), MQTT state and which rooms are simulated.
- Light and dark mode, phone to projector, keyboard accessible, reduced motion respected. Charts and fonts are served locally, so it works on flaky Wi-Fi.

### 13.2 Server REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Site name, air quality label/unit/thresholds, temperature unit |
| GET | `/api/status` | Store type, time series on/off, MQTT state, simulated rooms |
| GET | `/api/rooms` | All rooms |
| GET | `/api/rooms/:id` | One room |
| GET | `/api/rooms/:id/history?minutes=60` | Readings, averaged to ≤ 180 points |
| GET | `/api/rooms/:id/decisions?limit=20` | Decision log, newest first |
| GET | `/api/rooms/:id/summary?hours=24` | Aggregated stats |
| POST | `/api/rooms/:id/override` | `{"fan": 80, "window": 0, "minutes": 15}` |
| DELETE | `/api/rooms/:id/override` | Return to automatic |

**Socket.IO events:** `room` (live state), `reading` (new chart point), `decision` (new log entry), `status` (connection state).

### 13.3 Design system

| Token | Light | Dark |
|---|---|---|
| Page | `#e6ecf1` (overcast fog) | `#0e1724` (night sky) |
| Panel | `#f7f9fb` | `#142133` |
| Text | `#15263b` | `#e6edf4` |
| Secondary text | `#44556a` | `#b0bdcc` |
| Chart line | `#2a78d6` | `#3987e5` |
| Status: good / warning / bad | `#0ca30c` / `#c98500` / `#d03b3b` | `#0ca30c` / `#fab219` / `#d03b3b` |

- **Display type:** Bricolage Grotesque (headlines, room names, big numbers).
- **Interface type:** Atkinson Hyperlegible (built for legibility at a distance).
- **The one bold element:** the reason headline on each room page. Everything else stays quiet.
- Charts: one series each, 2 px lines, no dual axes, threshold lines labeled, crosshair tooltip, table view available.

### 13.4 Simulation

- Simulated rooms run realistic scenarios: bookings that start every few minutes, people arriving and leaving, some no-shows, CO₂ following the room air model, a weather front that occasionally lowers pressure and raises rain chance, and a controller using the rules in section 10.
- `npm run demo`: all rooms simulated, built-in broker, no database needed.
- `SIMULATE=room2,room3`: real room1 + simulated others (labeled "Simulated" on screen).
- `npm run fake-devices -- --url mqtt://<ip>:1883 --rooms room1`: publishes realistic messages over MQTT exactly like the devices, and obeys overrides. Used to test the full MQTT path without hardware.

---

## 14. Configuration and environment

### `config/rooms.json`

```json
{
  "siteName": "Nimbus",
  "buildingName": "Demo building",
  "airQuality": { "label": "CO₂", "unit": "ppm", "good": 800, "poor": 1200 },
  "temperatureUnit": "F",
  "staleAfterSeconds": 30,
  "rooms": [
    { "id": "room1", "name": "Room 101", "areaSqft": 900, "capacity": 30 },
    { "id": "room2", "name": "Room 204", "areaSqft": 600, "capacity": 20 },
    { "id": "room3", "name": "Study lounge", "areaSqft": 400, "capacity": 12 }
  ]
}
```

Change `airQuality` once the sensor model is known.

### `.env`

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Web server port |
| `MONGODB_URI` | empty | Atlas connection string; empty = in-memory |
| `MONGODB_DB` | nimbus | Database name |
| `MQTT_URL` | empty | External broker, e.g. `mqtt://192.168.1.50:1883` |
| `MQTT_PREFIX` | empty | Topic prefix, e.g. `nimbus/` |
| `EMBEDDED_BROKER` | 0 | 1 = run a broker inside the server |
| `EMBEDDED_BROKER_PORT` | 1883 | Broker port |
| `SIMULATE` | empty | `all`, or a comma list of room ids |
| `READING_INTERVAL_SECONDS` | 10 | Snapshot frequency |
| `SIM_SPEED` | 6 | Simulation time multiplier |

---

## 15. Repository structure

```
nimbus/
├── nimbus-dashboard/           Server + dashboard (delivered)
│   ├── server/
│   │   ├── index.js            Express, API, Socket.IO, startup, built-in broker
│   │   ├── hub.js              Live room state, decisions, overrides, snapshots, pressure trend
│   │   ├── mqtt.js             MQTT subscribe + override publish
│   │   ├── sim-engine.js       Simulated rooms (reference control logic)
│   │   ├── config.js           Environment + rooms.json loading
│   │   └── store/              MongoDB store + in-memory fallback
│   ├── public/                 Dashboard (index.html, styles.css, app.js)
│   ├── config/rooms.json
│   ├── tools/fake-devices.js
│   ├── .env.example
│   └── README.md
├── unoq/                       To build
│   ├── sketch/sketch.ino       C++: sensors, fan, servo, safety
│   └── python/main.py          Bridge ↔ MQTT
├── pi4/                        To build
│   ├── people_counter.py
│   └── controller.py
└── docs/
    └── NIMBUS_PROJECT.md       This file
```

---

## 16. Setup and run instructions

### Server (laptop)

Requires **Node.js 20 or newer** (the built-in broker needs it; the rest runs on 18+).

```bash
cd nimbus-dashboard
npm install
# create .env:
#   PORT=3000
#   EMBEDDED_BROKER=1
#   SIMULATE=room2,room3
#   MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/
#   MONGODB_DB=nimbus
npm start
```

- Allow Node through the firewall; mark the hotspot as a Private network on Windows.
- Keep the laptop awake (`caffeinate -d` on Mac).
- Find the IP: Mac `ipconfig getifaddr en0`, Windows `ipconfig`, Linux `hostname -I`.
- Open `http://<laptop-ip>:3000` on any device on the hotspot.

### MongoDB Atlas

1. Create a free cluster.
2. Database Access: add a user (letters and numbers only in the password).
3. Network Access: allow `0.0.0.0/0` for the hackathon; remove afterwards.
4. Connect → Drivers: copy the connection string into `.env`.
5. Restart; footer should read "MongoDB, time series collection."

### Quick connectivity test from the Pi 4

```bash
sudo apt install -y mosquitto-clients
mosquitto_pub -h <laptop-ip> -t room1/sensors -m '{"temp":21.5,"pressure":1012.8,"aq":600}'
mosquitto_pub -h <laptop-ip> -t room1/occupancy -m '{"people":3}'
```

### Node.js on a Raspberry Pi (if the server runs there)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Minimal Python MQTT client (paho-mqtt 2.x)

```python
import json
import paho.mqtt.client as mqtt

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.connect("<laptop-ip>", 1883)
client.loop_start()
client.publish("room1/cmd", json.dumps({"fan": 65, "window": 40, "reason": "8 people and CO₂ rising.", "mode": "auto"}))
```

---

## 17. Team roles and schedule

| Person | Owns |
|---|---|
| Lead (TDS) | Server, Atlas, dashboard, integration checks, pitch |
| Firmware | UNO Q sketch, wiring, Bridge ↔ MQTT, safety |
| Vision | Pi 4 people counter, then backup video and submission writeup |
| Controller + MQTT | Pi 4 controller, calendar, weather, override handling |

### Day 1 (≈2:40–8:35 PM)

| Time | Goal |
|---|---|
| 2:40–3:00 | Setup: hotspot, server running, IP shared, test message visible |
| 3:00–4:30 | Build in parallel. ✅ 3:45 first real reading on dashboard. ✅ 4:30 real sensors + people count |
| 4:30–6:00 | Fan + servo wired, controller v1, Atlas connected. ✅ 6:00 full loop: breathe → fan → headline; phone override works |
| 6:00–7:30 | Calendar pre-ventilation, weather window logic, fail-safe, `SIMULATE=room2,room3` |
| 7:30–8:30 | Fix bugs, push to GitHub, photograph wiring, log known issues, leave running overnight if allowed |

### Overnight (optional, no hardware)

Pitch outline and architecture slide (Lead); submission writeup draft (Vision).

### Day 2 (8:00–11:00)

| Time | Goal |
|---|---|
| 8:00–8:20 | Reassemble, recheck laptop IP, confirm data flow |
| 8:20–9:15 | Stretch: occupancy patterns from overnight data. Drop if not done by 9:15 |
| 9:15 | 🔒 Code freeze |
| 9:15–10:40 | Backup video, rehearse pitch twice, finish writeup, tidy cables |
| 10:40 | Submit (20 min buffer) |

---

## 18. Testing and checkpoints

| Test | How | Pass when |
|---|---|---|
| Server + broker | `npm run fake-devices` against the laptop | Room 101 updates within seconds |
| Device → dashboard | `mosquitto_pub` from the Pi | Values appear in Room 101 |
| Sensors | UNO Q publishing | Temp, pressure, air quality live; "Air sensors" device shows recent |
| People counter | Walk in/out of view | Count changes within ~2–4 s |
| Controller | Breathe into the box | Air quality rises, fan rises, reason updates, decision logged |
| Override | Hold from a phone | Fan/window obey; "Manual" tag shows; expires on time |
| Fail-safe | Kill the Pi controller or Wi-Fi | Window closes within ~10 s |
| Database | Atlas Browse Collections | `readings` growing; footer says time series |
| Persistence | Restart the server | Room state and charts come back |

---

## 19. Demo plan

**Setup on the table:** model room with window and fan, laptop showing the room page on a large screen, a phone for the override, the architecture slide.

**Script (~3 minutes)**

1. **Problem (20 s):** stale air in packed rooms, wasted ventilation in empty ones, windows that let in rain.
2. **What it is (20 s):** point at the overview headline and the live rooms.
3. **Live loop (60 s):** two people lean into camera view and breathe into the box. People count rises, air quality climbs, fan speeds up, the headline explains why.
4. **Weather (20 s):** show the rain chance and pressure trend keeping the window closed.
5. **Override (20 s):** hold the fan from a phone; show it obey and the Manual tag.
6. **Safety (20 s):** unplug the Wi-Fi; window closes by itself.
7. **Cloud + data (20 s):** Atlas collections, time series history, decision log, overnight chart.
8. **Close (10 s):** "Ventilation that follows people, reads the clouds, and explains itself."

**Backup:** a recorded video of the full loop in case the network fails at judging.

**Expected judge questions**

- *Privacy?* Frames never leave the Pi; only a count is sent.
- *Accuracy?* Show the sensor's spec and what you call the reading (true CO₂ vs relative air quality).
- *Scale?* One server handles many rooms; each room is a small node; MQTT + MongoDB scale horizontally.
- *Energy savings?* Empty or no-show rooms drop to minimal ventilation instead of a fixed schedule.
- *What if the internet drops?* Decisions are local; the cloud is only for history and remote viewing.

---

## 20. Risks and cut list

| Risk | Mitigation |
|---|---|
| No fan or servo available | Ask the hardware table early; fall back to fan-only or an LED "fan" |
| Venue Wi-Fi blocks devices | Phone hotspot |
| Laptop IP changes | Recheck after any reconnect; repost in team chat |
| Servo resets the board | Separate 5 V supply, shared ground |
| Air quality sensor is not true CO₂ | Label it honestly; set thresholds to its scale |
| Integration happens too late | First real reading on the dashboard by 3:45 |
| Atlas connection fails | Server falls back to memory automatically; fix the IP allowlist |

**Cut in this order if behind:** pattern learning → calendar → weather API → fan RPM readback → window servo.
**Never cut:** real sensors, people count, fan control, live dashboard on Atlas.

---

## 21. Privacy and ethics

- **No images stored or transmitted.** The camera's only output is an integer.
- **No identification.** The model detects "person," not who.
- **Point the camera at the room, never at private spaces** (bathrooms, changing areas).
- **Honest labeling:** simulated rooms are marked "Simulated"; estimated readings are called estimates.
- **Manual control stays with people:** any override from the dashboard beats the automation, and the system always explains what it's doing.

---

## 22. Future implications and roadmap

### Near term (weeks)

- Replace the model room with a real window actuator (12 V linear actuator, as used on skylights and greenhouse vents) and limit switches.
- Real HVAC integration: drive a fresh-air damper or fan coil through a relay or BACnet/Modbus gateway.
- Per-room setup screen in the dashboard instead of editing JSON.
- Authentication for the override controls (only room owners and facilities staff).
- Alerts (push, email, Slack) when a room needs air or a device goes offline.

### Medium term (months)

- **Learned occupancy patterns:** forecast each room's occupancy by hour and weekday from stored history; pre-ventilate even without a calendar.
- **Model-predictive control:** use the room air model to choose fan and window settings that minimize energy while keeping CO₂ under target.
- **Measured air-change rate:** estimate each room's real ventilation from CO₂ decay and flag rooms that under-ventilate.
- **Outdoor air quality:** add a PM2.5 sensor or air quality API so the window never opens into wildfire smoke.
- **Humidity and mold prevention** with a temperature + humidity sensor.
- **Fleet management:** many rooms per building, many buildings per campus, with building-level dashboards.

### Long term and broader impact

- **Energy:** ventilation that follows real occupancy can avoid conditioning outdoor air for empty rooms. Demand-controlled ventilation is an established energy-saving strategy in commercial buildings; Nimbus makes it affordable for rooms that have no sensors today.
- **Health and learning:** better-ventilated classrooms support concentration and can reduce the spread of airborne illness. Aggregated, anonymized data could show schools which rooms chronically need attention.
- **Space utilization:** no-show detection tells building managers which booked rooms go unused, freeing them for others.
- **Equity:** low-cost hardware can bring ventilation monitoring to older schools and dorms that lack modern building management systems.
- **Climate resilience:** weather and smoke awareness matter more as extreme weather and wildfire seasons increase.
- **Policy:** building ventilation standards could be verified with real measurements instead of design assumptions.

### Commercial path

- Retrofit kit (sensor node + actuator + subscription dashboard) for schools, universities, coworking spaces and offices.
- Integration with existing building management systems instead of replacing them.
- Data products: occupancy and air quality reports for facilities teams.

### Risks to watch at scale

- Camera-based counting raises privacy expectations; consider privacy-preserving alternatives (thermal or radar presence sensors, CO₂-based occupancy estimation).
- Sensor drift: gas and CO₂ sensors need periodic calibration.
- Security: MQTT needs authentication and TLS outside a hackathon; overrides need access control.

---

## 23. Open questions

- [ ] Air quality sensor model (sets units, thresholds and claims)
- [ ] Temperature sensor model (or use the barometer's temperature)
- [ ] Fan type available (4-pin PWM vs 2/3-pin + MOSFET)
- [ ] Servo model and power supply
- [ ] Can hardware stay powered overnight?
- [ ] Calendar source (real room iCal feed, Google Calendar, or a hardcoded event)
- [ ] Final product name and room names for the pitch
- [ ] Room floor area and seat count to use for the model room (affects the airflow formula)
- [ ] Venue location for the weather request (latitude and longitude)
- [ ] Judging format: table demo, stage pitch, or both, and the time limit

---

## 24. Submission checklist

- [ ] Code pushed to GitHub with a README (link the repo in the submission)
- [ ] This document in the repo at `docs/NIMBUS_PROJECT.md`
- [ ] Project writeup: problem, solution, how it works, theme fit, what's next
- [ ] Architecture slide (section 5 diagram, cleaned up)
- [ ] Backup demo video of the full loop (1–2 min)
- [ ] Screenshots: overview, room page, Atlas collections
- [ ] Team names and roles listed
- [ ] Atlas `0.0.0.0/0` network rule noted for removal after the event
- [ ] Hardware photo of the model room

---

## 25. Decision log

| Decision | Why | Alternative considered |
|---|---|---|
| Occupancy-aware ventilation as the project | Practical, uses every board, strong double meaning of "cloud" | Sky-camera rain nowcaster, solar shadow predictor, drone go/no-go station, plane spotter, focus coach |
| Pi 4 = vision + controller; UNO Q = sensors, actuators, safety | Real-time and safety on the microcontroller; heavy computation on the Pi | Everything on one board |
| MQTT for device messages | Lightweight, standard for IoT, many-to-many | HTTP polling, direct serial |
| Built-in broker in the Node server | No Mosquitto install; one less thing to break | Mosquitto on the Pi 4 (still supported via `MQTT_URL`) |
| MongoDB Atlas for storage | Team preference; time series collections and aggregation pipelines | Firebase Firestore |
| Node.js server between MQTT and the database | One place for ingest, storage, live updates and overrides | Pi writing to the cloud directly |
| Charts and fonts served locally | Dashboard works on flaky venue Wi-Fi | CDNs |
| Phone hotspot | Venue Wi-Fi often blocks devices from talking to each other | Venue Wi-Fi |
| Simulated rooms labeled "Simulated" | Honest demo of a whole building with one real room | Hiding the simulation |
| Camera counts only, no frames stored | Privacy | Storing images for debugging |

Add a row whenever the team changes a decision.

---

## 26. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard won't load on a phone | Firewall or different networks | Allow Node through the firewall; mark the hotspot Private (Windows); check both devices are on the hotspot |
| Device messages don't show up | Wrong IP, topic or JSON | Recheck the laptop IP; check the topic is `room1/...`; check the server terminal for "ignored message" warnings |
| "could not connect to MongoDB" | Password, user or IP allowlist | Recheck `MONGODB_URI`; use a letters-and-numbers password; allow `0.0.0.0/0` in Atlas Network Access |
| Port 1883 already in use | Mosquitto is running | Set `EMBEDDED_BROKER=0` and `MQTT_URL=mqtt://127.0.0.1:1883` |
| A room shows Offline | No message for 30 s | Check that device's power, Wi-Fi and room id |
| UNO Q resets when the servo moves | Servo powered from the board | Give the servo its own 5 V supply with a shared ground |
| Fan ignores speed or whines | PWM frequency too low for a 4-pin fan | Raise the PWM frequency, or switch a simple fan through a MOSFET |
| Barometer readings jump | Sensor touched or vibrating | Mount it firmly away from the fan |
| Pi 3B can't see the hotspot | 2.4 GHz only | Turn on Maximize Compatibility (iPhone) |
| Charts empty | No readings yet in the selected range | Wait for a few readings (every 10 s); pick a shorter range |
| Pressure trend says "Measuring trend…" | Less than 3 minutes of data | Wait |

---

## 27. Glossary

| Term | Meaning |
|---|---|
| ASHRAE 62.1 | The US standard for minimum ventilation in commercial buildings and schools |
| cfm | Cubic feet per minute of airflow |
| Demand-controlled ventilation | Adjusting ventilation to actual occupancy instead of a fixed schedule |
| hPa | Hectopascal, unit of air pressure (1013 hPa ≈ sea-level average) |
| I2C | Two-wire bus (SDA, SCL) for connecting sensors |
| MQTT | Lightweight publish/subscribe messaging protocol for IoT devices |
| PWM | Pulse-width modulation, used to set fan speed and servo position |
| Retained message | An MQTT message the broker keeps and delivers to new subscribers |
| Tach | Fan wire that pulses with each rotation, used to measure RPM |
| Time series collection | MongoDB collection type optimized for timestamped measurements |
| ppm | Parts per million (CO₂ concentration) |
