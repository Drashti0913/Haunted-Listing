import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

// ---------------------------------------------------------------- setup
const $ = (id) => document.getElementById(id);
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080d);
scene.fog = new THREE.FogExp2(0x07080d, 0.006);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 2000);
const controls = new PointerLockControls(camera, document.body);
const clock = new THREE.Clock();

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let game = null;         // public game state from the API
let since = 0;           // events already processed
let mode = "title";      // title | flyin | intro | play | ended
let currentFloor = 0;
const dialogHistory = {};
let dialogNpc = null;

// ---------------------------------------------------------------- helpers
async function api(path, body) {
  const busy = body && path !== "/api/games";
  if (busy) $("busy").classList.remove("hidden");
  try {
    const r = await fetch(path, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {});
    if (!r.ok) throw new Error(await r.text());
    return await r.json();
  } finally { if (busy) $("busy").classList.add("hidden"); }
}

function label(text, { color = "#e9e6f2", size = 48, bg = "rgba(7,8,13,0.7)" } = {}) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = `600 ${size}px Inter, sans-serif`;
  const w = ctx.measureText(text).width + 40;
  c.width = w; c.height = size + 28;
  ctx.font = `600 ${size}px Inter, sans-serif`;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, c.height, 16); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.fillText(text, 20, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 0.32;
  s.scale.set(h * c.width / c.height, h, 1);
  s.renderOrder = 10;
  return s;
}

function hash(str) { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }
function show(id, on = true) { $(id).classList.toggle("hidden", !on); }
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// ---------------------------------------------------------------- outside world (title + fly-in)
const outside = new THREE.Group();
scene.add(outside);
const moon = new THREE.DirectionalLight(0x9fb4ff, 1.4);
moon.position.set(-120, 200, 80);
scene.add(moon, new THREE.AmbientLight(0x404060, 0.6));
let target = null;

function buildOutside(aerialUrl, building) {
  outside.clear();
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x15161f, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), groundMat);
  ground.rotation.x = -Math.PI / 2;
  outside.add(ground);
  if (aerialUrl) {  // Vexcel aerial imagery as the ground
    new THREE.TextureLoader().setCrossOrigin("anonymous").load(aerialUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; groundMat.map = t; groundMat.color.set(0xffffff); groundMat.needsUpdate = true;
    });
  }
  const rnd = mulberry(building ? hash(building.id) : 7);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let gx = -8; gx <= 8; gx++) for (let gz = -8; gz <= 8; gz++) {
    if (Math.abs(gx) <= 1 && Math.abs(gz) <= 1) continue;
    if (gx % 3 === 0 || gz % 3 === 0) continue; // streets
    const h = 6 + rnd() * (rnd() > 0.85 ? 90 : 30);
    const m = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.65, 0.18, 0.14 + rnd() * 0.12),
      emissive: rnd() > 0.7 ? 0x22344a : 0x0b0d14, roughness: 0.9 }));
    m.scale.set(14 + rnd() * 8, h, 14 + rnd() * 8);
    m.position.set(gx * 26, h / 2, gz * 26);
    outside.add(m);
  }
  const floors = building?.floors || 3;
  target = new THREE.Mesh(new THREE.BoxGeometry(24, floors * 4, 16),
    new THREE.MeshStandardMaterial({ color: 0x2a2f45, emissive: 0x145c45, roughness: 0.6 }));
  const beacon = new THREE.PointLight(0x7cf3c4, 400, 120, 1.5);
  beacon.position.set(0, floors * 4 + 10, 0); outside.add(beacon);
  target.position.set(0, floors * 2, 0);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(target.geometry),
    new THREE.LineBasicMaterial({ color: 0x7cf3c4 }));
  target.add(edges);
  for (let f = 0; f < floors; f++) for (let i = 0; i < 6; i++) {   // lit windows
    const w = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.4),
      new THREE.MeshBasicMaterial({ color: rnd() > 0.5 ? 0xffd27a : 0x1a1f2b }));
    w.position.set(-10 + i * 4, -floors * 2 + 2 + f * 4, 8.01);
    target.add(w);
  }
  outside.add(target);
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function flyIn(done) {
  mode = "flyin";
  const t0 = performance.now();
  const from = new THREE.Vector3(160, 260, 220), to = new THREE.Vector3(0, 7, 34);
  const look = new THREE.Vector3(0, 6, 0);
  const step = () => {
    const flyT = (performance.now() - t0) / 5000;
    const t = ease(Math.min(flyT, 1));
    camera.position.lerpVectors(from, to, t);
    camera.lookAt(look);
    if (flyT < 1) requestAnimationFrame(step); else done();
  };
  step();
}

