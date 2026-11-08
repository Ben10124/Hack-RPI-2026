# Nimbus dashboard

Live web dashboard and MongoDB data layer for occupancy-aware ventilation.
It listens to the room devices over MQTT, decides the fan speed and window
opening for each real room, stores everything in MongoDB, and shows each
room's people count, air quality, fan, window, charts, and the reason for
every decision. You can hold the fan and window manually from any phone or
laptop.

```
UNO Q (sensors) ────┐                    ┌─► MongoDB Atlas
Pi 4 camera count ──┼─ MQTT ─► this server (controller)
                    │            │       └─► dashboard in the browser (live)
Pi 4 fan + servo ◄──┘ room1/cmd + room1/heartbeat
```

The control rules live in `server/rules.js`. The real-room controller
(`server/controller.js`) and the simulator both use them, so they always agree.

## Quick start (no hardware, no database)

Needs Node.js 20 or newer.

```bash
npm install
npm run demo
```

Open http://localhost:3000. Three simulated rooms appear, with people
arriving for booked events, CO₂ building up and the fan reacting. Simulated
rooms are labeled "Simulated" in the dashboard.

## Connect MongoDB Atlas

1. Create a free cluster at https://cloud.mongodb.com (the free M0 tier is enough).
2. **Database Access**: add a database user with a password.
3. **Network Access**: add your current IP. On venue Wi-Fi your IP can change,
   so for the hackathon you can allow `0.0.0.0/0` and remove it afterwards.
4. **Connect → Drivers**: copy the connection string.
5. Copy `.env.example` to `.env` and paste it in:

```
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/
MONGODB_DB=nimbus
```

Restart the server. The footer of the dashboard shows
**Data: MongoDB, time series collection** when it is connected. If the
connection fails, the server prints why and keeps running in memory.

### What gets stored

| Collection | What's in it |
|---|---|
| `rooms` | One document per room: the live state the dashboard shows |
| `readings` | A snapshot of every room every 10 s. Created as a MongoDB **time series collection**; old readings expire after 7 days |
| `decisions` | Every real change the controller made (fan, window, mode) with its reason |
| `overrides` | Every manual hold set, cleared or expired from the dashboard |

The "Last 24 hours" panel is computed with an aggregation pipeline over `readings`.

## Connect the devices

Point the server at the Pi 4's Mosquitto broker:

```
MQTT_URL=mqtt://192.168.1.50:1883
```

