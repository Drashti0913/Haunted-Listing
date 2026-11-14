import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

// =====================================================================  setup
const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080d);
scene.fog = new THREE.FogExp2(0x07080d, 0.006);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 2000);
const controls = new PointerLockControls(camera, document.body);
const clock = new THREE.Clock();
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let run = null;          // run state from the server
let since = 0;           // director commands already applied
let mode = "title";      // title | flyin | intro | play | ended
let L = null;            // floor plan
let currentFloor = 0;
const player = { hp: 100, battery: 100, maxBattery: 100, speed: 1, beamDps: 45, beam: false,
                 captures: 0, collected: 0, upgrades: new Set(), startedAt: 0, lastHurt: 0 };

// =====================================================================  helpers
async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) } : {});
  if (!r.ok) { let m = await r.text(); try { m = JSON.parse(m).detail; } catch {} throw new Error(m); }
  return r.json();
}
function label(text, { color = "#e9e6f2", size = 48, bg = "rgba(7,8,13,0.7)" } = {}) {
  const c = document.createElement("canvas"); const ctx = c.getContext("2d");
  ctx.font = `600 ${size}px Inter, sans-serif`;
  const w = ctx.measureText(text).width + 40; c.width = w; c.height = size + 28;
  ctx.font = `600 ${size}px Inter, sans-serif`;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, c.height, 16); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(text, 20, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(0.32 * c.width / c.height, 0.32, 1); s.renderOrder = 10;
  return s;
}
const hash = (str) => { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const money = (c) => "$" + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// =====================================================================  sound (WebAudio, no files)
let AC = null, hum = null, humGain = null;
function initAudio() {
  if (AC) return;
  AC = new (window.AudioContext || window.webkitAudioContext)();
  hum = AC.createOscillator(); hum.type = "sawtooth"; hum.frequency.value = 110;
  humGain = AC.createGain(); humGain.gain.value = 0;
  const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 700;
  hum.connect(f).connect(humGain).connect(AC.destination); hum.start();
}
function tone(freq, dur, type = "sine", vol = 0.2, slide = 0) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime;
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur);
}
function noise(dur, vol = 0.25, freq = 900) {
  if (!AC) return;
  const b = AC.createBuffer(1, AC.sampleRate * dur, AC.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = AC.createBufferSource(); s.buffer = b;
  const f = AC.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 2;
  const g = AC.createGain(); g.gain.value = vol;
  s.connect(f).connect(g).connect(AC.destination); s.start();
}
const sfx = {
  scream: () => { noise(1.2, 0.35, 1400); tone(900, 1.1, "sawtooth", 0.08, -600); },
  capture: () => { tone(660, 0.15, "triangle", 0.2); setTimeout(() => tone(990, 0.25, "triangle", 0.2), 120); },
  pickup: () => { tone(520, 0.2, "sine", 0.18, 400); },
  hurt: () => { noise(0.25, 0.3, 300); },
  cash: () => { tone(1320, 0.08, "square", 0.08); setTimeout(() => tone(1760, 0.12, "square", 0.08), 80); },
  beat: () => { tone(55, 0.18, "sine", 0.5); },
};

// =====================================================================  outside (title + fly-in)
const outside = new THREE.Group(); scene.add(outside);
const moon = new THREE.DirectionalLight(0x9fb4ff, 1.4); moon.position.set(-120, 200, 80);
const ambient = new THREE.AmbientLight(0x404060, 0.6);
scene.add(moon, ambient);

function buildOutside(aerialUrl, building) {
  outside.clear();
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x15161f, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), groundMat);
  ground.rotation.x = -Math.PI / 2; outside.add(ground);
  if (aerialUrl) new THREE.TextureLoader().setCrossOrigin("anonymous").load(aerialUrl, (t) => {   // Vexcel
    t.colorSpace = THREE.SRGBColorSpace; groundMat.map = t; groundMat.color.set(0xffffff); groundMat.needsUpdate = true; });
  const rnd = mulberry(building ? hash(building.id) : 7);
  const box = new THREE.BoxGeometry(1, 1, 1);
  for (let gx = -8; gx <= 8; gx++) for (let gz = -8; gz <= 8; gz++) {
    if ((Math.abs(gx) <= 1 && Math.abs(gz) <= 1) || gx % 3 === 0 || gz % 3 === 0) continue;
    const h = 6 + rnd() * (rnd() > 0.85 ? 90 : 30);
    const m = new THREE.Mesh(box, new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.65, 0.18, 0.14 + rnd() * 0.12), emissive: rnd() > 0.7 ? 0x22344a : 0x0b0d14 }));
    m.scale.set(14 + rnd() * 8, h, 14 + rnd() * 8); m.position.set(gx * 26, h / 2, gz * 26); outside.add(m);
  }
  const floors = building?.floors || 3;
  const target = new THREE.Mesh(new THREE.BoxGeometry(24, floors * 4, 16),
    new THREE.MeshStandardMaterial({ color: 0x2a2f45, emissive: 0x145c45 }));
  target.position.set(0, floors * 2, 0);
  target.add(new THREE.LineSegments(new THREE.EdgesGeometry(target.geometry), new THREE.LineBasicMaterial({ color: 0x7cf3c4 })));
  const beacon = new THREE.PointLight(0x7cf3c4, 400, 120, 1.5); beacon.position.set(0, floors * 4 + 10, 0);
  outside.add(target, beacon);
}
function flyIn(done) {
  mode = "flyin"; const t0 = performance.now();
  const from = new THREE.Vector3(160, 260, 220), to = new THREE.Vector3(0, 7, 34), look = new THREE.Vector3(0, 6, 0);
  const step = () => {
    const k = (performance.now() - t0) / 5000;
    camera.position.lerpVectors(from, to, ease(Math.min(k, 1))); camera.lookAt(look);
    if (k < 1) requestAnimationFrame(step); else done();
  };
  step();
}

