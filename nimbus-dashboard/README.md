# Nimbus dashboard

Live web dashboard and MongoDB data layer for occupancy-aware ventilation.
It listens to the room devices over MQTT, stores everything in MongoDB, and
shows each room's people count, air quality, fan, window, charts, and the
controller's reason for every decision. You can hold the fan and window
manually from any phone or laptop.

```
UNO Q (sensors) ─┐
Pi camera count ─┼─ MQTT ─► this server ─► MongoDB Atlas
Pi 4 controller ─┘   ▲          │
        ▲            │          └─► dashboard in the browser (live)
        └── override ┘
```

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
| `room1/cmd` | Pi 4 controller | `{"fan": 65, "window": 40, "reason": "8 people and CO₂ rising. Fan at 65%, window open 40%.", "mode": "auto"}` |
| `room1/context` | Pi 4 controller | `{"booked": 24, "rainChance": 70, "outdoorTemp": 8, "nextEvent": {"title": "Physics lecture", "start": "2026-11-07T15:00:00-05:00", "people": 24}}` |
| `room1/override` | **this server** (retained) | `{"mode": "manual", "fan": 80, "window": 0, "expiresAt": "2026-11-07T19:15:00.000Z"}` or `{"mode": "auto"}` |

Notes for the team:

- Temperatures are in °C. The dashboard converts to °F (`temperatureUnit` in `config/rooms.json`).
- `window` in `sensors` is the measured position; `window` in `cmd` is the commanded one.
- The `reason` sentence becomes the big headline on the room page. Write it for a person reading from across the room.
- The controller should subscribe to `room1/override` and obey it until `expiresAt`. A `null` fan or window means "keep deciding that one automatically". The server also sends `{"mode": "auto"}` when a hold expires.
- Field aliases are accepted: `co2` or `air` for `aq`, `temperature` for `temp`, `count` for `people`, `fanRpm` for `rpm`.

### Minimal Python publisher for the Pi 4 controller

```python
import json
import paho.mqtt.client as mqtt

client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)  # paho-mqtt 2.x
client.connect("127.0.0.1", 1883)  # Mosquitto on the Pi 4
client.loop_start()

def publish_decision(fan, window, reason):
    client.publish("room1/cmd", json.dumps({"fan": fan, "window": window, "reason": reason, "mode": "auto"}))

def on_override(client, userdata, msg):
    override = json.loads(msg.payload)
    print("dashboard override:", override)  # hold fan/window until override["expiresAt"]

client.subscribe("room1/override")
client.on_message = on_override
```

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
  thresholds. Defaults are CO₂ in ppm (800 and 1200). If your sensor gives a
  different scale, change these so the colors and charts make sense.
- `temperatureUnit`: `"F"` or `"C"` for display.
- `staleAfterSeconds`: when a device counts as offline.

`.env`: see `.env.example` for every option.

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
| GET | `/api/status` | Database and MQTT connection state |

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
  mqtt.js         MQTT subscribe and override publish
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