Or skip Mosquitto and let this server be the broker (devices then publish to
this computer's IP on port 1883):

```
EMBEDDED_BROKER=1
```

Put the Pi 4, the UNO Q and the computer running this server on the same
network. A phone hotspot is the most reliable choice, because venue Wi-Fi
often blocks devices from talking to each other.

### Real room plus simulated rooms

To show a whole building with only one real room:

```
SIMULATE=room2,room3
```

## MQTT messages

All payloads are JSON. `room1` is the room id from `config/rooms.json`
(add `MQTT_PREFIX=nimbus/` to make topics `nimbus/room1/...`).

| Topic | Sent by | Example payload |
|---|---|---|
| `room1/sensors` | UNO Q | `{"temp": 21.4, "pressure": 1012.6, "aq": 840, "rpm": 1450, "window": 40}` |
| `room1/occupancy` | Pi 4 camera counter | `{"people": 7}` (a bare `7` also works) |
| `room1/cmd` | **this server**, every 5 s | `{"fan": 65, "window": 40, "reason": "8 people here and the air is getting stuffy (CO₂ 950 ppm). Fan at 65%, window open 40% while it's dry outside.", "mode": "auto"}` |
| `room1/heartbeat` | **this server**, every 2 s | `{"t": 1794081813}` |
| `room1/actuators` | Pi 4 fan + servo driver | `{"fan": 40, "window": 40, "failsafe": false}`: what it actually applied |
| `room1/override` | **this server** (retained) | `{"mode": "manual", "fan": 80, "window": 0, "expiresAt": "2026-11-07T19:15:00.000Z"}` or `{"mode": "auto"}`. Informational: `cmd` already includes the override |

Notes for the team:

- Temperatures are in °C. The dashboard converts to °F (`temperatureUnit` in `config/rooms.json`).
- `window` in `sensors` is the measured position; `window` in `cmd` is the commanded one.
- The `reason` sentence becomes the big headline on the room page. Write it for a person reading from across the room.
- The device that drives the fan and servo subscribes to `room1/cmd` and applies `fan` and `window`. **It must close the window and run the fan at 50% on its own if it hears no `cmd` or `heartbeat` for 10 s.**
- When neither the air sensors nor the camera have reported for 30 s, the server itself commands window closed, fan 50%.
- Overrides from the dashboard are already applied in `cmd`. A `null` fan or window in a hold means "keep deciding that one automatically".
- The server ignores `room1/cmd` and `room1/context` from anyone else while it controls `room1`, so two controllers never fight. Set `CONTROL=none` to hand control to an external controller instead.
- Field aliases are accepted: `co2` or `air` for `aq`, `temperature` for `temp`, `count` for `people`, `fanRpm` for `rpm`.

### Device scripts

- **UNO Q:** `unoq/` is an Arduino App Lab app (sketch + Python). Set `BROKER` in `unoq/python/main.py` to this laptop's IP, start it in fresh air, and wait 3 minutes for the gas sensor to warm up.
- **Pi 4 fan + window:** `pi4/actuators.py --broker <laptop-ip> --fan-pin 18 --servo-pin 13`. Run it with `--test` first to calibrate the window (0% must be closed). It reports what it applied on `room1/actuators`, shown under Devices as "Fan + window".
- **Pi 4 people counter:** `people_counter/people_counter.py --broker <laptop-ip>`.

### Test the MQTT path without hardware

With the server running and a broker available:

```bash
npm run fake-devices -- --url mqtt://127.0.0.1:1883 --rooms room1
```

This publishes realistic messages for `room1` exactly as the devices would,
and obeys overrides from the dashboard.

## Configuration

`config/rooms.json`

- `rooms`: id, display name, floor area (sq ft) and seat count for each room.
- `airQuality`: label, unit and the "getting stuffy" and "needs air"
  thresholds. Set for our **Grove Air Quality Sensor v1.3**: "Gas level", no
  unit, 50 and 150, where the device publishes `aq` as its smoothed 10-bit
  reading minus the fresh-air baseline (see the master doc, section 8.1). It is
  a relative gas sensor, not CO₂. For a true CO₂ sensor use "CO₂", "ppm", 800
  and 1200. Simulated rooms follow whichever scale is set.
- `temperatureUnit`: `"F"` or `"C"` for display.
- `staleAfterSeconds`: when a device counts as offline.

- `bookings` (optional, per room): `[{"title": "Physics lecture", "start": "15:00", "minutes": 50, "people": 24}]`.
  `start` is a time today (`HH:MM`), a full ISO date, or `+N` (N minutes after the server starts; room1 ships with a demo booking at `+8`). Used for pre-ventilation and no-show detection.

`.env`: see `.env.example` for every option, including `CONTROL`,
`WEATHER_LAT` / `WEATHER_LON` (default: RPI) and `FORCE_RAIN`.

### 3D model room (when the fan and servo aren't connected)

Open **http://localhost:3000/model3d.html#room1**, or click **3D model room**
next to a room's name on its dashboard page. It's a live 3D model of the room
that plays the part of the fan and the window servo:

- It follows the same live decisions the Pi would receive (`room1/cmd`).
- The top-hinged window swings outward at servo speed, and the exhaust fan
  spins up and down with some inertia.
- Inside: one figure per person counted, airflow particles drifting from the
  window to the fan (faster with more airflow), and a haze that thickens as the
  gas level rises. Outside: a cloud, with rain when rain is likely.
- Fail-safe, like the real device: if decisions stop for 10 s, the window
  closes and the fan runs at 50%. Stop the server to show it; the page keeps
  running.
- Drag to look around, scroll or pinch to zoom. It slowly turns on its own until
  you touch it (not if the system asks for reduced motion).
- The page says "Simulated fan and window", so it's never mistaken for the
  hardware. Any room id works after the `#`, including simulated rooms.

A flat 2D version is at `/model.html#room1` (linked from the 3D page), for
devices without WebGL.

three.js (r187, MIT license) is served from `public/vendor/three/`, so the 3D
page works without internet, like the rest of the dashboard.

### Demo setting: pretend rain is coming

The room page's "Outside and schedule" panel has two buttons.
**Pretend rain is coming** forces the rain chance to 80% for every room, so the
window closes and the reason says why. **Pretend it's dry** forces 0%, so the
window can open on a rainy day. Press the active one again to go back to the
real forecast. The dashboard labels the value "(demo setting)" while either is
on. You can also start with `FORCE_RAIN=80` (or `0`).

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/rooms` | All rooms with live state |
| GET | `/api/rooms/:id` | One room |
| GET | `/api/rooms/:id/history?minutes=60` | Readings for charts (averaged to at most 180 points) |
| GET | `/api/rooms/:id/decisions?limit=20` | Controller changes, newest first |
| GET | `/api/rooms/:id/summary?hours=24` | Peak people, average air quality, minutes needing air |
| POST | `/api/rooms/:id/override` | Body `{"fan": 80, "window": 0, "minutes": 15}` |
| DELETE | `/api/rooms/:id/override` | Return to automatic |
| GET | `/api/status` | Database and MQTT connection state, controlled rooms, demo rain setting |
| POST | `/api/weather/rain` | Demo setting: body `{"chance": 80}` forces the rain chance |
| DELETE | `/api/weather/rain` | Back to the real forecast |

Live updates reach the browser over Socket.IO (`room`, `reading`, `decision`, `status` events).

## Running on the Raspberry Pi 4

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install
npm start
```

Then open `http://<pi-ip>:3000` from any device on the same network. Charts
and fonts are served from the Pi itself, so the dashboard works even when
the internet drops (MongoDB writes resume when it comes back).

## Project layout

```
server/
  index.js        web server, API, Socket.IO, startup
  hub.js          live room state, decisions, overrides, snapshots
  rules.js        control rules (fan, window, reason), shared by controller and simulator
  controller.js   decides fan + window for real rooms, publishes cmd + heartbeat
  weather.js      Open-Meteo rain chance and the demo rain setting
  mqtt.js         MQTT subscribe, cmd/heartbeat/override publish
  sim-engine.js   simulated rooms (also used by tools/fake-devices.js)
  store/          MongoDB store and in-memory fallback
public/           the dashboard (HTML, CSS, JS)
config/rooms.json rooms and thresholds
tools/fake-devices.js
```

## Troubleshooting

- **"could not connect to MongoDB"**: check the password in `MONGODB_URI` and that your IP is in Atlas Network Access.
- **Port 1883 already in use**: Mosquitto is already running. Set `EMBEDDED_BROKER=0` and `MQTT_URL=mqtt://127.0.0.1:1883`.
- **Room shows Offline**: no message for 30 s. Check the device is on the same network and publishing to the right room id.
- **Nothing in the charts**: readings are stored every 10 s, so the first points appear after a few seconds of data.
