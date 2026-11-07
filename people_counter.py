#!/usr/bin/env python3
"""
People Counter for Occupancy-Aware Ventilation System
=====================================================
Runs on Raspberry Pi 4. Captures frames from the CSI camera using Picamera2,
detects people with YOLOv8-nano, and publishes the count over MQTT.

MQTT topic:  room1/occupancy   →  {"people": 7}

No frames are saved or transmitted — only the integer count leaves the device.

Dependencies (install on the Pi):
    pip install picamera2 ultralytics opencv-python-headless paho-mqtt

Usage:
    python3 people_counter.py                        # defaults
    python3 people_counter.py --broker 192.168.1.50  # custom broker IP
    python3 people_counter.py --room room2           # second room
    python3 people_counter.py --headless              # no preview window
    python3 people_counter.py --fake-camera           # laptop testing without a Pi camera
"""

import argparse
import json
import logging
import signal
import sys
import time
from threading import Event

import cv2
import numpy as np
import paho.mqtt.client as mqtt

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------
DEFAULT_BROKER = "localhost"      # Pi 4 runs its own Mosquitto
DEFAULT_PORT = 1883
DEFAULT_ROOM = "room1"
DEFAULT_INTERVAL = 2.0           # seconds between detections
DEFAULT_CONFIDENCE = 0.40        # YOLO confidence threshold
DEFAULT_MODEL = "yolov8n.pt"     # nano — fast enough for Pi 4 at ~2 fps
FRAME_WIDTH = 640                # resize for speed; YOLO handles this internally too
FRAME_HEIGHT = 480

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("people_counter")

# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------
_shutdown = Event()


def _handle_signal(signum, _frame):
    log.info("Caught signal %s — shutting down…", signal.Signals(signum).name)
    _shutdown.set()


signal.signal(signal.SIGINT, _handle_signal)
signal.signal(signal.SIGTERM, _handle_signal)


# ---------------------------------------------------------------------------
# Camera abstraction
# ---------------------------------------------------------------------------
class PiCamera:
    """Wraps Picamera2 for the real CSI camera on a Raspberry Pi."""

    def __init__(self, width: int = FRAME_WIDTH, height: int = FRAME_HEIGHT):
        from picamera2 import Picamera2          # import here so --fake-camera works on laptops

        self._cam = Picamera2()
        config = self._cam.create_still_configuration(
            main={"size": (width, height), "format": "RGB888"},
        )
        self._cam.configure(config)
        self._cam.start()
        log.info("Pi camera started at %dx%d", width, height)

    def capture(self) -> np.ndarray:
        """Return a BGR numpy frame (OpenCV convention)."""
        rgb = self._cam.capture_array()
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    def close(self):
        self._cam.stop()


class FakeCamera:
    """
    Generates synthetic frames with randomly placed 'person-shaped' rectangles.
    Use this for testing the pipeline on a laptop without a Pi camera.
    """

    def __init__(self, width: int = FRAME_WIDTH, height: int = FRAME_HEIGHT, max_people: int = 12):
        self.w = width
        self.h = height
        self.max_people = max_people
        self._rng = np.random.default_rng(42)
        log.info("Fake camera active — generating synthetic frames")

    def capture(self) -> np.ndarray:
        frame = np.zeros((self.h, self.w, 3), dtype=np.uint8) + 30   # dark background
        n = int(self._rng.integers(0, self.max_people + 1))
        for _ in range(n):
            # Random upright rectangle vaguely person-shaped
            pw, ph = int(self._rng.integers(30, 60)), int(self._rng.integers(80, 160))
            x1 = int(self._rng.integers(0, self.w - pw))
            y1 = int(self._rng.integers(0, self.h - ph))
            color = tuple(int(c) for c in self._rng.integers(100, 255, size=3))
            cv2.rectangle(frame, (x1, y1), (x1 + pw, y1 + ph), color, -1)
        return frame

    def close(self):
        pass


# ---------------------------------------------------------------------------
# YOLO detector
# ---------------------------------------------------------------------------
class PersonDetector:
    """
    Thin wrapper around Ultralytics YOLOv8-nano.
    Only counts class 0 ('person') detections above the confidence threshold.
    """

    PERSON_CLASS_ID = 0  # COCO class 0 = person

    def __init__(self, model_path: str = DEFAULT_MODEL, confidence: float = DEFAULT_CONFIDENCE):
        from ultralytics import YOLO
        log.info("Loading YOLO model '%s' (this may take a moment on first run)…", model_path)
        self._model = YOLO(model_path)
        self._conf = confidence
        log.info("Model loaded. Confidence threshold = %.2f", confidence)

    def count_people(self, frame: np.ndarray) -> tuple[int, list]:
        """
        Run inference and return (count, list_of_bounding_boxes).
        Each bbox is (x1, y1, x2, y2, confidence).
        """
        results = self._model(frame, conf=self._conf, verbose=False)
        boxes = []
        for r in results:
            for box in r.boxes:
                if int(box.cls[0]) == self.PERSON_CLASS_ID:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    boxes.append((int(x1), int(y1), int(x2), int(y2), conf))
        return len(boxes), boxes