// ---------------------------------------------------------------- interior
const interior = new THREE.Group();
interior.visible = false;
scene.add(interior);
const floorGroups = [];
const npcMeshes = {};
const clueMeshes = {};
const roomLights = [];
let L = null;          // layout
const DOOR = 1.8, DOOR_H = 2.6, T = 0.2;
let roomMap = {};      // "floor:col:row" -> room
const flashlight = new THREE.SpotLight(0xfff1d6, 18, 18, Math.PI / 6, 0.5, 1.4);
camera.add(flashlight); camera.add(flashlight.target);
flashlight.position.set(0.2, -0.1, 0); flashlight.target.position.set(0, 0, -1);
scene.add(camera);
flashlight.visible = false;

const PALETTE = { office: [0x2b3040, 0x3a3f52], multifamily: [0x3b2f2a, 0x4a3b33], retail: [0x2a3b3a, 0x354a47] };

function buildInterior() {
  interior.clear(); floorGroups.length = 0; roomLights.length = 0; roomMap = {};
  L = game.layout;
  const W = L.room_w, D = L.room_d, H = L.floor_h - 0.4;
  const [wallC, wallC2] = PALETTE[game.building.property_type] || PALETTE.office;
  const wallMat = new THREE.MeshStandardMaterial({ color: wallC, roughness: 0.95 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x111218, roughness: 1, side: THREE.DoubleSide });
  for (const r of L.rooms) roomMap[`${r.floor}:${r.col}:${r.row}`] = r;

  for (let f = 0; f < L.floors; f++) {
    const g = new THREE.Group(); g.visible = false; interior.add(g); floorGroups.push(g);
  }
  for (const r of L.rooms) {
    const g = floorGroups[r.floor];
    const cx = r.x + W / 2, cz = r.z + D / 2, y = r.y;
    const tint = new THREE.Color(wallC2).offsetHSL((hash(r.id) % 10) / 100, 0, 0);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: tint, roughness: 0.8 }));
    fl.rotation.x = -Math.PI / 2; fl.position.set(cx, y, cz); g.add(fl);
    const ce = fl.clone(); ce.material = ceilMat; ce.position.y = y + H; g.add(ce);

    const sides = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dz] of sides) {
      const nb = roomMap[`${r.floor}:${r.col + dx}:${r.row + dz}`];
      if (nb && (dx < 0 || dz < 0)) continue;   // shared wall drawn by the other room
      const vertical = dx !== 0;                  // wall runs along z
      const px = dx === 0 ? cx : (dx < 0 ? r.x : r.x + W);
      const pz = dz === 0 ? cz : (dz < 0 ? r.z : r.z + D);
      const len = vertical ? D : W;
      addWall(g, wallMat, px, pz, y, len, H, vertical, !!nb);
    }
    const name = label(r.name, { color: r.name === "Stairwell" ? "#7cf3c4" : "#e9e6f2" });
    name.position.set(cx, y + H - 0.5, cz); g.add(name);
    if (r.name === "Stairwell") addStairs(g, cx, cz, y);
    const pl = new THREE.PointLight(0xffc98a, 6, 14, 1.2);
    pl.position.set(cx, y + H - 0.4, cz); pl.userData.seed = hash(r.id) % 100; g.add(pl); roomLights.push(pl);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    bulb.position.copy(pl.position); g.add(bulb);
  }
  if (game.bank.enabled) addBankTerminal();
  syncEntities();
}