// =====================================================================  interior
const interior = new THREE.Group(); interior.visible = false; scene.add(interior);
const floorGroups = [], roomLights = [];
let roomMap = {};
const DOOR = 1.8, DOOR_H = 2.6, T = 0.2;
const flashlight = new THREE.SpotLight(0xfff1d6, 22, 20, Math.PI / 6, 0.5, 1.4);
camera.add(flashlight); camera.add(flashlight.target);
flashlight.position.set(0.2, -0.1, 0); flashlight.target.position.set(0, 0, -1); flashlight.visible = false;
scene.add(camera);
const beamMesh = new THREE.Mesh(new THREE.ConeGeometry(1.6, 10, 24, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xb18cff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
beamMesh.rotation.x = Math.PI / 2; beamMesh.position.set(0.25, -0.25, -5.2); beamMesh.visible = false;
camera.add(beamMesh);
const PALETTE = { office: [0x2b3040, 0x3a3f52], multifamily: [0x3b2f2a, 0x4a3b33], retail: [0x2a3b3a, 0x354a47] };
let exitSign = null, atmMesh = null;
const itemMeshes = {};

function buildInterior() {
  interior.clear(); floorGroups.length = 0; roomLights.length = 0; roomMap = {};
  L = run.layout;
  const W = L.room_w, D = L.room_d, H = L.floor_h - 0.4;
  const [wallC, wallC2] = PALETTE[run.building.property_type] || PALETTE.office;
  const wallMat = new THREE.MeshStandardMaterial({ color: wallC, roughness: 0.95 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x111218, side: THREE.DoubleSide });
  for (const r of L.rooms) roomMap[`${r.floor}:${r.col}:${r.row}`] = r;
  for (let f = 0; f < L.floors; f++) { const g = new THREE.Group(); g.visible = false; interior.add(g); floorGroups.push(g); }
  for (const r of L.rooms) {
    const g = floorGroups[r.floor], cx = r.x + W / 2, cz = r.z + D / 2, y = r.y;
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(wallC2).offsetHSL((hash(r.id) % 10) / 100, 0, 0), roughness: 0.8 }));
    fl.rotation.x = -Math.PI / 2; fl.position.set(cx, y, cz); g.add(fl);
    const ce = fl.clone(); ce.material = ceilMat; ce.position.y = y + H; g.add(ce);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nb = roomMap[`${r.floor}:${r.col + dx}:${r.row + dz}`];
      if (nb && (dx < 0 || dz < 0)) continue;
      const vertical = dx !== 0;
      addWall(g, wallMat, dx === 0 ? cx : (dx < 0 ? r.x : r.x + W), dz === 0 ? cz : (dz < 0 ? r.z : r.z + D),
        y, vertical ? D : W, H, vertical, !!nb);
    }
    const nm = label(r.name, { color: r.name === "Stairwell" ? "#7cf3c4" : "#e9e6f2" });
    nm.position.set(cx, y + H - 0.5, cz); g.add(nm);
    if (r.name === "Stairwell") {
      addStairs(g, cx, cz, y);
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.6, D - 0.6),
        new THREE.MeshBasicMaterial({ color: 0x7cf3c4, transparent: true, opacity: 0.12 }));
      pad.rotation.x = -Math.PI / 2; pad.position.set(cx, y + 0.02, cz); g.add(pad);
      const sign = label(`STAIRS ↑↓  ·  E up  ·  Q down`, { color: "#7cf3c4", size: 64 });
      sign.position.set(cx, y + 2.4, cz); g.add(sign);
      const glow = new THREE.PointLight(0x7cf3c4, 4, 9, 1.4); glow.position.set(cx, y + 2.6, cz); g.add(glow);
    }
    const pl = new THREE.PointLight(0xffc98a, 6, 14, 1.2);
    pl.position.set(cx, y + H - 0.4, cz); pl.userData = { seed: hash(r.id) % 100, floor: r.floor, base: 6 };
    g.add(pl); roomLights.push(pl);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    bulb.position.copy(pl.position); g.add(bulb);
  }
  // exit door + ATM in the entrance room
  const ex = L.rooms.find((r) => r.id === run.exit_room);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.5, 0.1), new THREE.MeshStandardMaterial({ color: 0x3b2414, emissive: 0x1a0d05 }));
  door.position.set(ex.x + W / 2, 1.25, ex.z + 0.12); floorGroups[0].add(door);
  exitSign = label("EXIT · locked (collect all objects)", { color: "#ff8095" });
  exitSign.position.set(ex.x + W / 2, 2.85, ex.z + 0.3); floorGroups[0].add(exitSign);
  atmMesh = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.7, 0.6), new THREE.MeshStandardMaterial({ color: 0x0b1f4a }));
  body.position.y = 0.85;
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), new THREE.MeshBasicMaterial({ color: 0x3d8bff }));
  scr.position.set(0, 1.25, 0.31);
  const tag = label("Capital One ATM", { color: "#9cc3ff" }); tag.position.y = 2.05;
  atmMesh.add(body, scr, tag);
  atmMesh.position.set(ex.x + W - 0.6, 0, ex.z + D / 2); atmMesh.rotation.y = -Math.PI / 2;
  floorGroups[0].add(atmMesh);
  for (const it of run.items) placeItem(it);   // cursed objects
}
function addWall(g, mat, px, pz, y, len, H, vertical, door) {
  const seg = (c, l, h, yy) => { const m = new THREE.Mesh(new THREE.BoxGeometry(vertical ? T : l, h, vertical ? l : T), mat);
    m.position.set(vertical ? px : px + c, yy, vertical ? pz + c : pz); g.add(m); };
  if (!door) return seg(0, len, H, y + H / 2);
  const side = (len - DOOR) / 2;
  seg(-(DOOR / 2 + side / 2), side, H, y + H / 2); seg(DOOR / 2 + side / 2, side, H, y + H / 2);
  seg(0, DOOR, H - DOOR_H, y + DOOR_H + (H - DOOR_H) / 2);
}
function addStairs(g, cx, cz, y) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a4f63 });
  for (let i = 0; i < 8; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(2, 0.25, 0.6), mat);
    s.position.set(cx + 2, y + 0.125 + i * 0.25, cz - 2.4 + i * 0.6); g.add(s); }
}
function roomById(id) { return L.rooms.find((r) => r.id === id); }
function spot(roomId, salt = 0, spread = 2.4) {
  const r = roomById(roomId), a = ((hash(roomId) + salt * 137) % 360) * Math.PI / 180;
  return new THREE.Vector3(r.x + L.room_w / 2 + Math.cos(a) * spread, r.y, r.z + L.room_d / 2 + Math.sin(a) * spread);
}
function placeItem(it) {
  let m = itemMeshes[it.id];
  if (it.collected) { if (m) { interior.remove(m); delete itemMeshes[it.id]; } return; }
  if (!m) {
    m = new THREE.Mesh(new THREE.TorusKnotGeometry(0.16, 0.05, 64, 8),
      new THREE.MeshStandardMaterial({ color: 0xc58cff, emissive: 0x8a3dff, emissiveIntensity: 1.6 }));
    interior.add(m); itemMeshes[it.id] = m;
  }
  const p = spot(it.room, hash(it.id), 2.6);
  m.position.set(p.x, p.y + 1.0, p.z); m.userData = { id: it.id, floor: roomById(it.room).floor };
}
function setFloor(f) {
  currentFloor = f;
  floorGroups.forEach((g, i) => (g.visible = i === f));
  for (const m of Object.values(itemMeshes)) m.visible = m.userData.floor === f;
  for (const g of ghosts.values()) g.mesh.visible = g.floor === f;
  camera.position.y = f * L.floor_h + 1.6;
}
function roomAt(x, z, f = currentFloor) {
  return L.rooms.find((r) => r.floor === f && x >= r.x && x < r.x + L.room_w && z >= r.z && z < r.z + L.room_d);
}
function canBe(x, z) {
  const r = roomAt(x, z); if (!r) return false;
  const W = L.room_w, D = L.room_d, m = 0.35, half = DOOR / 2 - 0.25, lx = x - r.x, lz = z - r.z;
  const has = (dx, dz) => !!roomMap[`${r.floor}:${r.col + dx}:${r.row + dz}`];
  if (lx < m && !(has(-1, 0) && Math.abs(lz - D / 2) < half)) return false;
  if (lx > W - m && !(has(1, 0) && Math.abs(lz - D / 2) < half)) return false;
  if (lz < m && !(has(0, -1) && Math.abs(lx - W / 2) < half)) return false;
  if (lz > D - m && !(has(0, 1) && Math.abs(lx - W / 2) < half)) return false;
  return true;
}

