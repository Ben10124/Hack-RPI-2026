#!/usr/bin/env python3
"""
actuators.py - drives the fan and the window servo on the Raspberry Pi 4 from the
Nimbus server's decisions, with a local fail-safe.

  IN   room1/cmd        {"fan": 65, "window": 40, "reason": "...", "mode": "auto"}   every 5 s
  IN   room1/heartbeat  {"t": ...}                                                  every 2 s
  OUT  room1/actuators  {"fan": 65, "window": 40, "failsafe": false}               every 2 s
       (what is actually applied; the dashboard shows it under Devices -> Fan + window)

Fail-safe (master doc, section 11): if no cmd or heartbeat arrives for 10 s, close the
window and run the fan at 50%. It also starts in that safe state until the first cmd.
It never depends on the server, Wi-Fi or the cloud.

Install on the Pi (Raspberry Pi OS Bookworm already has gpiozero + lgpio):
    pip install "paho-mqtt>=1.6"          # inside the same venv as the people counter is fine

Run:
    python actuators.py --broker <laptop-ip> --fan-pin 18 --servo-pin 13
    python actuators.py --dry-run --broker 127.0.0.1     # no GPIO: prints what it would do
    python actuators.py --test --fan-pin 18 --servo-pin 13  # no MQTT: sweeps fan + window once

Calibrate the window first with --test: 0% must be CLOSED. If it opens the wrong way,
swap --closed-angle and --open-angle. Most hobby servos want 0.5-2.5 ms pulses; if yours
buzzes at the ends of its travel, narrow --min-pulse / --max-pulse.

Fan wiring (pick the matching --fan-mode):
  pwm     (default) GPIO -> MOSFET or transistor -> fan, or a 4-pin fan's PWM wire.
          Software PWM via gpiozero, --fan-freq Hz (default 1000).
  hwpwm   4-pin PC fan wanting ~25 kHz. Hardware PWM through the pigpio daemon:
          sudo apt install pigpio python3-pigpio && sudo systemctl enable --now pigpiod
          Only GPIO 12, 13, 18 or 19.
  onoff   relay or plain switch: on when the fan should run at all (>= --onoff-threshold %).
  --fan-invert      if your driver stage inverts (e.g. an NPN pulling the PWM wire low).
  --fan-min-duty    most fans stall below ~20-30% duty; 1-100% is mapped onto min..100.

Servo jitter: gpiozero's default software timing can make a servo twitch. This script
moves the servo slowly and then stops sending pulses (--servo-hold keeps them on). For a
rock-steady servo, run pigpiod and start with GPIOZERO_PIN_FACTORY=pigpio.

Power: never feed an MG996R from the Pi's 5 V pin. Give the servo (and the 12 V fan) their
own supplies and tie all grounds together.
"""

import argparse
import json
import math
import signal
import threading
import time

running = True


def _stop(*_):
    global running
    running = False


def parse_args():
    p = argparse.ArgumentParser(description="Nimbus fan + window servo driver")
    p.add_argument("--broker", default="localhost", help="the LAPTOP's IP (Nimbus server's built-in broker)")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--room", default="room1")
    p.add_argument("--prefix", default="", help="MQTT topic prefix, if the server uses MQTT_PREFIX")
    p.add_argument("--dry-run", action="store_true", help="no GPIO: print what would happen")
    p.add_argument("--test", action="store_true", help="no MQTT: sweep the fan and window once, then exit")

    g = p.add_argument_group("fan")
    g.add_argument("--fan-pin", type=int, default=18, help="BCM GPIO number (default 18)")
    g.add_argument("--fan-mode", choices=["pwm", "hwpwm", "onoff"], default="pwm")
    g.add_argument("--fan-freq", type=float, default=1000.0, help="Hz for --fan-mode pwm")
    g.add_argument("--fan-invert", action="store_true")
    g.add_argument("--fan-min-duty", type=float, default=0.0, help="%% duty for the slowest running speed")
    g.add_argument("--onoff-threshold", type=float, default=1.0, help="%% at or above which onoff mode switches on")

    g = p.add_argument_group("window servo")
    g.add_argument("--servo-pin", type=int, default=13, help="BCM GPIO number (default 13)")
    g.add_argument("--closed-angle", type=float, default=0.0, help="servo angle for window 0%% (closed)")
    g.add_argument("--open-angle", type=float, default=90.0, help="servo angle for window 100%% (fully open)")
    g.add_argument("--min-pulse", type=float, default=0.5, help="ms pulse for 0 degrees")
    g.add_argument("--max-pulse", type=float, default=2.5, help="ms pulse for 180 degrees")
    g.add_argument("--servo-speed", type=float, default=60.0, help="degrees per second")
    g.add_argument("--servo-hold", action="store_true", help="keep sending pulses after a move")

    g = p.add_argument_group("safety")
    g.add_argument("--watchdog", type=float, default=10.0, help="seconds without cmd/heartbeat before fail-safe")
    g.add_argument("--failsafe-fan", type=float, default=50.0)
    return p.parse_args()