let bankTerminal = null;
function addBankTerminal() {
  const p = roomCenter(game.bank.room, 7, 2.6);
  const g = new THREE.Group();
  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.7), new THREE.MeshStandardMaterial({ color: 0x3a2a20 }));
  desk.position.y = 0.4;
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x0b3d91, emissive: 0x1f6fff, emissiveIntensity: 1.2 }));
  screen.position.set(0, 1.15, 0);
  const tag = label("Capital One · bank records", { color: "#9cc3ff" }); tag.position.y = 1.8;
  g.add(desk, screen, tag);
  g.position.set(p.x, p.r.y, p.z);
  g.lookAt(p.r.x + L.room_w / 2, p.r.y, p.r.z + L.room_d / 2);
  g.userData = { floor: p.r.floor };
  interior.add(g); bankTerminal = g;
}

function addWall(g, mat, px, pz, y, len, H, vertical, door) {
  const seg = (center, l, h, yy) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(vertical ? T : l, h, vertical ? l : T), mat);
    m.position.set(vertical ? px : px + center, yy, vertical ? pz + center : pz); g.add(m);
  };
  if (!door) { seg(0, len, H, y + H / 2); return; }
  const side = (len - DOOR) / 2;
  seg(-(DOOR / 2 + side / 2), side, H, y + H / 2);
  seg(DOOR / 2 + side / 2, side, H, y + H / 2);
  seg(0, DOOR, H - DOOR_H, y + DOOR_H + (H - DOOR_H) / 2);
}

function addStairs(g, cx, cz, y) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a4f63 });
  for (let i = 0; i < 8; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(2, 0.25, 0.6), mat);
    s.position.set(cx + 2, y + 0.125 + i * 0.25, cz - 2.4 + i * 0.6); g.add(s);
  }
}

function roomCenter(roomId, idx = 0, spread = 2.2) {
  const r = L.rooms.find((x) => x.id === roomId);
  const a = (hash(roomId) % 360) * Math.PI / 180 + idx * 2.1;
  return { r, x: r.x + L.room_w / 2 + Math.cos(a) * spread, z: r.z + L.room_d / 2 + Math.sin(a) * spread };
}

function syncEntities() {
  // suspects
  game.npcs.forEach((n, i) => {
    let m = npcMeshes[n.id];
    if (!m) {
      m = new THREE.Group();
      const col = new THREE.Color().setHSL((hash(n.name) % 360) / 360, 0.5, 0.6);
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col.clone().multiplyScalar(0.25), transparent: true, opacity: 0.88 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.9, 6, 12), mat); body.position.y = 0.8;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), mat); head.position.y = 1.55;
      const tag = label(n.name, { color: "#ffd9e0" }); tag.position.y = 2.1;
      m.add(body, head, tag); m.userData = { id: n.id, phase: i };
      interior.add(m); npcMeshes[n.id] = m;
    }
    const p = roomCenter(n.room, i, 1.6);
    m.position.set(p.x, p.r.y, p.z);
    m.userData.floor = p.r.floor; m.userData.room = n.room;
  });
  // clues
  game.clues.forEach((c, i) => {
    let m = clueMeshes[c.id];
    if (c.found) { if (m) { interior.remove(m); delete clueMeshes[c.id]; } return; }
    if (!m) {
      m = new THREE.Mesh(new THREE.OctahedronGeometry(0.22),
        new THREE.MeshStandardMaterial({ color: 0x7cf3c4, emissive: 0x2fbf8c, emissiveIntensity: 1.4 }));
      const p = roomCenter(c.room, i + 3, 2.8);
      m.position.set(p.x, p.r.y + 0.9, p.z);
      m.userData = { id: c.id, floor: p.r.floor };
      interior.add(m); clueMeshes[c.id] = m;
    }
  });
  setFloor(currentFloor);
  updateHud();
}

