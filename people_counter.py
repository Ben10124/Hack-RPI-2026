#!/usr/bin/env python3
"""
people_counter.py - counts people with a webcam and publishes the count over MQTT.

Privacy: frames live only in memory and are never written to disk or sent anywhere.
Only the integer count leaves this script.

Install (inside a venv on the Pi 4, 64-bit Raspberry Pi OS):
    pip install ultralytics opencv-python-headless "paho-mqtt>=1.6"
(On a laptop where you want --show, use opencv-python instead of the headless build.)

Run:
    python people_counter.py                     # publishes to localhost, topic room1/occupancy
    python people_counter.py --fake-camera       # laptop testing without a physical webcam
    python people_counter.py --no-mqtt           # local testing without an MQTT broker
    python people_counter.py --show              # laptop preview window with bounding boxes
    python people_counter.py --roi 0.0,0.2,1.0,1.0   # only count in part of the image

Published payload (JSON) on <room>/occupancy, retained:
    {"people": 7, "raw": 8, "ts": 1731000000.0, "infer_ms": 412, "source": "camera"}
    source is "camera", "file" or "fake" so test data can never be mistaken for real data.

Status on <room>/occupancy_status (retained):
    "online"        counter running and camera working (re-sent on every MQTT reconnect)
    "camera_error"  camera failed repeatedly; NO counts are published until it recovers
    "offline"       sent on clean shutdown, or by the broker if this script dies
The controller should treat anything other than "online", or a stale "ts", as
"occupancy unknown" and fall back to air quality alone.

The fake camera is opt-in only (--fake-camera). It is never used as an automatic fallback.
"""

import argparse
import json
import os
import signal
import statistics
import sys
import time
from collections import deque

# Avoid permissions error when writing Ultralytics config in sandboxed or macOS environments
os.environ.setdefault("YOLO_CONFIG_DIR", "/tmp/Ultralytics")

import cv2
import numpy as np
import paho.mqtt.client as mqtt
from ultralytics import YOLO

running = True


def _stop(*_):
    global running
    running = False


class FakeCamera:
    """Simulates a camera feed using built-in test images for testing on laptops."""

    def __init__(self, width: int = 1280, height: int = 720):
        self.width = width
        self.height = height
        self.images = []

        try:
            from ultralytics.utils import ASSETS
            assets_dir = str(ASSETS)
            for fname in ["bus.jpg", "zidane.jpg"]:
                p = os.path.join(assets_dir, fname)
                if os.path.exists(p):
                    img = cv2.imread(p)
                    if img is not None:
                        self.images.append(img)
        except Exception:
            pass

        if not self.images:
            # Fallback synthetic frame with simulated people
            dummy = np.zeros((height, width, 3), dtype=np.uint8) + 40
            cv2.putText(dummy, "Fake Camera (No Images)", (50, 100),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
            self.images = [dummy]

        self.idx = 0

    def isOpened(self) -> bool:
        return True

    def grab(self) -> bool:
        return True

    def retrieve(self):
        img = self.images[self.idx % len(self.images)]
        self.idx += 1
        frame = cv2.resize(img, (self.width, self.height))
        return True, frame.copy()

    def release(self):
        pass


def parse_args():
    p = argparse.ArgumentParser(description="Webcam people counter -> MQTT")
    p.add_argument("--room", default="room1", help="room name, used as MQTT topic prefix")
    p.add_argument("--broker", default="localhost", help="MQTT broker host")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--no-mqtt", action="store_true", help="run without MQTT publishing (console-only output)")
    p.add_argument("--camera", default="0", help="camera index (0), device path (/dev/video0), or video/image file")
    p.add_argument("--fake-camera", action="store_true", help="use built-in test images instead of physical webcam")
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--model", default="yolov8n.pt",
                   help="yolov8n.pt, or yolov8n_ncnn_model after exporting to NCNN")
    p.add_argument("--imgsz", type=int, default=416, help="inference size; lower = faster")
    p.add_argument("--conf", type=float, default=0.4, help="detection confidence threshold")
    p.add_argument("--interval", type=float, default=2.0, help="seconds between counts")
    p.add_argument("--window", type=int, default=5, help="median filter length (in counts)")
    p.add_argument("--roi", default=None,
                   help="x1,y1,x2,y2 as fractions 0-1 of the frame, e.g. 0,0.2,1,1")
    p.add_argument("--show", action="store_true", help="show preview window (needs a display)")
    p.add_argument("--max-frames", type=int, default=None, help="exit after processing N frames (useful for testing)")
    return p.parse_args()


def open_camera(args):
    if getattr(args, "fake_camera", False):
        print("[counter] Using fake camera test feed")
        return FakeCamera(width=args.width, height=args.height)

    src = int(args.camera) if str(args.camera).isdigit() else args.camera

    # cv2.CAP_V4L2 is Linux-only. On macOS / Windows or when opening files, use CAP_ANY.
    if sys.platform.startswith("linux") and (isinstance(src, int) or str(src).startswith("/dev/video")):
        cap = cv2.VideoCapture(src, cv2.CAP_V4L2)
    else:
        cap = cv2.VideoCapture(src)

    if not cap.isOpened() and not (isinstance(src, str) and os.path.exists(src)):
        print(f"[counter] Warning: Camera '{args.camera}' could not be opened.")
        if sys.platform == "darwin":
            print("[counter] Tip: On macOS, ensure Terminal has Camera access in System Settings > Privacy & Security > Camera, or pass --fake-camera.")
    else:
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    return cap