# --------------------------------------------------------------------------------------
# Hardware
# --------------------------------------------------------------------------------------
class Fan:
    def __init__(self, args):
        self.args = args
        self.dev = None
        self.pi = None
        self.last = None
        if args.dry_run:
            return
        if args.fan_mode == "hwpwm":
            import pigpio
            if args.fan_pin not in (12, 13, 18, 19):
                raise SystemExit("--fan-mode hwpwm needs GPIO 12, 13, 18 or 19")
            self.pi = pigpio.pi()
            if not self.pi.connected:
                raise SystemExit("pigpio daemon not running: sudo systemctl enable --now pigpiod")
        elif args.fan_mode == "onoff":
            from gpiozero import DigitalOutputDevice
            self.dev = DigitalOutputDevice(args.fan_pin, active_high=not args.fan_invert, initial_value=False)
        else:
            from gpiozero import PWMOutputDevice
            self.dev = PWMOutputDevice(args.fan_pin, active_high=not args.fan_invert,
                                       initial_value=0, frequency=args.fan_freq)

    def duty(self, pct):
        """0-100 % speed -> 0-1 duty, lifting non-zero speeds above the stall point."""
        if pct <= 0:
            return 0.0
        lo = max(0.0, min(100.0, self.args.fan_min_duty))
        return (lo + (100.0 - lo) * pct / 100.0) / 100.0

    def set(self, pct):
        pct = max(0.0, min(100.0, pct))
        if pct == self.last:
            return
        self.last = pct
        d = self.duty(pct)
        a = self.args
        if a.dry_run:
            print("[actuators] fan -> %d%% (duty %.2f)" % (pct, d))
        elif a.fan_mode == "hwpwm":
            if a.fan_invert:
                d = 1.0 - d
            self.pi.hardware_PWM(a.fan_pin, 25000, int(d * 1_000_000))
        elif a.fan_mode == "onoff":
            self.dev.value = 1 if pct >= a.onoff_threshold else 0
        else:
            self.dev.value = d

    def close(self):
        try:
            if self.pi:
                self.pi.hardware_PWM(self.args.fan_pin, 25000, 0)
                self.pi.stop()
            elif self.dev:
                self.dev.close()
        except Exception:
            pass