// =====================================================================  ghosts (real-time AI on the client)
const ghosts = new Map();
function makeGhostMesh(kind) {
  const g = new THREE.Group();
  const colors = { wisp: 0x8ff7ff, poltergeist: 0xb6ffb0, banshee: 0xffd0dc };
  const mat = new THREE.MeshStandardMaterial({ color: colors[kind], emissive: colors[kind], emissiveIntensity: 0.6,
    transparent: true, opacity: 0.75, depthWrite: false });
  const eye = new THREE.MeshBasicMaterial({ color: 0x000000 });
  if (kind === "wisp") {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), mat); b.position.y = 1.5; g.add(b);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 12), mat); tail.position.y = 1.0; tail.rotation.x = Math.PI; g.add(tail);
  } else {
    const tall = kind === "banshee" ? 1.6 : 1.0;
    const robe = new THREE.Mesh(new THREE.ConeGeometry(kind === "banshee" ? 0.7 : 0.45, 1.6 * tall, 16, 1, true), mat);
    robe.position.y = 0.8 * tall + 0.2; g.add(robe);
    const head = new THREE.Mesh(new THREE.SphereGeometry(kind === "banshee" ? 0.38 : 0.3, 16, 12), mat);
    head.position.y = 1.6 * tall + 0.35; g.add(head);
    for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.06), eye);
      e.position.set(s * 0.11, head.position.y + 0.04, 0.27 * (kind === "banshee" ? 1.25 : 1)); g.add(e); }
  }
  g.userData.mat = mat;
  return g;
}
function spawnGhost(def, announce = true) {
  if (ghosts.has(def.id)) return;
  const room = roomById(def.room), mesh = makeGhostMesh(def.kind);
  mesh.position.copy(spot(def.room, ghosts.size + 3, 1.8)); mesh.scale.setScalar(0.01); interior.add(mesh);
  const gh = { ...def, maxHp: def.hp, floor: room.floor, mesh, target: null, wanderTo: null, born: performance.now(), dying: 0 };
  ghosts.set(def.id, gh); mesh.visible = gh.floor === currentFloor;
  if (announce && mode === "play") {
    logEntry(`${def.label} materialized in the ${room.name} (floor ${room.floor + 1})`, "bad");
    if (room.floor === currentFloor) sfx.scream();
  }
}
function ghostTick(gh, dt, t) {
  const m = gh.mesh, p = camera.position;
  if (gh.dying) {
    gh.dying += dt; m.scale.setScalar(Math.max(0.01, 1 - gh.dying * 1.4)); m.position.y += dt * 2;
    m.userData.mat.opacity = Math.max(0, 0.75 - gh.dying);
    if (gh.dying > 0.8) { interior.remove(m); ghosts.delete(gh.id); }
    return;
  }
  const grow = Math.min(1, (performance.now() - gh.born) / 900);
  m.scale.setScalar(grow * (0.6 + 0.4 * Math.max(0, gh.hp) / gh.maxHp));
  const sameFloor = gh.floor === currentFloor && mode === "play";
  const dist = sameFloor ? Math.hypot(m.position.x - p.x, m.position.z - p.z) : 99;
  const sense = gh.kind === "banshee" ? 99 : gh.kind === "poltergeist" ? 11 : 8;
  let goal = null, speed = gh.speed;
  if (gh.target) {                                   // the director sent this ghost somewhere
    const tr = roomById(gh.target);
    if (tr.floor !== gh.floor) {                     // ghosts phase through floors
      gh.floor = tr.floor; m.position.copy(spot(gh.target, 9, 2)); m.visible = gh.floor === currentFloor;
      gh.born = performance.now();
    }
    goal = new THREE.Vector3(tr.x + L.room_w / 2, 0, tr.z + L.room_d / 2);
    if (Math.hypot(goal.x - m.position.x, goal.z - m.position.z) < 1.2 || dist < sense) gh.target = null;
  }
  if (dist < sense) goal = new THREE.Vector3(p.x, 0, p.z);
  else if (!goal) {                                  // wander between rooms
    if (!gh.wanderTo || Math.hypot(gh.wanderTo.x - m.position.x, gh.wanderTo.z - m.position.z) < 0.8) {
      const rooms = L.rooms.filter((r) => r.floor === gh.floor);
      gh.wanderTo = spot(rooms[Math.floor(Math.random() * rooms.length)].id, Math.random() * 99, 2);
    }
    goal = gh.wanderTo; speed *= 0.45;
  }
  const dx = goal.x - m.position.x, dz = goal.z - m.position.z, len = Math.hypot(dx, dz);
  if (len > 0.05) { m.position.x += dx / len * speed * dt; m.position.z += dz / len * speed * dt; }
  m.position.y = gh.floor * L.floor_h + Math.sin(t * 2 + hash(gh.id)) * 0.12;
  m.lookAt(p.x, m.position.y, p.z);
  m.userData.mat.opacity = 0.55 + 0.25 * Math.sin(t * 7 + hash(gh.id));
  if (sameFloor && dist < 1.1) hurt(gh.dps * dt);
  if (sameFloor && dist < 6 && t - (gh.lastBeat || 0) > 0.9 - (6 - dist) * 0.08) { gh.lastBeat = t; sfx.beat(); }
}