def fresh_frame(cap, flush=4):
    """We only look at one frame every few seconds, so drop buffered (stale) frames first."""
    for _ in range(flush):
        cap.grab()
    ok, frame = cap.retrieve()
    return ok, frame


def parse_roi(roi_str, w, h):
    if not roi_str:
        return 0, 0, w, h
    x1, y1, x2, y2 = [float(v) for v in roi_str.split(",")]
    return int(x1 * w), int(y1 * h), int(x2 * w), int(y2 * h)


def main():
    args = parse_args()
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    topic = f"{args.room}/occupancy"
    status_topic = f"{args.room}/occupancy_status"

    # --- MQTT ---
    client = None
    current_status = "online"  # what on_connect re-announces after a reconnect

    def set_status(value):
        nonlocal current_status
        current_status = value
        print(f"[counter] status -> {value}")
        if client:
            client.publish(status_topic, value, qos=1, retain=True)

    def on_connect(c, userdata, flags, rc, properties=None):
        # Works for paho-mqtt 1.x and 2.x. Runs on every (re)connect, so the retained
        # status can't get stuck on the broker's "offline" last-will after a network blip.
        print(f"[counter] MQTT connected to {args.broker}:{args.port}")
        c.publish(status_topic, current_status, qos=1, retain=True)

    if not args.no_mqtt:
        # Support both paho-mqtt 2.x and 1.x
        if hasattr(mqtt, "CallbackAPIVersion"):
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        else:
            client = mqtt.Client(client_id=f"{args.room}-counter")
        client.on_connect = on_connect
        client.will_set(status_topic, "offline", qos=1, retain=True)
        # connect_async never raises for an unreachable broker; it keeps retrying in the
        # background, and on_connect above tells you when it actually succeeds.
        client.connect_async(args.broker, args.port, keepalive=30)
        client.loop_start()
        print(f"[counter] publishing to {args.broker}:{args.port} topic '{topic}' "
              f"(waiting for broker connection...)")
    else:
        print("[counter] running in --no-mqtt mode (console output only)")

    # --- Model + camera ---
    model = YOLO(args.model)
    cap = open_camera(args)
    recent = deque(maxlen=max(1, args.window))

    print(f"[counter] interval={args.interval}s, imgsz={args.imgsz}, conf={args.conf} (Ctrl+C to stop)")

    next_t = time.monotonic()
    retries = 0
    frame_count = 0

    while running:
        if not cap.isOpened():
            retries += 1
            print(f"[counter] camera not open (attempt {retries}), retrying...")
            if retries > 3 and current_status != "camera_error":
                set_status("camera_error")  # stop pretending; controller falls back to air quality
            cap.release()
            time.sleep(min(retries, 5))
            cap = open_camera(args)
            continue

        ok, frame = fresh_frame(cap)
        if not ok or frame is None:
            # Handle end-of-file for video files by looping
            if isinstance(args.camera, str) and os.path.exists(args.camera):
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = fresh_frame(cap)

            if not ok or frame is None:
                retries += 1
                print(f"[counter] frame grab failed (attempt {retries}), reopening camera")
                if retries > 3 and current_status != "camera_error":
                    set_status("camera_error")
                cap.release()
                time.sleep(min(retries, 5))
                cap = open_camera(args)
                continue

        if current_status == "camera_error":
            print("[counter] camera recovered")
            recent.clear()  # don't blend pre-outage counts into the median
            set_status("online")
        retries = 0
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = parse_roi(args.roi, w, h)
        crop = frame[y1:y2, x1:x2]

        t0 = time.monotonic()
        result = model(crop, classes=[0], conf=args.conf, imgsz=args.imgsz, verbose=False)[0]
        infer_ms = int((time.monotonic() - t0) * 1000)

        raw = len(result.boxes)
        recent.append(raw)
        people = int(round(statistics.median(recent)))

        if args.fake_camera:
            source = "fake"
        elif os.path.exists(str(args.camera)):
            source = "file"
        else:
            source = "camera"
        payload = {"people": people, "raw": raw, "ts": round(time.time(), 1),
                   "infer_ms": infer_ms, "source": source}
        if client:
            try:
                client.publish(topic, json.dumps(payload), qos=0, retain=True)
            except Exception as e:
                print(f"[counter] publish error: {e}")

        print(f"[counter] people={people} (raw {raw}, {infer_ms} ms)")

        frame_count += 1
        if args.max_frames and frame_count >= args.max_frames:
            break

        if args.show:
            for bx1, by1, bx2, by2 in result.boxes.xyxy.int().tolist():
                cv2.rectangle(frame, (bx1 + x1, by1 + y1), (bx2 + x1, by2 + y1), (0, 255, 0), 2)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 160, 0), 1)  # ROI outline
            cv2.putText(frame, f"People: {people}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
            cv2.imshow("occupancy", frame)
            if cv2.waitKey(1) == 27:  # Esc
                break

        # keep a steady cadence regardless of inference time
        next_t += args.interval
        delay = next_t - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_t = time.monotonic()  # we're running slower than the interval; don't pile up

    # --- clean shutdown ---
    print("[counter] shutting down")
    if client:
        try:
            info = client.publish(status_topic, "offline", qos=1, retain=True)
            if hasattr(info, "wait_for_publish"):
                info.wait_for_publish(timeout=1)
        except Exception:
            pass
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass
    cap.release()
    if args.show:
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass


if __name__ == "__main__":
    main()