class Window:
    """Moves the servo gradually toward the target so the flap doesn't slam."""

    def __init__(self, args):
        self.args = args
        self.servo = None
        self.angle = args.closed_angle
        self.target = args.closed_angle
        self.moving_until = 0.0
        if not args.dry_run:
            from gpiozero import AngularServo
            self.servo = AngularServo(args.servo_pin, initial_angle=args.closed_angle,
                                      min_angle=0, max_angle=180,
                                      min_pulse_width=args.min_pulse / 1000.0,
                                      max_pulse_width=args.max_pulse / 1000.0)
        self.moving_until = time.monotonic() + 1.0  # let the initial move finish

    def pct_to_angle(self, pct):
        a = self.args
        return a.closed_angle + (a.open_angle - a.closed_angle) * max(0.0, min(100.0, pct)) / 100.0

    def angle_to_pct(self, angle):
        a = self.args
        span = a.open_angle - a.closed_angle
        return 0.0 if span == 0 else max(0.0, min(100.0, (angle - a.closed_angle) / span * 100.0))

    def set(self, pct):
        target = self.pct_to_angle(pct)
        if target != self.target:
            self.target = target
            if self.args.dry_run:
                print("[actuators] window -> %d%% (servo %.0f deg)" % (pct, target))

    def step(self, dt):
        now = time.monotonic()
        if self.angle != self.target:
            delta = self.args.servo_speed * dt
            if abs(self.target - self.angle) <= delta:
                self.angle = self.target
            else:
                self.angle += math.copysign(delta, self.target - self.angle)
            if self.servo:
                self.servo.angle = max(0.0, min(180.0, self.angle))
            self.moving_until = now + 0.6  # give the servo time to reach the last command
        elif self.servo and not self.args.servo_hold and now > self.moving_until and self.servo.value is not None:
            self.servo.detach()  # stop pulses: no jitter, no hum; the flap holds by friction/gravity

    def position_pct(self):
        return self.angle_to_pct(self.angle)

    def close(self):
        try:
            if self.servo:
                self.servo.close()
        except Exception:
            pass


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------
def number(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def run_test(args, fan, window):
    """Sweep once so you can check direction and calibration by eye."""
    steps = [("window closed, fan off", 0, 0), ("window 40%, fan 40%", 40, 40),
             ("window 70%, fan 70%", 70, 70), ("window fully open, fan 100%", 100, 100),
             ("back to closed, fan 50% (the fail-safe state)", 0, 50)]
    for label, w, f in steps:
        print("[test] %s" % label)
        fan.set(f)
        window.set(w)
        end = time.monotonic() + 3.0
        while running and time.monotonic() < end:
            window.step(0.05)
            time.sleep(0.05)
        if not running:
            break
    print("[test] done. 0% must be CLOSED; if not, swap --closed-angle and --open-angle.")


def main():
    args = parse_args()
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    fan = Fan(args)
    window = Window(args)
    if args.test:
        try:
            run_test(args, fan, window)
        finally:
            fan.set(0)
            fan.close()
            window.close()
        return

    import paho.mqtt.client as mqtt

    base = "%s%s" % (args.prefix, args.room)
    lock = threading.Lock()
    state = {"fan": args.failsafe_fan, "window": 0.0, "last_heard": None, "failsafe": True}

    def on_connect(client, *_):
        print("[actuators] MQTT connected to %s:%d" % (args.broker, args.port))
        client.subscribe([(base + "/cmd", 0), (base + "/heartbeat", 0)])

    def on_disconnect(*_):
        print("[actuators] MQTT disconnected; the fail-safe takes over after %.0f s" % args.watchdog)

    def on_message(client, userdata, msg):
        now = time.monotonic()
        with lock:
            if msg.topic.endswith("/heartbeat"):
                state["last_heard"] = now
                return
            try:
                cmd = json.loads(msg.payload.decode("utf-8", "replace"))
            except ValueError:
                print("[actuators] ignored a cmd that isn't JSON")
                return
            if not isinstance(cmd, dict):
                return
            f, w = number(cmd.get("fan")), number(cmd.get("window"))
            if f is None and w is None:
                print("[actuators] ignored a cmd without fan or window")
                return
            if f is not None:
                state["fan"] = max(0.0, min(100.0, f))
            if w is not None:
                state["window"] = max(0.0, min(100.0, w))
            state["last_heard"] = now
            if state["failsafe"]:
                print("[actuators] commands received, leaving the fail-safe")
            state["failsafe"] = False

    client_id = "%s-actuators-%04x" % (args.room, int(time.time() * 1000) & 0xFFFF)  # unique per run
    if hasattr(mqtt, "CallbackAPIVersion"):  # paho-mqtt 2.x
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
    else:  # paho-mqtt 1.x
        client = mqtt.Client(client_id=client_id)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(args.broker, args.port, keepalive=15)
    client.loop_start()
    print("[actuators] waiting for %s/cmd from %s:%d (fail-safe until the first command)"
          % (base, args.broker, args.port))

    last_publish = 0.0
    last_tick = time.monotonic()
    try:
        while running:
            now = time.monotonic()
            dt, last_tick = now - last_tick, now
            with lock:
                heard = state["last_heard"]
                if not state["failsafe"] and (heard is None or now - heard > args.watchdog):
                    state["failsafe"] = True
                    print("[actuators] FAIL-SAFE: nothing from the server for %.0f s. "
                          "Window closed, fan %d%%." % (args.watchdog, args.failsafe_fan))
                if state["failsafe"]:
                    fan_pct, window_pct = args.failsafe_fan, 0.0
                else:
                    fan_pct, window_pct = state["fan"], state["window"]
                failsafe = state["failsafe"]
            fan.set(fan_pct)
            window.set(window_pct)
            window.step(dt)

            if now - last_publish >= 2.0 and client.is_connected():
                last_publish = now
                client.publish(base + "/actuators", json.dumps({
                    "fan": int(round(fan_pct)),
                    "window": int(round(window.position_pct())),
                    "failsafe": failsafe,
                }))
            time.sleep(0.05)
    finally:
        print("[actuators] stopping: window closed, fan off")
        window.set(0)
        end = time.monotonic() + 2.0
        while time.monotonic() < end and window.angle != window.target:
            window.step(0.05)
            time.sleep(0.05)
        fan.set(0)
        fan.close()
        window.close()
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