// =====================================================================  UV beam
function beamTick(dt) {
  const firing = player.beam && player.battery > 0 && mode === "play";
  beamMesh.visible = firing;
  flashlight.color.set(firing ? 0xb18cff : 0xfff1d6); flashlight.intensity = firing ? 40 : 22;
  if (humGain) humGain.gain.setTargetAtTime(firing ? 0.06 : 0, AC.currentTime, 0.05);
  if (firing) player.battery = Math.max(0, player.battery - 20 * dt);
  else player.battery = Math.min(player.maxBattery, player.battery + 9 * dt);
  if (!firing) return;
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
  for (const gh of ghosts.values()) {
    if (gh.dying || gh.floor !== currentFloor) continue;
    const to = new THREE.Vector3().subVectors(gh.mesh.position, camera.position); to.y += 1.2;
    if (to.length() > 11 || fwd.angleTo(to) > 0.24) continue;
    gh.hp -= player.beamDps * dt;
    gh.mesh.userData.mat.emissiveIntensity = 2.2;
    setTimeout(() => (gh.mesh.userData.mat.emissiveIntensity = 0.6), 60);
    if (gh.hp <= 0) captureGhost(gh);
  }
}
async function captureGhost(gh) {
  gh.dying = 0.01; player.captures++; sfx.capture();
  const bounty = run.ghost_types[gh.kind].bounty;
  logEntry(`Captured ${gh.label}! Bounty ${money(bounty)} → paying via Capital One…`, "good");
  try { applyState(await api(`/api/runs/${run.id}/capture`, { ghost_id: gh.id, since })); sfx.cash(); }
  catch (e) { logEntry("Bank error: " + e.message, "bad"); }
}

