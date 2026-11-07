// Nimbus sensors: microcontroller side of the UNO Q app.
//
// Reads the Grove Air Quality Sensor v1.3 (analog) and the Grove SPA06-003 barometer
// (I2C) and sends one sample per second to the Linux side (python/main.py) with
// Bridge.notify. The Python side smooths the gas reading, subtracts the fresh-air
// baseline and publishes room1/sensors over MQTT.
//
// Wiring (all at 3.3 V, all grounds together):
//   Gas sensor   VCC -> 3.3V, GND -> GND, SIG -> A2  (NC unused)
//   Barometer    either the header SDA/SCL pins (Wire) or the Qwiic port (Wire1);
//                the sketch finds it on either bus, at 0x77 or 0x76.
//
// Library: "Seeed Arduino SPA06" (listed in sketch.yaml; App Lab installs it, or add it
// from the library manager).

#include <Arduino_RouterBridge.h>
#include <Wire.h>
#include "SPL07-003.h"  // the Seeed SPA06 library's header (works for the SPA06-003)

const int GAS_PIN = A2;
const unsigned long SAMPLE_MS = 100;       // read the gas sensor 10x a second...
const unsigned long REPORT_MS = 1000;      // ...and report the 1-second average
const unsigned long BARO_RETRY_MS = 10000; // look for the barometer again if it's missing

// Sentinels for "no reading" (Python treats them as missing).
const float NO_PRESSURE = 0.0;
const float NO_TEMP = -999.0;

SPL07_003 baro;
bool baroOk = false;
float pressureHpa = NO_PRESSURE;
float tempC = NO_TEMP;

long gasSum = 0;
int gasCount = 0;
unsigned long lastSample = 0;
unsigned long lastReport = 0;
unsigned long lastBaroTry = 0;

bool startBaro(TwoWire &bus, uint8_t addr) {
  bus.begin();
  if (!baro.begin(addr, &bus)) return false;
  baro.setPressureConfig(SPL07_4HZ, SPL07_32SAMPLES);
  baro.setTemperatureConfig(SPL07_4HZ, SPL07_1SAMPLE);
  baro.setMode(SPL07_CONT_PRES_TEMP);
  return true;
}

void findBaro() {
  lastBaroTry = millis();
  baroOk = startBaro(Wire, SPL07_ADDR_DEF) || startBaro(Wire1, SPL07_ADDR_DEF) ||
           startBaro(Wire, SPL07_ADDR_ALT) || startBaro(Wire1, SPL07_ADDR_ALT);
}

void setup() {
  // 10-bit readings (0-1023), so the 50 / 150 thresholds match Seeed's scale.
  // Don't call pinMode on the analog pin: on the UNO Q it can break analogRead.
  analogReadResolution(10);
  Bridge.begin();
  findBaro();
}

void loop() {
  unsigned long now = millis();

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    gasSum += analogRead(GAS_PIN);
    gasCount++;
  }

  if (baroOk && (baro.pressureAvailable() || baro.temperatureAvailable())) {
    double p = baro.readPressure() / 100.0;  // Pa -> hPa
    double t = baro.readTemperature();
    pressureHpa = (p > 300.0 && p < 1100.0) ? (float)p : NO_PRESSURE;
    tempC = (t > -40.0 && t < 85.0) ? (float)t : NO_TEMP;
  }
  if (!baroOk && now - lastBaroTry >= BARO_RETRY_MS) findBaro();

  if (now - lastReport >= REPORT_MS && gasCount > 0) {
    lastReport = now;
    float gas = (float)gasSum / gasCount;
    gasSum = 0;
    gasCount = 0;
    Bridge.notify("nimbus_sample", gas, pressureHpa, tempC, baroOk);
  }
}