function setFloor(f) {
  currentFloor = f;
  floorGroups.forEach((g, i) => (g.visible = i === f));
  for (const m of [...Object.values(npcMeshes), ...Object.values(clueMeshes), bankTerminal].filter(Boolean)) m.visible = m.userData.floor === f;
  camera.position.y = f * L.floor_h + 1.6;
}

function roomAt(x, z) {
  return L.rooms.find((r) => r.floor === currentFloor && x >= r.x && x < r.x + L.room_w && z >= r.z && z < r.z + L.room_d);
}

function canBe(x, z) {
  const r = roomAt(x, z);
  if (!r) return false;
  const W = L.room_w, D = L.room_d, m = 0.35, half = DOOR / 2 - 0.25;
  const lx = x - r.x, lz = z - r.z;
  const has = (dx, dz) => !!roomMap[`${r.floor}:${r.col + dx}:${r.row + dz}`];
  if (lx < m && !(has(-1, 0) && Math.abs(lz - D / 2) < half)) return false;
  if (lx > W - m && !(has(1, 0) && Math.abs(lz - D / 2) < half)) return false;
  if (lz < m && !(has(0, -1) && Math.abs(lx - W / 2) < half)) return false;
  if (lz > D - m && !(has(0, 1) && Math.abs(lx - W / 2) < half)) return false;
  return true;
}

// ---------------------------------------------------------------- input + movement
const keys = {};
addEventListener("keydown", (e) => {
  if (document.activeElement === $("dlg-input")) return;
  keys[e.code] = true;
  if (mode !== "play") return;
  if (e.code === "KeyE") interact(e.shiftKey ? "down" : "up");
  if (e.code === "KeyQ") interact("down");
  if (e.code === "KeyJ") openPanel("journal");
  if (e.code === "KeyH") askHint();
});
addEventListener("keyup", (e) => (keys[e.code] = false));

const panelsOpen = () => ["dialog", "journal", "scan", "bank"].some((id) => !$(id).classList.contains("hidden"));
// Fallback when pointer lock is unavailable (embedded browsers): drag to look.
let noLock = false;
document.addEventListener("pointerlockerror", () => { noLock = true; show("paused", false); });
let drag = null;
const euler = new THREE.Euler(0, 0, 0, "YXZ");
canvas.addEventListener("mousedown", (e) => { if (mode === "play" && !controls.isLocked) drag = { x: e.clientX, y: e.clientY }; });
addEventListener("mouseup", () => (drag = null));
addEventListener("mousemove", (e) => {
  if (!drag) return;
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= (e.clientX - drag.x) * 0.005;
  euler.x = Math.max(-1.4, Math.min(1.4, euler.x - (e.clientY - drag.y) * 0.005));
  camera.quaternion.setFromEuler(euler);
  drag = { x: e.clientX, y: e.clientY };
});
controls.addEventListener("unlock", () => { if (mode === "play" && !panelsOpen() && !noLock) show("paused"); });
controls.addEventListener("lock", () => show("paused", false));
$("paused").addEventListener("click", () => controls.lock());

function move(dt) {
  if (!controls.isLocked && !noLock) return;
  const speed = (keys.ShiftLeft ? 6.5 : 3.8) * dt;
  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const v = new THREE.Vector3();
  if (keys.KeyW || keys.ArrowUp) v.add(fwd);
  if (keys.KeyS || keys.ArrowDown) v.sub(fwd);
  if (keys.KeyD || keys.ArrowRight) v.add(right);
  if (keys.KeyA || keys.ArrowLeft) v.sub(right);
  if (!v.lengthSq()) return;
  v.normalize().multiplyScalar(speed);
  const p = camera.position;
  if (canBe(p.x + v.x, p.z)) p.x += v.x;   // slide along walls
  if (canBe(p.x, p.z + v.z)) p.z += v.z;
}

