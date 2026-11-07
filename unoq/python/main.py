# Nimbus sensors: Linux side of the UNO Q app.
#
# Receives one sample per second from the sketch (gas reading, pressure, temperature),
# turns the Grove Air Quality v1.3 reading into the "gas level" the Nimbus server
# expects, and publishes room1/sensors over MQTT every 2 s:
#
#   {"aq": 12, "aqRaw": 287.4, "pressure": 1012.63, "temp": 21.4}
#
# Gas level (master doc, section 8.1):
#   1. smooth: average of the last 10 s
#   2. warm up: no "aq" for the first 3 minutes while the heater settles
#   3. baseline: the lowest smoothed value since the app started (only moves down),
#      so START THE APP IN FRESH AIR. Restart the app to take a new baseline.
#   4. aq = smoothed - baseline (never below 0). 50 = getting stuffy, 150 = needs air.
#
# The UNO Q must be on the same hotspot as the laptop running the Nimbus server.

import json
import threading
import time
from collections import deque

import paho.mqtt.client as mqtt
from arduino.app_utils import App, Bridge

# ---- settings -------------------------------------------------------------------------
BROKER = "192.168.1.50"  # <-- the LAPTOP's IP on the hotspot (Mac: ipconfig getifaddr en0)
PORT = 1883
ROOM = "room1"
PREFIX = ""              # set if the server uses MQTT_PREFIX, e.g. "nimbus/"
WARMUP_S = 180           # seconds before the gas reading is trusted
SMOOTH_S = 10            # seconds of gas readings to average
PUBLISH_S = 2            # how often to publish room1/sensors
STALE_S = 5              # stop publishing if the sketch goes quiet this long
# ----------------------------------------------------------------------------------------

TOPIC = "%s%s/sensors" % (PREFIX, ROOM)
lock = threading.Lock()
samples = deque()  # (monotonic time, gas reading)
latest = {"t": None, "pressure": None, "temp": None, "baro": False}
started = time.monotonic()
baseline = None
last_log = 0.0


def nimbus_sample(gas, pressure, temp, baro_ok):
    """Called by the sketch once a second via Bridge.notify."""
    now = time.monotonic()
    with lock:
        samples.append((now, float(gas)))
        while samples and now - samples[0][0] > SMOOTH_S:
            samples.popleft()
        latest["t"] = now
        latest["baro"] = bool(baro_ok)
        latest["pressure"] = float(pressure) if pressure and pressure > 0 else None
        latest["temp"] = float(temp) if temp is not None and temp > -100 else None


Bridge.provide("nimbus_sample", nimbus_sample)


def on_connect(client, *_):
    print("[nimbus] MQTT connected to %s:%d, publishing %s" % (BROKER, PORT, TOPIC))


client_id = "%s-unoq-%04x" % (ROOM, int(time.time() * 1000) & 0xFFFF)
if hasattr(mqtt, "CallbackAPIVersion"):  # paho-mqtt 2.x
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
else:  # paho-mqtt 1.x
    client = mqtt.Client(client_id=client_id)
client.on_connect = on_connect
client.connect_async(BROKER, PORT, keepalive=30)  # keeps retrying in the background
client.loop_start()
print("[nimbus] connecting to %s:%d (edit BROKER at the top of main.py if this never connects)" % (BROKER, PORT))


def loop():
    global baseline, last_log
    time.sleep(PUBLISH_S)
    now = time.monotonic()
    with lock:
        fresh = latest["t"] is not None and now - latest["t"] <= STALE_S
        gas = [g for t, g in samples if now - t <= SMOOTH_S]
        pressure, temp, baro = latest["pressure"], latest["temp"], latest["baro"]

    if not fresh or not gas:
        if now - last_log >= 10:
            last_log = now
            print("[nimbus] no samples from the sketch yet (is the sketch running?)")
        return

    smoothed = sum(gas) / len(gas)
    msg = {}
    if pressure is not None:
        msg["pressure"] = round(pressure, 2)
    if temp is not None:
        msg["temp"] = round(temp, 2)

    warming = now - started < WARMUP_S
    if not warming:
        baseline = smoothed if baseline is None else min(baseline, smoothed)
        msg["aq"] = max(0, int(round(smoothed - baseline)))
        msg["aqRaw"] = round(smoothed, 1)

    if client.is_connected():
        client.publish(TOPIC, json.dumps(msg))

    if now - last_log >= 10:
        last_log = now
        gas_text = ("warming up, %d s left" % (WARMUP_S - (now - started))) if warming else (
            "gas level %d (raw %.1f, baseline %.1f)" % (msg["aq"], smoothed, baseline))
        if baro and pressure is not None:
            baro_text = "%.2f hPa, %s" % (pressure, ("%.1f C" % temp) if temp is not None else "no temp")
        else:
            baro_text = "barometer not found"
        mqtt_text = "MQTT ok" if client.is_connected() else "MQTT NOT CONNECTED"
        print("[nimbus] raw %.1f | %s | %s | %s" % (smoothed, gas_text, baro_text, mqtt_text))


App.run(user_loop=loop)