// =====================================================================  player
function hurt(amount) {
  if (mode !== "play") return;
  player.hp = Math.max(0, player.hp - amount);
  $("hurt").style.opacity = 1; clearTimeout(hurt.t); hurt.t = setTimeout(() => ($("hurt").style.opacity = 0), 180);
  const now = performance.now(); if (now - player.lastHurt > 600) { sfx.hurt(); player.lastHurt = now; }
  if (player.hp <= 0) finish("dead");
}
const keys = {};
addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (mode !== "play") return;
  if (e.code === "Space") { player.beam = true; e.preventDefault(); }
  const k = (e.key || "").toLowerCase();
  if (e.code === "KeyE" || k === "e") interact("up");
  if (e.code === "KeyQ" || k === "q") interact("down");
});
addEventListener("keyup", (e) => { keys[e.code] = false; if (e.code === "Space") player.beam = false; });
let noLock = false, drag = null;
const euler = new THREE.Euler(0, 0, 0, "YXZ");
document.addEventListener("pointerlockerror", () => { noLock = true; show("paused", false); });
canvas.addEventListener("mousedown", (e) => {
  if (mode !== "play") return;
  if (controls.isLocked) player.beam = true; else drag = { x: e.clientX, y: e.clientY };
});
addEventListener("mouseup", () => { drag = null; if (controls.isLocked) player.beam = false; });
addEventListener("mousemove", (e) => {
  if (!drag) return;
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= (e.clientX - drag.x) * 0.005;
  euler.x = Math.max(-1.4, Math.min(1.4, euler.x - (e.clientY - drag.y) * 0.005));
  camera.quaternion.setFromEuler(euler); drag = { x: e.clientX, y: e.clientY };
});
const panelsOpen = () => ["atm", "scan"].some((id) => !$(id).classList.contains("hidden"));
controls.addEventListener("unlock", () => { player.beam = false; if (mode === "play" && !panelsOpen() && !noLock) show("paused"); });
controls.addEventListener("lock", () => show("paused", false));
$("paused").addEventListener("click", () => controls.lock());

function move(dt) {
  if ((!controls.isLocked && !noLock) || panelsOpen()) return;
  const sprint = keys.ShiftLeft || keys.ShiftRight;
  const speed = (sprint ? 6.2 : 3.9) * player.speed * dt;
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize(), v = new THREE.Vector3();
  if (keys.KeyW || keys.ArrowUp) v.add(fwd);
  if (keys.KeyS || keys.ArrowDown) v.sub(fwd);
  if (keys.KeyD || keys.ArrowRight) v.add(right);
  if (keys.KeyA || keys.ArrowLeft) v.sub(right);
  if (!v.lengthSq()) return;
  v.normalize().multiplyScalar(speed);
  const p = camera.position;
  if (canBe(p.x + v.x, p.z)) p.x += v.x;
  if (canBe(p.x, p.z + v.z)) p.z += v.z;
}
function nearby() {
  const p = camera.position, r = roomAt(p.x, p.z);
  if (currentFloor === 0 && atmMesh && Math.hypot(atmMesh.position.x - p.x, atmMesh.position.z - p.z) < 1.8) return { kind: "atm" };
  const ex = roomById(run.exit_room);
  if (currentFloor === 0 && r?.id === ex.id && p.z - ex.z < 1.6 && Math.abs(p.x - (ex.x + L.room_w / 2)) < 1.5) return { kind: "exit" };
  if (r?.name === "Stairwell") return { kind: "stairs" };
  return null;
}
function interact(dir) {
  const t = nearby(); if (!t) return;
  if (t.kind === "atm") openAtm();
  if (t.kind === "exit") {
    if (player.collected >= run.items.length) finish("escaped");
    else taunt(`The door won't open. ${run.items.length - player.collected} objects left.`);
  }
  if (t.kind === "stairs") {
    const up = currentFloor + 1 < L.floors, down = currentFloor > 0, from = currentFloor;
    if (dir === "up" && up) setFloor(currentFloor + 1);
    else if (dir === "down" && down) setFloor(currentFloor - 1);
    else taunt(dir === "up" ? "Top floor. Press Q to go down." : "Ground floor. Press E to go up.");
    if (currentFloor !== from) {
      tone(currentFloor > from ? 440 : 330, 0.25, "triangle", 0.15, currentFloor > from ? 220 : -110);
      taunt(`Floor ${currentFloor + 1} of ${L.floors}`);
    }
  }
}
function pickupTick() {
  const p = camera.position;
  for (const [id, m] of Object.entries(itemMeshes)) {
    if (m.userData.floor !== currentFloor) continue;
    if (Math.hypot(m.position.x - p.x, m.position.z - p.z) < 1.3) {
      interior.remove(m); delete itemMeshes[id];
      player.collected++; sfx.pickup();
      const it = run.items.find((x) => x.id === id); it.collected = true;
      logEntry(`✦ ${it.name}: ${it.lore}`, "good");
      if (player.collected >= run.items.length) {
        taunt("All objects taken. RUN to the exit!");
        floorGroups[0].remove(exitSign);
        exitSign = label("EXIT · open", { color: "#7cf3c4" });
        const ex = roomById(run.exit_room); exitSign.position.set(ex.x + L.room_w / 2, 2.85, ex.z + 0.3);
        floorGroups[0].add(exitSign);
      }
      api(`/api/runs/${run.id}/collect`, { item_id: id, since }).catch(() => {});
    }
  }
}