function nearest() {
  const p = camera.position;
  let best = null, bd = 2.3;
  for (const m of Object.values(npcMeshes)) {
    if (m.userData.floor !== currentFloor) continue;
    const d = Math.hypot(m.position.x - p.x, m.position.z - p.z);
    if (d < bd) { bd = d; best = { kind: "npc", id: m.userData.id }; }
  }
  for (const m of Object.values(clueMeshes)) {
    if (m.userData.floor !== currentFloor) continue;
    const d = Math.hypot(m.position.x - p.x, m.position.z - p.z);
    if (d < bd) { bd = d; best = { kind: "clue", id: m.userData.id }; }
  }
  if (bankTerminal && bankTerminal.userData.floor === currentFloor) {
    const d = Math.hypot(bankTerminal.position.x - p.x, bankTerminal.position.z - p.z);
    if (d < bd) { bd = d; best = { kind: "bank" }; }
  }
  if (!best && roomAt(p.x, p.z)?.name === "Stairwell") best = { kind: "stairs" };
  return best;
}

function interact(dir) {
  const t = nearest();
  if (!t) return;
  if (t.kind === "npc") openDialog(t.id);
  if (t.kind === "clue") findClue(t.id);
  if (t.kind === "bank") openBank();
  if (t.kind === "stairs") {
    const up = currentFloor + 1 < L.floors, down = currentFloor > 0;
    if (dir === "up" && up) setFloor(currentFloor + 1);
    else if (down) setFloor(currentFloor - 1);
    else if (up) setFloor(currentFloor + 1);
    updateHud();
  }
}

// ---------------------------------------------------------------- game events from the GM
function handle(state) {
  game = state;
  for (const ev of state.events) {
    if (ev.kind === "narrate") logEntry(ev.text);
    if (ev.kind === "say") {
      const n = game.npcs.find((x) => x.id === ev.npc_id);
      (dialogHistory[ev.npc_id] ||= []).push({ who: n?.name, text: ev.text });
      if (dialogNpc === ev.npc_id) renderDialog(); else logEntry(`${n?.name}: “${ev.text}”`, "say");
    }
    if (ev.kind === "move") {
      const n = game.npcs.find((x) => x.id === ev.npc_id);
      const r = L.rooms.find((x) => x.id === ev.room);
      if (n && r) logEntry(`You hear footsteps… ${n.name} heads to the ${r.name} (floor ${r.floor + 1}).`);
    }
  }
  since += state.events.length;
  syncEntities();
  if (state.status !== "playing") endGame();
}

function logEntry(text, cls = "") {
  const d = document.createElement("div");
  d.className = `entry ${cls}`; d.textContent = text;
  $("log").appendChild(d);
  setTimeout(() => d.remove(), 8200);
  while ($("log").children.length > 4) $("log").firstChild.remove();
}

async function findClue(id) {
  handle(await api(`/api/games/${game.id}/found`, { clue_id: id, since }));
  const c = game.clues.find((x) => x.id === id);
  if (c) logEntry(`🔍 ${c.name}: ${c.description}`);
}

async function askHint() { handle(await api(`/api/games/${game.id}/hint`, { since })); }
$("hint-btn").addEventListener("click", askHint);

function openPanel(id) {
  show(id); controls.unlock();
  if (id === "journal") renderJournal();
}
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
  const id = b.dataset.close; show(id, false);
  if (id === "dialog") dialogNpc = null;
  if (id === "scan") $("scan-frame").src = "about:blank";
  if (mode === "play") controls.lock();
}));

async function openBank() {
  openPanel("bank");
  $("bank-body").innerHTML = '<p class="empty">Connecting to Capital One…</p>';
  try {
    const res = await api(`/api/games/${game.id}/bank`, { since });
    renderBank(res.records);
    const { records, ...state } = res;
    handle(state);
  } catch (err) { $("bank-body").innerHTML = ""; $("bank-body").textContent = "Bank unavailable: " + err.message; }
}