# ---------------------------------------------------------------------------
# Optional preview window (for debugging on a monitor attached to the Pi)
# ---------------------------------------------------------------------------
def draw_detections(frame: np.ndarray, boxes: list, count: int) -> np.ndarray:
    """Annotate the frame with bounding boxes and the count banner."""
    out = frame.copy()
    for (x1, y1, x2, y2, conf) in boxes:
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 255, 0), 2)
        label = f"person {conf:.0%}"
        cv2.putText(out, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

    banner = f"People: {count}"
    cv2.putText(out, banner, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 200, 255), 2)
    return out


# ---------------------------------------------------------------------------
# MQTT helpers
# ---------------------------------------------------------------------------
def make_mqtt_client(broker: str, port: int, room: str) -> mqtt.Client:
    client = mqtt.Client(client_id=f"{room}-people-counter", protocol=mqtt.MQTTv311)
    client.enable_logger(log)

    def on_connect(c, _ud, _flags, rc):
        if rc == 0:
            log.info("Connected to MQTT broker %s:%d", broker, port)
        else:
            log.error("MQTT connect failed with code %d", rc)

    def on_disconnect(c, _ud, rc):
        if rc != 0:
            log.warning("Unexpected MQTT disconnect (rc=%d). Will auto-reconnect.", rc)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    try:
        client.connect(broker, port, keepalive=60)
    except OSError as e:
        log.error("Cannot reach broker at %s:%d — %s. Will retry in background.", broker, port, e)

    client.loop_start()          # non-blocking network loop in a background thread
    return client


def publish_count(client: mqtt.Client, topic: str, count: int):
    payload = json.dumps({"people": count})
    info = client.publish(topic, payload, qos=1, retain=True)
    if info.rc == mqtt.MQTT_ERR_SUCCESS:
        log.info("Published %s → %s", topic, payload)
    else:
        log.warning("Publish to %s failed (rc=%d)", topic, info.rc)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="YOLO-based people counter for ventilation control")
    parser.add_argument("--broker", default=DEFAULT_BROKER, help="MQTT broker IP/hostname")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="MQTT broker port")
    parser.add_argument("--room", default=DEFAULT_ROOM, help="Room identifier (e.g. room1, room2)")
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL, help="Seconds between detections")
    parser.add_argument("--confidence", type=float, default=DEFAULT_CONFIDENCE, help="YOLO confidence threshold")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Path to YOLO model weights")
    parser.add_argument("--headless", action="store_true", help="Disable the OpenCV preview window")
    parser.add_argument("--fake-camera", action="store_true", help="Use synthetic frames (for laptop testing)")
    args = parser.parse_args()

    topic = f"{args.room}/occupancy"

    # --- Camera ---
    if args.fake_camera:
        camera = FakeCamera()
    else:
        camera = PiCamera()

    # --- Detector ---
    detector = PersonDetector(model_path=args.model, confidence=args.confidence)

    # --- MQTT ---
    mqttc = make_mqtt_client(args.broker, args.port, args.room)

    # --- Loop ---
    log.info("Starting detection loop (interval=%.1fs, topic=%s)", args.interval, topic)
    last_count = -1  # force first publish

    try:
        while not _shutdown.is_set():
            t0 = time.monotonic()

            frame = camera.capture()
            count, boxes = detector.count_people(frame)

            # Only publish when the count changes (saves MQTT traffic & Firestore writes)
            if count != last_count:
                publish_count(mqttc, topic, count)
                last_count = count
            else:
                log.debug("Count unchanged (%d) — skipping publish", count)

            # Optional preview
            if not args.headless:
                annotated = draw_detections(frame, boxes, count)
                cv2.imshow("People Counter", annotated)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    log.info("'q' pressed — shutting down")
                    break

            # Sleep the remainder of the interval
            elapsed = time.monotonic() - t0
            sleep_time = max(0, args.interval - elapsed)
            if sleep_time > 0:
                _shutdown.wait(sleep_time)

    finally:
        log.info("Cleaning up…")
        camera.close()
        mqttc.loop_stop()
        mqttc.disconnect()
        if not args.headless:
            cv2.destroyAllWindows()
        log.info("Done.")


if __name__ == "__main__":
    main()