// =====================================================================  live director + wallet
function applyState(state) {
  for (const c of state.commands) applyCommand(c);
  since += state.commands.length;
  renderWallet(state.wallet);
  $("director").classList.toggle("busy", state.director.busy);
  $("d-text").textContent = (state.director.mode === "ai" ? "AI Director (LangChain deepagents)" : "Director (rules)") +
    (state.director.busy ? " · deciding…" : state.director.last ? ` · ${state.director.last}` : " · watching");
}
function applyCommand(c) {
  if (c.kind === "spawn") spawnGhost(c.ghost);
  if (c.kind === "send") { const g = ghosts.get(c.ghost_id); if (g) g.target = c.room; }
  if (c.kind === "flicker") blackout(c.floor, c.seconds);
  if (c.kind === "taunt") taunt(c.text);
  if (c.kind === "move_item") {
    const it = run.items.find((x) => x.id === c.item_id);
    if (it && itemMeshes[it.id]) { it.room = c.room; placeItem(it); setFloor(currentFloor);
      logEntry(`You hear something being dragged… the ${it.name} moved.`, "bad"); }
  }
}
let blackoutUntil = 0, blackoutFloor = -1;
function blackout(floor, seconds) {
  blackoutFloor = floor; blackoutUntil = performance.now() + seconds * 1000;
  if (floor === currentFloor) { noise(0.6, 0.2, 200); logEntry("The lights die.", "bad"); }
}
function taunt(text) {
  const el = $("taunt"); el.textContent = text; el.classList.add("on");
  clearTimeout(taunt.t); taunt.t = setTimeout(() => el.classList.remove("on"), 3200);
}
const walletCents = (w) => w.earned - w.spent;   // bounty you can still spend
function renderWallet(w) {
  $("w-mode").textContent = w.live ? "● LIVE Nessie" : "○ local (add NESSIE_API_KEY)";
  $("w-balance").textContent = money(walletCents(w));
  $("w-tx").textContent = (w.live ? `Checking ${money(w.balance)}` + (w.pending ? ` (+${money(w.pending)} settling)` : "") +
    ` · Card spent ${money(w.spent)}` : "") + (w.last_tx ? ` · ${w.last_tx.kind} ${w.last_tx.id}` : "");
  $("atm-balance").textContent = money(walletCents(w));
  run.wallet = w;
}
let ticking = false;
async function directorTick() {
  if (mode !== "play" || ticking) return;
  ticking = true;
  const p = camera.position, r = roomAt(p.x, p.z);
  const near = [...ghosts.values()].filter((g) => g.floor === currentFloor && !g.dying &&
    Math.hypot(g.mesh.position.x - p.x, g.mesh.position.z - p.z) < 8).length;
  try {
    applyState(await api(`/api/runs/${run.id}/tick`, { since, snapshot: {
      floor: currentFloor, room: r?.id, room_name: r?.name, hp: Math.round(player.hp),
      battery: Math.round(player.battery), items_collected: player.collected, captures: player.captures,
      time_left: Math.round(timeLeft()), ghosts_near: near } }));
  } catch (e) { console.warn(e); }
  ticking = false;
}
setInterval(directorTick, 2500);

function openAtm() {
  show("atm"); controls.unlock(); player.beam = false;
  $("atm-msg").textContent = "";
  $("atm-balance").textContent = money(walletCents(run.wallet));
  const box = $("atm-items"); box.innerHTML = "";
  for (const [key, it] of Object.entries(run.shop)) {
    const row = document.createElement("div"); row.className = "shop-item";
    row.innerHTML = "<div><b></b><br><span class='sub'></span></div><button></button>";
    row.querySelector("b").textContent = it.name; row.querySelector("span").textContent = it.desc;
    const btn = row.querySelector("button"); btn.textContent = `Buy ${money(it.price)}`;
    btn.disabled = key !== "medkit" && player.upgrades.has(key);
    btn.onclick = () => buy(key, btn);
    box.appendChild(row);
  }
}
async function buy(key, btn) {
  btn.disabled = true; $("atm-msg").textContent = "Contacting Capital One…";
  try {
    const res = await api(`/api/runs/${run.id}/shop`, { item: key, since });
    applyState(res); sfx.cash();
    if (key === "battery") { player.maxBattery = 160; player.battery = 160; }
    if (key === "medkit") player.hp = 100;
    if (key === "boots") player.speed = 1.3;
    if (key === "lance") player.beamDps *= 2;
    if (key !== "medkit") player.upgrades.add(key); else btn.disabled = false;
    $("atm-msg").textContent = `Bought ${run.shop[key].name}.` + (res.wallet.last_tx ? ` Transaction ${res.wallet.last_tx.id}` : "");
  } catch (e) { $("atm-msg").textContent = e.message; btn.disabled = false; }
}
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
  const id = b.dataset.close; show(id, false);
  if (id === "scan") $("scan-frame").src = "about:blank";
  if (mode === "play") controls.lock();
}));

