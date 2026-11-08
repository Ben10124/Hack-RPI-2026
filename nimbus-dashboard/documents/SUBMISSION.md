# Nimbus

**Elevator pitch:** Nimbus counts people and senses stale air, then runs the fan and opens the window on its own, closing it before rain, and explains every decision live.

## Inspiration

Classrooms and meeting rooms go from empty to packed in minutes, and the air goes stale just as fast. Most rooms have no sensors at all: ventilation runs on a fixed schedule, wasting energy on empty rooms and falling short in full ones. Opening a window helps, until it rains. We wanted a room that airs itself out the way a thoughtful person would, and tells you why.

## What it does

Nimbus watches how many people are in a room and how stale the air is getting, then sets the fan speed and opens or closes a window by itself.

- **Follows people:** airflow scales with the headcount using the ASHRAE 62.1 classroom ventilation rate, and the fan works harder as the air gets worse.
- **Reads the clouds:** it keeps the window shut when the forecast says rain or the barometric pressure is falling, and uses the fan instead.
- **Plans ahead:** it airs a room out before a booked event, and scales back when a booked room turns out half empty.
- **Explains itself:** every decision comes with one plain sentence on a live dashboard, for example *"3 people here and the air is getting stuffy (Gas level 80). Fan at 40%, window open 40% while it's dry outside."*
- **Stays safe:** if the device driving the window stops hearing from the server for 10 seconds, it closes the window and runs the fan at 50% on its own.
- **People stay in charge:** anyone can hold the fan or window from their phone for 15–60 minutes, and the hold expires automatically.

**The theme, three ways:** the *breath cloud* a full room produces, the *rain clouds* that decide whether the window opens, and *the cloud* (MongoDB Atlas and a live web dashboard) that stores and shows it all.

## How we built it

- **Arduino UNO Q:** the microcontroller half reads a Grove Air Quality Sensor v1.3 and a Grove SPA06-003 barometer, and passes them to the board's Linux half over Arduino's Bridge. A Python app there smooths the gas reading, subtracts a fresh-air baseline learned after warm-up, and publishes it over MQTT.
- **Raspberry Pi 4:** a USB webcam and YOLOv8n count people on the device, so only a number ever leaves the Pi. A second script drives the fan and the window servo from the server's commands, and has its own fail-safe watchdog.
- **Node.js server:** runs a built-in MQTT broker and the controller. Every few seconds it combines people, air, the pressure trend, the Open-Meteo rain forecast and room bookings into a fan and window decision with a reason.
- **MongoDB Atlas:** stores live room state, a time series collection of readings, the decision log and manual holds. An aggregation pipeline computes the "last 24 hours" stats.
- **Live dashboard:** Socket.IO and Chart.js. It works on a phone, laptop or projector, in light and dark mode, and shows charts with threshold lines, the decision log, device status and the manual controls.
- **Simulator:** a room air model runs extra simulated rooms with the exact same control rules, so we can show a whole building. The simulated rooms are labeled "Simulated" on screen.

## Challenges we ran into

- **The UNO Q's container service broke on demo morning.** App Lab runs the board's Python inside Docker, and after a power loss Docker refused to start. Its saved network list had a duplicate entry for its default network. We read the daemon's logs, cleared the stale network database, and got it running again.
- **Build configuration on a brand-new board.** App Lab's build profile had to list every library explicitly, including the Bridge's own dependencies (MsgPack and its helpers), before the sketch would compile.
- **Honest sensing.** Our gas sensor gives a relative reading, not CO₂. We label it "Gas level" with no units, measure it against a fresh-air baseline, and set thresholds to the sensor's own scale. The control rules accept any scale, so a true CO₂ sensor is a config change.
- **A fan that looked lazy.** With the window open, the airflow math let the fan slow down as the air got worse. We added minimum fan speeds for stuffy and stale air.
- **Two controllers, one room.** We had a Python controller and a server-side controller. We made the server the single decision-maker and made it ignore any other commands for that room, so they can never fight over the window.
- **Demoing weather indoors.** The real forecast decides whether the window may open, so we added two clearly labeled demo settings, "Pretend rain is coming" and "Pretend it's dry".

## Accomplishments that we're proud of

- A closed loop from camera and sensors to a moving fan and window, with every decision explained in a sentence a person can read from across the room.
- The window can't be stranded open: the fail-safe needs no server, Wi-Fi or cloud.
- Privacy by design: no camera images are stored or sent.
- One set of control rules drives both the real room and the simulated building.

## What we learned

- How to split work across an MCU, a Linux board, a Pi and a server with MQTT as the common language.
- Reading the actual logs beats guessing, whether it's Docker on a dev board or a compiler error.
- Being upfront about what a sensor measures makes the project stronger, not weaker.

## What's next for Nimbus

- Swap in a true CO₂ sensor (SCD40), and use the room air model to measure each room's real ventilation rate from how fast the air clears.
- Drive real building hardware (window actuators, fresh-air dampers) through relays or BACnet.
- Learn each room's occupancy patterns to pre-ventilate without a calendar.
- Use outdoor air quality and wildfire smoke data, so the window never opens into smoke.
- Add authentication for the controls, and alerts when a room needs air.

## Built with

Arduino UNO Q, Raspberry Pi 4, Logitech USB webcam, Grove Air Quality Sensor v1.3, Grove SPA06-003 barometer, C++, Python, JavaScript, Node.js, Express, Socket.IO, MQTT (Aedes, paho-mqtt), YOLOv8 (Ultralytics), OpenCV, MongoDB Atlas, Chart.js, Open-Meteo, Arduino App Lab, Docker