function renderBank(records) {
  const body = $("bank-body"); body.innerHTML = "";
  for (const r of records) {
    const h = document.createElement("h4");
    h.innerHTML = "<b></b> <span></span>";
    h.querySelector("b").textContent = r.name; h.querySelector("span").textContent = r.role;
    body.appendChild(h);
    if (!r.transactions.length) { const p = document.createElement("p"); p.className = "empty"; p.textContent = "No activity"; body.appendChild(p); continue; }
    const tbl = document.createElement("table");
    for (const t of r.transactions) {
      const tr = document.createElement("tr");
      const sign = t.direction === "in" ? "+" : "−";
      for (const [txt, cls] of [[t.counterparty || t.kind, ""], [t.description, ""],
        [`${sign}$${t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, `amt ${t.direction}`], [t.status, "sub"]]) {
        const td = document.createElement("td"); td.textContent = txt; if (cls) td.className = cls; tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    body.appendChild(tbl);
  }
}

function openDialog(npcId) {
  dialogNpc = npcId;
  const n = game.npcs.find((x) => x.id === npcId);
  $("dlg-name").textContent = n.name; $("dlg-role").textContent = n.role;
  renderDialog(); openPanel("dialog");
  setTimeout(() => $("dlg-input").focus(), 50);
}

function renderDialog() {
  const box = $("dlg-lines"); box.innerHTML = "";
  for (const l of dialogHistory[dialogNpc] || []) {
    const d = document.createElement("div");
    d.className = l.who === "You" ? "me" : "";
    d.textContent = l.who === "You" ? l.text : `${l.who}: ${l.text}`;
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

$("dlg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("dlg-input").value.trim();
  if (!msg || !dialogNpc) return;
  $("dlg-input").value = "";
  (dialogHistory[dialogNpc] ||= []).push({ who: "You", text: msg });
  renderDialog();
  handle(await api(`/api/games/${game.id}/talk`, { npc_id: dialogNpc, message: msg, since }));
});

function renderJournal() {
  const cl = $("j-clues"); cl.innerHTML = "";
  for (const c of game.clues) {
    const li = document.createElement("li");
    if (c.found) { li.innerHTML = `<b></b><br><span></span>`; li.querySelector("b").textContent = c.name; li.querySelector("span").textContent = c.description; }
    else { li.className = "unknown"; li.textContent = "Undiscovered clue somewhere in the building"; }
    cl.appendChild(li);
  }
  const sl = $("j-suspects"); sl.innerHTML = "";
  for (const n of game.npcs) {
    const li = document.createElement("li");
    const r = L.rooms.find((x) => x.id === n.room);
    li.innerHTML = `<b></b> · <span></span><br><small></small><br>`;
    li.querySelector("b").textContent = n.name; li.querySelector("span").textContent = n.role;
    li.querySelector("small").textContent = `Last seen: ${r?.name}, floor ${r ? r.floor + 1 : "?"}`;
    const btn = document.createElement("button"); btn.textContent = "Accuse";
    btn.onclick = async () => {
      if (!confirm(`Accuse ${n.name}? You only get one shot.`)) return;
      show("journal", false);
      handle(await api(`/api/games/${game.id}/accuse`, { npc_id: n.id, since }));
    };
    li.appendChild(btn); sl.appendChild(li);
  }
}

function endGame() {
  if (mode === "ended") return;
  mode = "ended"; controls.unlock();
  show("hud", false); show("dialog", false); show("journal", false); show("paused", false);
  $("end-title").textContent = game.status === "won" ? "Case Closed" : "The Ghost Wins";
  $("end-text").textContent = game.solution || "";
  setTimeout(() => show("ending"), 1600);
}

// ---------------------------------------------------------------- HUD + minimap
function updateHud() {
  if (!L) return;
  const r = roomAt(camera.position.x, camera.position.z);
  $("hud-floor").textContent = `Floor ${currentFloor + 1}/${L.floors}`;
  $("hud-room").textContent = r ? r.name : "";
  $("hud-clues").textContent = `Clues ${game.clues.filter((c) => c.found).length}/${game.clues.length}`;
  const t = mode === "play" ? nearest() : null;
  const p = $("prompt");
  if (!t) { p.classList.add("hidden"); return; }
  p.classList.remove("hidden");
  if (t.kind === "npc") p.textContent = `E · talk to ${game.npcs.find((n) => n.id === t.id)?.name}`;
  if (t.kind === "clue") p.textContent = "E · examine";
  if (t.kind === "stairs") p.textContent = `E · up   Q · down`;
  if (t.kind === "bank") p.textContent = "E · pull bank records (Capital One)";
}

function drawMinimap() {
  const c = $("minimap"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const rooms = L.rooms.filter((r) => r.floor === currentFloor);
  const maxX = Math.max(...rooms.map((r) => r.x + L.room_w)), maxZ = Math.max(...rooms.map((r) => r.z + L.room_d));
  const s = Math.min((c.width - 20) / maxX, (c.height - 20) / maxZ);
  const tx = (x) => 10 + x * s, tz = (z) => 10 + z * s;
  for (const r of rooms) {
    ctx.strokeStyle = "rgba(124,243,196,.5)"; ctx.strokeRect(tx(r.x), tz(r.z), L.room_w * s, L.room_d * s);
  }
  for (const m of Object.values(npcMeshes)) if (m.userData.floor === currentFloor) {
    ctx.fillStyle = "#ff4d6d"; ctx.beginPath(); ctx.arc(tx(m.position.x), tz(m.position.z), 3.5, 0, 7); ctx.fill();
  }
  const p = camera.position, d = new THREE.Vector3(); camera.getWorldDirection(d);
  ctx.fillStyle = "#7cf3c4"; ctx.beginPath(); ctx.arc(tx(p.x), tz(p.z), 4, 0, 7); ctx.fill();
  ctx.strokeStyle = "#7cf3c4"; ctx.beginPath(); ctx.moveTo(tx(p.x), tz(p.z)); ctx.lineTo(tx(p.x + d.x * 3), tz(p.z + d.z * 3)); ctx.stroke();
}

// ---------------------------------------------------------------- Matterport real scan (needs keys)
async function openScan() {
  const mp = game.matterport;
  const frame = $("scan-frame");
  frame.src = `https://my.matterport.com/show/?m=${encodeURIComponent(mp.model_id)}&play=1&qs=1&applicationKey=${encodeURIComponent(mp.sdk_key)}`;
  openPanel("scan");
  try {   // tag found clues at real sweep positions inside the scan
    if (!window.MP_SDK) await new Promise((ok, bad) => {
      const s = document.createElement("script");
      s.src = "https://static.matterport.com/showcase-sdk/latest.js"; s.onload = ok; s.onerror = bad;
      document.head.appendChild(s);
    });
    const sdk = await window.MP_SDK.connect(frame, mp.sdk_key, "");
    const sweeps = [];
    await new Promise((ok) => sdk.Sweep.data.subscribe({
      onCollectionUpdated(col) { sweeps.push(...Object.values(col)); ok(); },
    }));
    const tags = game.clues.filter((c) => c.found).map((c, i) => ({
      label: c.name, description: c.description,
      anchorPosition: sweeps[(hash(c.room) + i) % sweeps.length].position,
      stemVector: { x: 0, y: 0.4, z: 0 }, color: { r: 0.49, g: 0.95, b: 0.77 },
    }));
    if (tags.length) await (sdk.Mattertag?.add ? sdk.Mattertag.add(tags) : sdk.Tag.add(...tags));
  } catch (err) { console.warn("Matterport SDK tagging unavailable", err); }
}
$("scan-btn").addEventListener("click", openScan);

// ---------------------------------------------------------------- flow
const LOADING_LINES = [
  "The Game Master is reading the property record…",
  "Studying aerial imagery of the block…",
  "Walking the floor plan room by room…",
  "Digging through decades of tenants and sales…",
  "Hiding clues where they make sense…",
  "Giving every suspect a secret…",
];

async function loadBuildings() {
  const { buildings, llm, integrations: on } = await api("/api/buildings");
  $("gm-mode").textContent = llm ? "AI Game Master online" : "Offline Game Master (add ANTHROPIC_API_KEY for the AI)";
  const tools = [
    ["costar", "CoStar", "building data"], ["vexcel", "Vexcel", "aerial imagery"],
    ["matterport", "Matterport", "3D scans"], ["deepagents", "LangChain", "deepagents game master"],
    ["nessie", "Capital One", "Nessie bank accounts"],
  ];
  for (const [k, co, what] of tools) {
    const li = document.createElement("li");
    li.className = on[k] ? "on" : "off";
    li.innerHTML = "<b></b><span></span>";
    li.querySelector("b").textContent = on[k] ? "● LIVE" : "○ off";
    li.querySelector("span").textContent = `${co} · ${what}`;
    $("sponsors").appendChild(li);
  }
  const box = $("buildings");
  for (const b of buildings) {
    const card = document.createElement("button");
    card.className = "card";
    card.innerHTML = `<h3></h3><div class="meta"></div><span class="type"></span>`;
    card.querySelector("h3").textContent = b.name;
    card.querySelector(".meta").textContent = `${b.address} · built ${b.year_built ?? "?"} · ${b.floors} floors`;
    card.querySelector(".type").textContent = b.property_type + (b.has_scan ? " · real 3D scan" : "");
    card.onclick = () => start(b);
    box.appendChild(card);
  }
}

async function start(b) {
  show("title", false); show("loading");
  let i = 0;
  const tick = setInterval(() => ($("loading-line").textContent = LOADING_LINES[++i % LOADING_LINES.length]), 2600);
  try {
    const state = await api("/api/games", { building_id: b.id });
    since = state.events.length;   // intro narration is shown on the case card
    game = state;
    buildOutside(state.aerial_image_url, { ...state.building, id: b.id });
    show("loading", false);
    flyIn(() => {
      mode = "intro";
      $("case-address").textContent = state.building.address;
      $("case-title").textContent = state.title;
      $("case-intro").textContent = state.intro;
      $("case-mystery").textContent = state.mystery;
      show("scan-btn", !!state.matterport);
      show("intro");
    });
  } catch (err) {
    alert("Could not start the game: " + err.message);
    show("loading", false); show("title");
  } finally { clearInterval(tick); }
}

$("enter-btn").addEventListener("click", () => {
  show("intro", false); show("hud");
  outside.visible = false; interior.visible = true; flashlight.visible = true;
  scene.fog = new THREE.FogExp2(0x050509, 0.045);
  moon.intensity = 0.05;
  scene.add(new THREE.HemisphereLight(0x8a90b8, 0x1a1410, 0.55));
  buildInterior();
  const start = L.rooms.find((r) => r.floor === 0);
  camera.position.set(start.x + L.room_w / 2, 1.6, start.z + L.room_d / 2);
  camera.rotation.set(0, 0, 0);
  mode = "play";
  controls.lock();
  logEntry(game.mystery);
});

// ---------------------------------------------------------------- loop
let orbit = 0;
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now() / 1000;
  if (mode === "title") {
    orbit += dt * 0.05;
    camera.position.set(Math.cos(orbit) * 260, 160, Math.sin(orbit) * 260);
    camera.lookAt(0, 0, 0);
  }
  if (mode === "play") {
    move(dt);
    for (const pl of roomLights) {          // haunted flicker
      const s = pl.userData.seed;
      pl.intensity = Math.sin(t * 13 + s) > 0.97 || Math.sin(t * 0.7 + s) > 0.995 ? 0.6 : 6;
    }
    for (const m of Object.values(clueMeshes)) { m.rotation.y += dt * 1.5; m.position.y += Math.sin(t * 2 + m.id) * 0.002; }
    for (const m of Object.values(npcMeshes)) {
      m.children[0].position.y = 0.8 + Math.sin(t * 1.5 + m.userData.phase) * 0.06;
      m.lookAt(camera.position.x, m.position.y, camera.position.z);
    }
    updateHud(); drawMinimap();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

buildOutside(null, null);
loadBuildings().catch((e) => ($("gm-mode").textContent = "Server not reachable: " + e.message));
loop();

// Debug handle for testing from the browser console.
window.HL = { camera, setFloor, interact, nearest, get game() { return game; }, get layout() { return L; } };
