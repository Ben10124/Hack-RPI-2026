# Nimbus — submission writeup (draft)

> Draft for the HackRPI submission form. Items in **[brackets]** need checking against the final build before you paste. Delete this note when done.

**Tagline:** Ventilation that follows people, reads the clouds, and explains itself.

## Inspiration

Classrooms and meeting rooms go from empty to packed in minutes, and the air goes stale just as fast. Most rooms have no sensors at all. Ventilation either runs on a fixed schedule, wasting energy on empty rooms, or doesn't run enough when the room is full. Opening a window helps until it rains. We wanted a room that airs itself out the way a thoughtful person would, and tells you why.

## What it does

Nimbus counts the people in a room and watches the air getting stale. From that it sets the fan speed and opens or closes the window on its own.

- **Follows people:** airflow scales with the number of people, using the ASHRAE 62.1 classroom ventilation rate.
- **Reads the clouds:** it keeps the window shut when rain is likely (live forecast) or the barometric pressure is falling, and uses the fan instead.
- **Plans ahead:** it airs a room out before a booked event, and scales back when a booked room turns out half empty.
- **Explains itself:** every decision comes with one plain sentence on the dashboard, for example *"8 people here and the air is getting stuffy. Fan at 65%, window kept closed because rain is likely (70%)."*
- **Stays safe:** if the controller goes quiet, the window closes by itself within 10 seconds.
- **People stay in charge:** anyone can hold the fan or window from their phone for 15–60 minutes, and the hold expires automatically.

**The theme, three ways:** the *breath cloud* a full room produces, the *rain clouds* that decide whether the window opens, and *the cloud* (MongoDB Atlas plus a live web dashboard) that stores and shows it all.

## How we built it

- **Arduino UNO Q** reads a Grove Air Quality Sensor v1.3 and a barometer, then publishes them over MQTT.
- **Raspberry Pi 4** counts people with its camera on the device, so only a number ever leaves the Pi. It also drives the fan and the window servo, with its own fail-safe.
- **Node.js server** on a laptop runs an MQTT broker and the controller. Every 5 seconds the controller combines people, air, the pressure trend, the Open-Meteo rain forecast and room bookings into a fan and window decision.
- **MongoDB Atlas** stores live room state, a time series collection of readings, the decision log and manual holds. An aggregation pipeline computes the "last 24 hours" stats.
- **Live dashboard** (Socket.IO, Chart.js) works on a phone, laptop or projector, in light and dark mode. It shows charts with threshold lines, a decision log, device status and the manual controls.
- **Simulator:** a room air model (a CO₂ mass balance) runs extra simulated rooms with the same control rules, so we could show a whole building. The simulated rooms are labeled "Simulated" on screen.

## Challenges we ran into

- **Honest sensing.** Our gas sensor gives a relative reading, not CO₂. We set its threshold levels to match the sensor's own scale and label it "Gas level," not ppm. The control rules work on any scale, so a true CO₂ sensor is a one-line config change.
- **Rules that agree with themselves.** Our first simulator drifted from the written rules. We moved everything into one rules module used by both the real room and the simulated rooms.
- **A fan that looked lazy.** With the window open, the airflow math let the fan slow down as the air got worse. We added minimum fan speeds for stuffy and stale air, so the fan always visibly responds.
- **Demoing weather indoors.** The real forecast decides whether the window can open, so a dry day can't show the rain behavior and a rainy day can't show the window opening. We added two clearly labeled demo settings, "Pretend rain is coming" and "Pretend it's dry".
- **[Hardware challenges from the build: wiring, power, servo calibration, sensor warm-up]**

## Accomplishments that we're proud of

- A closed loop from camera and sensors to the fan and window, **[working end to end on the model room]**.
- Every decision explains itself in a sentence a person can read from across the room.
- The window can't be stranded open: if the controller goes quiet, it closes on its own.
- Privacy by design: no images are stored or sent.

## What we learned

- **[Team to fill in]**

## What's next for Nimbus

- Swap in a true CO₂ sensor (SCD40) and use the room air model to measure each room's real ventilation rate from how fast the air clears.
- Drive real building systems (window actuators, fresh-air dampers) through relays or BACnet.
- Learn each room's occupancy patterns, so it can pre-ventilate without a calendar.
- Use outdoor air quality and wildfire smoke data, so the window never opens into smoke.
- Add authentication for the controls, and alerts when a room needs air.

## Built with

Arduino UNO Q, Raspberry Pi 4, Pi Camera, Grove Air Quality Sensor v1.3, Grove barometer, Python, C++, Node.js, Express, Socket.IO, MQTT (Aedes), MongoDB Atlas, Chart.js, Open-Meteo

## Team

**[Names and roles]**