// =====================================================================  HUD
function logEntry(text, cls = "") {
  const d = document.createElement("div"); d.className = `entry ${cls === "bad" ? "say" : ""}`; d.textContent = text;
  $("log").appendChild(d); setTimeout(() => d.remove(), 8200);
  while ($("log").children.length > 4) $("log").firstChild.remove();
}
const timeLeft = () => Math.max(0, run.time_limit - (performance.now() - player.startedAt) / 1000);
function hudTick() {
  $("hp-fill").style.width = `${player.hp}%`;
  $("bat-fill").style.width = `${100 * player.battery / player.maxBattery}%`;
  const tl = timeLeft(), tm = $("timer");
  tm.textContent = `${Math.floor(tl / 60)}:${String(Math.floor(tl % 60)).padStart(2, "0")}`;
  tm.classList.toggle("low", tl < 60);
  $("items-count").textContent = `Objects ${player.collected}/${run.items.length}`;
  const r = roomAt(camera.position.x, camera.position.z);
  $("floor-room").textContent = `F${currentFloor + 1} · ${r ? r.name : ""}`;
  const t = nearby(), p = $("prompt");
  p.classList.toggle("hidden", !t);
  if (t?.kind === "atm") p.textContent = "E · Capital One ATM (buy upgrades)";
  if (t?.kind === "exit") p.textContent = player.collected >= run.items.length ? "E · ESCAPE" : "E · exit (locked)";
  if (t?.kind === "stairs") {
    const up = currentFloor + 1 < L.floors, down = currentFloor > 0;
    p.textContent = [up && `E · go up to floor ${currentFloor + 2}`, down && `Q · go down to floor ${currentFloor}`].filter(Boolean).join("   ");
  }
  if (tl <= 0) finish("dawn");
}
function drawMinimap() {
  const c = $("minimap"), ctx = c.getContext("2d"); ctx.clearRect(0, 0, c.width, c.height);
  const rooms = L.rooms.filter((r) => r.floor === currentFloor);
  const maxX = Math.max(...rooms.map((r) => r.x + L.room_w)), maxZ = Math.max(...rooms.map((r) => r.z + L.room_d));
  const s = Math.min((c.width - 20) / maxX, (c.height - 20) / maxZ), tx = (x) => 10 + x * s, tz = (z) => 10 + z * s;
  const dot = (x, z, col, rad = 3.5) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(tx(x), tz(z), rad, 0, 7); ctx.fill(); };
  for (const r of rooms) {
    ctx.strokeStyle = r.name === "Stairwell" ? "#7cf3c4" : "rgba(124,243,196,.4)";
    ctx.strokeRect(tx(r.x), tz(r.z), L.room_w * s, L.room_d * s);
    if (r.name === "Stairwell") {
      ctx.fillStyle = "rgba(124,243,196,.18)"; ctx.fillRect(tx(r.x), tz(r.z), L.room_w * s, L.room_d * s);
      ctx.fillStyle = "#7cf3c4"; ctx.font = "bold 10px Inter, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("STAIRS", tx(r.x + L.room_w / 2), tz(r.z + L.room_d / 2) + 4); ctx.textAlign = "start";
    }
  }
  for (const m of Object.values(itemMeshes)) if (m.userData.floor === currentFloor) dot(m.position.x, m.position.z, "#c58cff");
  for (const g of ghosts.values()) if (g.floor === currentFloor && !g.dying) dot(g.mesh.position.x, g.mesh.position.z, "#ff4d6d", g.kind === "banshee" ? 5 : 3.5);
  if (currentFloor === 0 && atmMesh) dot(atmMesh.position.x, atmMesh.position.z, "#3d8bff");
  const p = camera.position, d = new THREE.Vector3(); camera.getWorldDirection(d);
  dot(p.x, p.z, "#7cf3c4", 4);
  ctx.strokeStyle = "#7cf3c4"; ctx.beginPath(); ctx.moveTo(tx(p.x), tz(p.z)); ctx.lineTo(tx(p.x + d.x * 3), tz(p.z + d.z * 3)); ctx.stroke();
}
let finishing = false;
async function finish(result) {
  if (finishing) return; finishing = true; mode = "ended";
  controls.unlock(); player.beam = false; beamMesh.visible = false;
  if (humGain) humGain.gain.value = 0;
  show("hud", false); show("atm", false); show("paused", false);
  $("end-title").textContent = { escaped: "You Escaped", dead: "The Building Kept You", dawn: "Dawn Broke" }[result];
  try {
    const s = await api(`/api/runs/${run.id}/finish`, { result, stats: { captures: player.captures, collected: player.collected }, since });
    $("end-text").textContent = s.epilogue + (s.wallet.live ? ` Capital One: ${money(s.wallet.earned)} in bounty transfers, ${money(s.wallet.spent)} charged to your card.` : "");
  } catch { $("end-text").textContent = ""; }
  setTimeout(() => show("ending"), 900);
}

