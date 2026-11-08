// 3D virtual model room: plays the part of the fan and the window servo while the
// real ones aren't connected. Same behavior as the 2D page (model.js): follows the
// controller's live decisions, swings the window at servo speed, spins the fan with
// some inertia, and copies the Pi script's fail-safe (no decision for 10 s ->
// window closed, fan 50%). Rendered with three.js, served locally from /vendor/three.
//
// Open it as /model3d.html#room1 (any room id works, including simulated rooms).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MAX_FLAP_DEG = 70; // window angle for a fully open window
const FLAP_DEG_PER_S = 47; // about pi4/actuators.py: 60°/s over a 90° servo travel
const FAN_TAU_S = 1.2; // fan spin-up / spin-down time constant
const RPM_PER_PCT = 18; // same fan model as the simulator (1,800 rpm at 100%)
const SPIN_DEG_PER_S = 900; // drawn blade speed at 100% (slowed so the eye can follow)
const WATCHDOG_MS = 10000; // same as the Pi script
const FAILSAFE = { fan: 50, window: 0 };
const MAX_PEOPLE_DRAWN = 16;

// Room size in scene units (about metres): width (x), height (y), depth (z).
const W = 6;
const H = 2.8;
const D = 4;
const T = 0.12; // wall thickness
const WIN = { z0: -0.8, z1: 0.8, y0: 1.2, y1: 2.3 }; // window opening in the left wall
const FAN = { y: 1.75, r: 0.5 }; // round fan opening in the right wall