// =====================================================================  Matterport real scan
$("scan-btn").addEventListener("click", () => {
  const mp = run.matterport;
  $("scan-frame").src = `https://my.matterport.com/show/?m=${encodeURIComponent(mp.model_id)}&play=1&qs=1&applicationKey=${encodeURIComponent(mp.sdk_key)}`;
  show("scan");
});

// =====================================================================  flow
const LOADING_LINES = ["The AI Director is reading the property record…", "Studying aerial imagery of the block…",
  "Walking the floor plan room by room…", "Digging through decades of tenants and sales…",
  "Hiding cursed objects upstairs…", "Opening your Capital One bounty account…", "Waking the ghosts…"];

async function loadBuildings() {
  const { buildings, integrations: on } = await api("/api/buildings");
  const tools = [["costar", "CoStar", "building data"], ["vexcel", "Vexcel", "aerial imagery"],
    ["matterport", "Matterport", "3D scans"], ["deepagents", "LangChain", "deepagents AI Director"],
    ["nessie", "Capital One", "Nessie bounty wallet"]];
  for (const [k, co, what] of tools) {
    const li = document.createElement("li"); li.className = on[k] ? "on" : "off";
    li.innerHTML = "<b></b><span></span>";
    li.querySelector("b").textContent = on[k] ? "● LIVE" : "○ off";
    li.querySelector("span").textContent = `${co} · ${what}`;
    $("sponsors").appendChild(li);
  }
  for (const b of buildings) {
    const card = document.createElement("button"); card.className = "card";
    card.innerHTML = `<h3></h3><div class="meta"></div><span class="type"></span>`;
    card.querySelector("h3").textContent = b.name;
    card.querySelector(".meta").textContent = `${b.address} · built ${b.year_built ?? "?"} · ${b.floors} floors`;
    card.querySelector(".type").textContent = b.property_type + (b.has_scan ? " · real 3D scan" : "");
    card.onclick = () => start(b);
    $("buildings").appendChild(card);
  }
}
async function start(b) {
  initAudio();
  show("title", false); show("loading");
  let i = 0;
  const tick = setInterval(() => ($("loading-line").textContent = LOADING_LINES[++i % LOADING_LINES.length]), 2400);
  try {
    run = await api("/api/runs", { building_id: b.id });
    since = 0;
    buildOutside(run.aerial_image_url, { ...run.building, id: b.id });
    show("loading", false);
    flyIn(() => {
      mode = "intro";
      $("case-address").textContent = run.building.address;
      $("case-title").textContent = run.title;
      $("case-intro").textContent = run.intro;
      show("scan-btn", !!run.matterport);
      show("intro");
    });
  } catch (err) { alert("Could not start: " + err.message); show("loading", false); show("title"); }
  finally { clearInterval(tick); }
}
$("enter-btn").addEventListener("click", () => {
  initAudio(); if (AC.state === "suspended") AC.resume();
  show("intro", false); show("hud");
  outside.visible = false; interior.visible = true; flashlight.visible = true;
  scene.fog = new THREE.FogExp2(0x050509, 0.05); moon.intensity = 0.05; ambient.intensity = 0.15;
  scene.add(new THREE.HemisphereLight(0x8a90b8, 0x1a1410, 0.45));
  buildInterior();
  const cmds = run.commands; since = cmds.length;
  for (const c of cmds) if (c.kind === "spawn") spawnGhost(c.ghost, false);
  const ex = roomById(run.exit_room);
  camera.position.set(ex.x + L.room_w / 2, 1.6, ex.z + 2); camera.rotation.set(0, Math.PI, 0);
  setFloor(0); renderWallet(run.wallet);
  player.startedAt = performance.now(); mode = "play";
  controls.lock();
  logEntry("Find the 5 glowing cursed objects. Hold click or Space to fire your UV beam at ghosts.");
  logEntry("Objects are on every floor: walk into the green STAIRS room (see minimap), press E to go up, Q to go down.");
});

// =====================================================================  main loop
let orbit = 0;
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05), t = performance.now() / 1000;
  if (mode === "title") {
    orbit += dt * 0.05; camera.position.set(Math.cos(orbit) * 260, 160, Math.sin(orbit) * 260); camera.lookAt(0, 0, 0);
  }
  if (mode === "play") {
    move(dt); beamTick(dt); pickupTick();
    for (const gh of [...ghosts.values()]) ghostTick(gh, dt, t);
    const dark = performance.now() < blackoutUntil;
    for (const pl of roomLights) {
      const off = (dark && pl.userData.floor === blackoutFloor) || Math.sin(t * 13 + pl.userData.seed) > 0.97;
      pl.intensity = off ? 0 : pl.userData.base;
    }
    for (const m of Object.values(itemMeshes)) { m.rotation.y += dt * 1.8; m.rotation.x += dt * 0.7; }
    hudTick(); drawMinimap();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
buildOutside(null, null);
loadBuildings().catch((e) => ($("sponsors").textContent = "Server not reachable: " + e.message));
loop();

// Debug handle for testing from the console.
window.HL = { camera, setFloor, player, ghosts, interact, get run() { return run; }, get layout() { return L; }, finish };