const $ = (sel) => document.querySelector(sel);
const field = (f) => document.querySelector(`[data-f="${f}"]`);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const dark = window.matchMedia('(prefers-color-scheme: dark)');
// "#room1" or a dashboard-style "#/room/room1"
const roomId = decodeURIComponent(location.hash.replace(/^#/, '').split('/').filter(Boolean).pop() || '') || 'room1';

const els = {
  stage: $('#stage'),
  labelWindow: $('#label-window'),
  labelFan: $('#label-fan'),
  windowCap: $('#window-cap'),
  fanCap: $('#fan-cap'),
  chip: $('#chip'),
  status: $('#sim-status'),
  reason: $('#reason'),
};

const state = {
  config: null,
  room: null,
  status: null,
  connected: false,
  lastCmdAt: null,
  controllerTs: null,
  target: null,
  flapDeg: 0,
  fan: 0,
  haze: 0,
  lastFrame: null,
  lastText: 0,
  peopleDrawn: null,
};

// ---------- helpers

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function pct(v, fallback) {
  return isNum(v) ? clamp(v, 0, 100) : fallback;
}

function fmt(n) {
  return Math.round(n).toLocaleString();
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function set(el, text) {
  if (el && el.textContent !== String(text)) el.textContent = text;
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function levels() {
  const aq = state.config?.airQuality || {};
  const good = isNum(aq.good) ? aq.good : 800;
  const poor = isNum(aq.poor) ? aq.poor : 1200;
  return { good, poor, near: good - 0.375 * (poor - good) };
}

function airWord(aq) {
  const { good, poor, near } = levels();
  if (aq >= poor) return 'Needs air';
  if (aq >= good) return 'Getting stuffy';
  if (aq >= near) return 'Starting to build up';
  return 'Fresh air';
}

function raining() {
  return isNum(state.room?.rainChance) && state.room.rainChance >= 50;
}

function target(now) {
  const room = state.room;
  if (!room || state.lastCmdAt === null) return { ...FAILSAFE, failsafe: true, waiting: true };
  if (now - state.lastCmdAt > WATCHDOG_MS) return { ...FAILSAFE, failsafe: true, waiting: false };
  return { fan: pct(room.fanPct, 0), window: pct(room.windowCmd ?? room.windowPct, 0), failsafe: false, waiting: false };
}

function hazeFor(room) {
  if (!room || !isNum(room.aq)) return 0;
  const { poor, near } = levels();
  return 0.05 + 0.95 * clamp((room.aq - near) / (poor - near), 0, 1);
}

// ---------- 3D scene

const PALETTES = {
  light: { wall: 0xf4f7fa, back: 0xe8eef4, floor: 0xcdd8e3, accent: 0x2a78d6, person: 0x44556a, glass: 0x9cc3f0, haze: 0x7d8a99, cloud: 0x9aa7b5, rain: 0x2a78d6, frame: 0x15263b },
  dark: { wall: 0x1e2c3f, back: 0x18253a, floor: 0x2a3b52, accent: 0x3987e5, person: 0xb0bdcc, glass: 0x6aa7f0, haze: 0xb7c3d1, cloud: 0x8a99ab, rain: 0x6aa7f0, frame: 0xe6edf4 },
};

const scene3d = { ok: false };

function buildScene() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    const note = document.createElement('p');
    note.className = 'stage-fallback';
    note.textContent = "This browser can't show 3D (WebGL is turned off). The readings below still update live, or use the flat 2D view.";
    els.stage.append(note);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  els.stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(7.2, 5.6, 9.2);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.2, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 6;
  controls.maxDistance = 20;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.autoRotate = !reduced.matches;
  controls.autoRotateSpeed = 0.5;
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
  });
  controls.update();

  const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(5, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  const mats = {
    wall: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    back: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    floor: new THREE.MeshStandardMaterial({ roughness: 1 }),
    accent: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }),
    frame: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
    person: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    glass: new THREE.MeshStandardMaterial({ roughness: 0.1, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    haze: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    cloud: new THREE.MeshStandardMaterial({ roughness: 1 }),
    rain: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 }),
    flow: new THREE.PointsMaterial({ size: 0.09, transparent: true, opacity: 0, depthWrite: false }),
  };

  function applyPalette() {
    const p = dark.matches ? PALETTES.dark : PALETTES.light;
    mats.wall.color.set(p.wall);
    mats.back.color.set(p.back);
    mats.floor.color.set(p.floor);
    mats.accent.color.set(p.accent);
    mats.frame.color.set(p.frame);
    mats.person.color.set(p.person);
    mats.glass.color.set(p.glass);
    mats.haze.color.set(p.haze);
    mats.cloud.color.set(p.cloud);
    mats.rain.color.set(p.rain);
    mats.flow.color.set(p.accent);
  }
  applyPalette();
  dark.addEventListener('change', applyPalette);

  const shadowed = (mesh, cast = true) => {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    return mesh;
  };

  // Floor slab
  const floor = shadowed(new THREE.Mesh(new THREE.BoxGeometry(W + 2 * T, 0.1, D + 2 * T), mats.floor), false);
  floor.position.y = -0.05;
  scene.add(floor);

  // Back wall
  const back = shadowed(new THREE.Mesh(new THREE.BoxGeometry(W, H, T), mats.back)); // side walls cover the corners
  back.position.set(0, H / 2, -D / 2 - T / 2);
  scene.add(back);

  // Side walls: a rectangle in (depth, height) with an opening, extruded through the wall.
  function sideWall(hole, x) {
    const shape = new THREE.Shape();
    // shape x maps to world -z, so this spans the room depth plus the back wall's thickness
    shape.moveTo(-D / 2, 0);
    shape.lineTo(D / 2 + T, 0);
    shape.lineTo(D / 2 + T, H);
    shape.lineTo(-D / 2, H);
    shape.lineTo(-D / 2, 0);
    shape.holes.push(hole);
    const mesh = shadowed(new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false }), mats.wall));
    mesh.rotation.y = Math.PI / 2; // shape x -> world -z, extrusion -> world +x
    mesh.position.x = x;
    scene.add(mesh);
  }
  const winHole = new THREE.Path();
  winHole.moveTo(WIN.z0, WIN.y0);
  winHole.lineTo(WIN.z0, WIN.y1);
  winHole.lineTo(WIN.z1, WIN.y1);
  winHole.lineTo(WIN.z1, WIN.y0);
  winHole.lineTo(WIN.z0, WIN.y0);
  sideWall(winHole, -W / 2 - T);
  const fanHole = new THREE.Path();
  fanHole.absarc(0, FAN.y, FAN.r, 0, Math.PI * 2, true);
  sideWall(fanHole, W / 2);

  // Window: a top-hinged sash that swings outward (rotation about the z axis at the top edge).
  const winW = WIN.z1 - WIN.z0;
  const winH = WIN.y1 - WIN.y0;
  const hinge = new THREE.Group();
  hinge.position.set(-W / 2 - T / 2, WIN.y1, (WIN.z0 + WIN.z1) / 2);
  scene.add(hinge);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.03, winH - 0.08, winW - 0.08), mats.glass);
  glass.position.y = -winH / 2;
  hinge.add(glass);
  const bar = (sy, sz, y, z) => {
    const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.06, sy, sz), mats.accent));
    m.position.set(0, y, z);
    hinge.add(m);
  };
  bar(0.06, winW, -0.03, 0);
  bar(0.06, winW, -winH + 0.03, 0);
  bar(winH, 0.06, -winH / 2, -winW / 2 + 0.03);
  bar(winH, 0.06, -winH / 2, winW / 2 - 0.03);
  const hingeRod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, winW + 0.1, 12), mats.frame);
  hingeRod.rotation.x = Math.PI / 2;
  hingeRod.position.copy(hinge.position);
  scene.add(hingeRod);

  // Exhaust fan in the right wall: shroud, guard ring, blades, hub.
  const fanCenter = new THREE.Vector3(W / 2 + T / 2, FAN.y, 0);
  const shroud = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(FAN.r, FAN.r, T + 0.06, 40, 1, true), mats.frame));
  shroud.rotation.z = Math.PI / 2;
  shroud.position.copy(fanCenter);
  shroud.material = mats.frame;
  scene.add(shroud);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(FAN.r, 0.035, 10, 48), mats.frame);
  ring.rotation.y = Math.PI / 2;
  ring.position.copy(fanCenter).add(new THREE.Vector3(-T / 2 - 0.03, 0, 0));
  scene.add(ring);
  const rotor = new THREE.Group();
  rotor.position.copy(fanCenter);
  scene.add(rotor);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.x = (i * Math.PI) / 2;
    const blade = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.34, 0.16), mats.accent));
    blade.position.y = 0.22;
    blade.rotation.y = 0.45; // pitch
    arm.add(blade);
    rotor.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.1, 20), mats.frame);
  hub.rotation.z = Math.PI / 2;
  rotor.add(hub);

  // People
  const people = new THREE.Group();
  scene.add(people);
  const bodyGeo = new THREE.CapsuleGeometry(0.17, 0.55, 4, 12);
  const headGeo = new THREE.SphereGeometry(0.15, 20, 14);

  function drawPeople(count) {
    people.clear();
    const shown = Math.min(count, MAX_PEOPLE_DRAWN);
    for (let i = 0; i < shown; i++) {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = -1.4 + col * 1.0 + (row % 2) * 0.45;
      const z = 1.1 - row * 0.75;
      const body = shadowed(new THREE.Mesh(bodyGeo, mats.person));
      body.position.set(x, 0.45, z);
      const head = shadowed(new THREE.Mesh(headGeo, mats.person));
      head.position.set(x, 1.05, z);
      people.add(body, head);
    }
  }

  // Haze: the room's "breath cloud", thicker as the gas level rises.
  const haze = new THREE.Group();
  scene.add(haze);
  const hazeGeo = new THREE.SphereGeometry(1, 24, 16);
  for (const [x, y, z, r] of [[-1.2, 1.7, 0.2, 1.1], [0.4, 1.9, -0.5, 1.3], [1.6, 1.6, 0.5, 1.0], [-0.2, 1.4, 1.0, 0.9], [0.9, 2.1, 0.9, 0.8]]) {
    const puff = new THREE.Mesh(hazeGeo, mats.haze);
    puff.position.set(x, y, z);
    puff.scale.setScalar(r);
    haze.add(puff);
  }

  // Airflow: particles drifting from the window to the fan, faster with more airflow.
  const curves = [-0.45, 0, 0.45].map(
    (dz, i) =>
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(-W / 2 + 0.05, WIN.y0 + 0.3 + i * 0.25, dz),
        new THREE.Vector3(-1.5, 1.5 + i * 0.2, dz * 2.2 - 0.3),
        new THREE.Vector3(1.4, 1.65 + i * 0.15, dz * 1.6 + 0.2),
        new THREE.Vector3(W / 2 - 0.05, FAN.y + (i - 1) * 0.12, dz * 0.3),
      ]),
  );
  const FLOW_N = 120;
  const flowT = Float32Array.from({ length: FLOW_N }, () => Math.random());
  const flowGeo = new THREE.BufferGeometry();
  flowGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(FLOW_N * 3), 3));
  const flow = new THREE.Points(flowGeo, mats.flow);
  scene.add(flow);

  // Outside: a cloud, and rain when rain is likely.
  const cloud = new THREE.Group();
  for (const [x, y, z, r] of [[0, 0, 0, 0.55], [0.5, -0.1, 0.3, 0.42], [-0.5, -0.12, -0.25, 0.45], [0.15, 0.05, -0.55, 0.4], [-0.2, -0.1, 0.55, 0.38]]) {
    const s = shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mats.cloud), false);
    s.position.set(x, y, z);
    cloud.add(s);
  }
  cloud.position.set(-W / 2 - 1.6, 3.7, 0);
  scene.add(cloud);
  const RAIN_N = 70;
  const rainPos = new Float32Array(RAIN_N * 6);
  const drops = Array.from({ length: RAIN_N }, () => ({
    x: -W / 2 - 0.6 - Math.random() * 2,
    y: Math.random() * 3.3,
    z: -1.4 + Math.random() * 2.8,
  }));
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.Float32BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, mats.rain);
  rain.visible = false;
  scene.add(rain);

  function resize() {
    const w = els.stage.clientWidth;
    const h = els.stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(els.stage);
  resize();

  const tmp = new THREE.Vector3();
  const anchors = {
    window: new THREE.Vector3(-W / 2 - 0.2, WIN.y1 + 0.75, 0),
    fan: new THREE.Vector3(W / 2 + 0.2, FAN.y + 0.95, 0),
  };
  function placeLabel(el, point) {
    tmp.copy(point).project(camera);
    const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
    el.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;
    const x = ((tmp.x + 1) / 2) * els.stage.clientWidth;
    const y = ((1 - tmp.y) / 2) * els.stage.clientHeight;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  Object.assign(scene3d, {
    ok: true,
    renderer,
    scene,
    camera,
    controls,
    hinge,
    rotor,
    haze,
    flow,
    flowGeo,
    flowT,
    curves,
    rain,
    rainGeo,
    drops,
    mats,
    drawPeople,
    placeLabel,
    anchors,
  });
}

// ---------- incoming data

function onRoom(room) {
  if (!room || room.id !== roomId) return;
  const ts = room.lastSeen?.controller ?? null;
  if (ts && ts !== state.controllerTs) {
    // On first load, count the age the server reports, so a stale room starts in fail-safe.
    const age = state.room === null ? Math.max(0, Date.now() - ts) : 0;
    state.lastCmdAt = performance.now() - age;
  }
  state.controllerTs = ts;
  const first = state.room === null;
  state.room = room;
  if (first) {
    document.title = `${room.name} · 3D model room · Nimbus`;
    set($('#title'), `${room.name}: 3D model room`);
    set($('#back-text'), `${room.name} dashboard`);
    $('#back').href = `/#/room/${encodeURIComponent(room.id)}`;
    $('#view-2d').href = `/model.html#${encodeURIComponent(room.id)}`;
  }
  const count = isNum(room.people) ? Math.max(0, Math.round(room.people)) : 0;
  if (scene3d.ok && count !== state.peopleDrawn) {
    state.peopleDrawn = count;
    scene3d.drawPeople(count);
  }
}

// ---------- animation

function frame(now) {
  const dt = state.lastFrame === null ? 0 : Math.min(0.1, (now - state.lastFrame) / 1000);
  state.lastFrame = now;
  const t = target(now);
  state.target = t;

  const flapGoal = (t.window / 100) * MAX_FLAP_DEG;
  if (reduced.matches) {
    state.flapDeg = flapGoal;
    state.fan = t.fan;
  } else {
    const step = FLAP_DEG_PER_S * dt;
    const d = flapGoal - state.flapDeg;
    state.flapDeg = Math.abs(d) <= step ? flapGoal : state.flapDeg + Math.sign(d) * step;
    state.fan += (t.fan - state.fan) * (1 - Math.exp(-dt / FAN_TAU_S));
    if (Math.abs(t.fan - state.fan) < 0.05) state.fan = t.fan;
  }
  state.haze += (hazeFor(state.room) - state.haze) * (1 - Math.exp(-dt / 1.5));

  if (scene3d.ok) {
    const s = scene3d;
    const openFrac = state.flapDeg / MAX_FLAP_DEG;
    const airflow = clamp((state.fan + openFrac * 50) / 100, 0, 1);

    s.hinge.rotation.z = -THREE.MathUtils.degToRad(state.flapDeg); // negative = swings outward
    if (!reduced.matches) s.rotor.rotation.x += THREE.MathUtils.degToRad((state.fan / 100) * SPIN_DEG_PER_S) * dt;

    s.mats.haze.opacity = 0.16 * state.haze;
    if (!reduced.matches) {
      s.haze.position.x = Math.sin(now / 2600) * 0.25;
      s.haze.position.z = Math.cos(now / 3300) * 0.15;
    }

    s.mats.flow.opacity = airflow > 0.01 ? 0.3 + 0.6 * airflow : 0;
    const pos = s.flowGeo.attributes.position;
    const speed = reduced.matches ? 0 : 0.04 + 0.3 * airflow;
    for (let i = 0; i < s.flowT.length; i++) {
      s.flowT[i] = (s.flowT[i] + speed * dt) % 1;
      const p = s.curves[i % s.curves.length].getPointAt(s.flowT[i]);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;

    const wet = raining();
    s.rain.visible = wet;
    if (wet) {
      const rp = s.rainGeo.attributes.position;
      s.drops.forEach((drop, i) => {
        if (!reduced.matches) {
          drop.y -= 4.5 * dt;
          if (drop.y < 0) drop.y += 3.3;
        }
        rp.setXYZ(i * 2, drop.x, drop.y, drop.z);
        rp.setXYZ(i * 2 + 1, drop.x + 0.03, drop.y - 0.2, drop.z);
      });
      rp.needsUpdate = true;
    }

    s.controls.update();
    s.renderer.render(s.scene, s.camera);
    s.placeLabel(els.labelWindow, s.anchors.window);
    s.placeLabel(els.labelFan, s.anchors.fan);
  }

  if (now - state.lastText > 200) {
    state.lastText = now;
    renderText(t);
  }
  requestAnimationFrame(frame);
}

// ---------- text

function renderText(t) {
  const room = state.room;
  if (!room) return;
  const windowPct = Math.round((state.flapDeg / MAX_FLAP_DEG) * 100);
  const windowText = windowPct === 0 ? 'Closed' : `${windowPct}% open`;
  const fanPct = Math.round(state.fan);
  const unit = state.config?.airQuality?.unit || '';
  const forced = isNum(state.status?.forcedRain);

  set(els.windowCap, windowText);
  set(els.fanCap, `${fanPct}%`);

  let status;
  let statusState;
  let chip = '';
  if (t.waiting) {
    statusState = 'waiting';
    status = 'Waiting for the first decision from the controller. Holding the safe state: window closed, fan 50%.';
    chip = 'WAITING FOR COMMANDS';
  } else if (t.failsafe) {
    statusState = 'failsafe';
    status = 'Fail-safe: no decision from the server for over 10 s, so the window is closed and the fan runs at 50%.';
    chip = 'FAIL-SAFE';
  } else if (!state.connected) {
    statusState = 'lost';
    status = 'Lost the server. Holding the last decision until the 10 s fail-safe.';
  } else {
    statusState = 'live';
    status = "Following the controller live: the same decisions the Pi's fan and servo would get.";
  }
  els.status.dataset.state = statusState;
  set(els.status, status);
  els.chip.hidden = !chip;
  set(els.chip, chip);

  let reason = room.reason || 'Waiting for the controller to make its first decision.';
  if (t.waiting) reason = 'Waiting for the first decision. Until then the window stays closed and the fan runs at 50%.';
  else if (t.failsafe) reason = 'No decision from the server for 10 s, so the window is closed and the fan is at 50% to be safe.';
  set(els.reason, reason);

  set(field('people'), isNum(room.people) ? room.people : '–');
  set(field('people-sub'), isNum(room.booked) && room.booked > 0 ? `${room.booked} booked` : isNum(room.capacity) ? `Seats ${room.capacity}` : '');
  set(field('aq-label'), state.config?.airQuality?.label || 'Air quality');
  set(field('aq'), isNum(room.aq) ? `${fmt(room.aq)}${unit ? ` ${unit}` : ''}` : '–');
  set(field('aq-sub'), isNum(room.aq) ? airWord(room.aq) : 'Waiting for data');
  set(field('fan'), `${fanPct}%`);
  set(field('fan-sub'), fanPct > 0 ? `About ${fmt(fanPct * RPM_PER_PCT)} rpm` : 'Stopped');
  set(field('window'), windowText);
  set(field('window-sub'), `Sash at ${Math.round(state.flapDeg)}°`);

  const manual = !t.failsafe && room.mode === 'manual';
  $('#manual-tag').hidden = !manual;
  if (t.waiting) {
    set(field('mode'), 'Waiting');
    set(field('mode-sub'), 'Safe state until the first decision');
  } else if (t.failsafe) {
    set(field('mode'), 'Fail-safe');
    set(field('mode-sub'), 'Window closed, fan 50%');
  } else if (manual) {
    set(field('mode'), 'Manual hold');
    set(field('mode-sub'), room.override?.expiresAt ? `Until ${fmtTime(room.override.expiresAt)}` : 'Set from the dashboard');
  } else {
    set(field('mode'), 'Automatic');
    set(field('mode-sub'), 'Following the controller');
  }

  set(field('rain'), isNum(room.rainChance) ? `${room.rainChance}%` : '–');
  set(field('rain-sub'), forced ? 'Demo setting' : raining() ? 'Rain likely' : isNum(room.rainChance) ? 'Dry' : '');

  els.stage.setAttribute(
    'aria-label',
    `3D simulated model room: fan at ${fanPct}%, window ${windowText.toLowerCase()}, ` +
      `${isNum(room.people) ? room.people : 'unknown number of'} people` +
      `${isNum(room.aq) ? `, ${(state.config?.airQuality?.label || 'air quality').toLowerCase()} ${fmt(room.aq)}` : ''}.`,
  );
}

function setLive(mode) {
  $('#live').dataset.state = mode;
  set($('#live-text'), mode === 'live' ? 'Live' : mode === 'lost' ? 'Reconnecting' : 'Connecting');
}

// ---------- start

async function start() {
  buildScene();
  try {
    state.config = await getJson('/api/config');
    onRoom(await getJson(`/api/rooms/${encodeURIComponent(roomId)}`));
  } catch (e) {
    set(els.reason, `Can't load "${roomId}": ${e.message} Check the server is running and the room id after # in the address.`);
    set(els.status, 'Not connected.');
    return;
  }
  const socket = window.io();
  socket.on('connect', async () => {
    state.connected = true;
    setLive('live');
    try {
      onRoom(await getJson(`/api/rooms/${encodeURIComponent(roomId)}`));
    } catch (e) {
      console.error(e);
    }
  });
  socket.on('disconnect', () => {
    state.connected = false;
    setLive('lost');
  });
  socket.on('room', onRoom);
  socket.on('status', (s) => {
    state.status = s;
  });
  window.addEventListener('hashchange', () => location.reload());
  requestAnimationFrame(frame);
}

start();
