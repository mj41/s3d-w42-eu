// The page: robot.glb turning on its own and by drag, the sensors and actuators from
// data/parts.json as markers on their parts, and an app from data/apps.json highlighting the
// parts it uses. Everything shown comes from those files.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const stage = document.getElementById('stage');
const status = document.getElementById('status');
const panel = document.getElementById('panel');
const appSelect = document.getElementById('app');
const markersBox = document.getElementById('markers');

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const deg = Math.PI / 180;

// The scene: the robot in metres (robot.glb's root scales robot3d's millimetres).
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.position = 'absolute';
labels.domElement.style.inset = '0';
labels.domElement.style.pointerEvents = 'none';
labels.domElement.style.zIndex = '1'; // its labels' own z-indexes stay inside it, under the list
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(css('--panel'));
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.8);
key.position.set(-0.045, 0.08, 0.055); // its shadow: a box round the robot (metres)
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = key.shadow.camera.bottom = -0.07;
key.shadow.camera.right = key.shadow.camera.top = 0.07;
key.shadow.camera.near = 0.01;
key.shadow.camera.far = 0.3;
key.shadow.bias = -0.0005;
key.shadow.radius = 4;
scene.add(key);
// The ground: only the shadow shows.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.ShadowMaterial({ opacity: 0.18 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(0.75, 0.25, 0.45);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(32, 1, 0.005, 2);
const target = new THREE.Vector3(0, 0.036, 0);
const turntable = new THREE.Group(); // turns the whole robot
scene.add(turntable);

let distance = 0.26, elevation = 12 * deg;
// A fixed view (?view=front|back|left|right|head|leds, for comparing with photos): the robot
// turned to it (yaw, degrees: the robot's side the camera sees), not spinning; a close-up nearer
// (zoom) and aimed at a height (aim, 0 the robot's foot, 1 its top).
const views = {
  front: { yaw: 0 }, back: { yaw: 180 }, left: { yaw: -90 }, right: { yaw: 90 },
  head: { yaw: -30, elevation: 20, zoom: 0.55, aim: 0.72 },
  leds: { yaw: -55, elevation: 38, zoom: 0.45, aim: 0.95 },
};
const view = views[new URLSearchParams(location.search).get('view')] || null;
if (view && view.elevation !== undefined) elevation = view.elevation * deg;
let fitBox = null; // the robot's bounds at rest: {r (about the yaw axis), y0, y1}, metres
function placeCamera() {
  camera.position.set(0, target.y + distance * Math.sin(elevation), distance * Math.cos(elevation));
  camera.lookAt(target);
}

// The LEDs glow: their bars lit in the LEDs' colour, and over each of the 12 LEDs (six along each
// bar, as robot3d places them) a soft glow that adds light, hidden where the head is in front.
const ledDefault = '#7fd4f5'; // as on the photos of a real robot (light blue)
const ledMaterials = [], ledGlows = [];
const glowTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
function setLEDs(hex) {
  const c = new THREE.Color(hex);
  for (const m of ledMaterials) { m.color.copy(c); m.emissive.copy(c); }
  for (const g of ledGlows) g.material.color.copy(c);
}
function lightLEDs(robot) {
  for (const name of ['led-bar-left', 'led-bar-right']) {
    const bar = robot.getObjectByName(name);
    if (!bar) continue;
    const material = new THREE.MeshStandardMaterial({ emissiveIntensity: 1.4, roughness: 0.4 });
    bar.material = material;
    ledMaterials.push(material);
    bar.geometry.computeBoundingBox();
    const { min, max } = bar.geometry.boundingBox; // millimetres, the bar along Z
    const out = Math.sign(min.x + max.x) * 0.8; // a little outside the bar
    for (let k = 0; k < 6; k++) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85,
      }));
      glow.position.set((min.x + max.x) / 2 + out, max.y + 0.3, max.z - (k + 0.5) * (max.z - min.z) / 6);
      glow.scale.set(11, 11, 1);
      glow.renderOrder = 5;
      bar.add(glow);
      ledGlows.push(glow);
    }
  }
  setLEDs(ledDefault);
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fit();
  placeCamera();
}
new ResizeObserver(resize).observe(stage);

// Framing: the robot turns, so what must fit is the cylinder round the yaw axis that holds it at
// rest; the camera is as near as lets that fill the view (a little margin), at any width.
function fit() {
  if (!fitBox) { placeCamera(); return; }
  const { r, y0, y1 } = fitBox;
  const v = Math.tan(camera.fov * deg / 2), hz = v * camera.aspect;
  target.set(0, (y0 + y1) / 2, 0);
  const margin = 1.06;
  distance = r + margin * Math.max((y1 - y0) / 2 / v, r / hz);
  if (view && view.zoom) {
    distance *= view.zoom;
    target.y = y0 + view.aim * (y1 - y0);
  }
  placeCamera();
}
function measure(robot) {
  robot.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(robot);
  let r = 0;
  for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) r = Math.max(r, Math.hypot(x, z));
  fitBox = { r, y0: box.min.y, y1: box.max.y };
  fit();
}

// Turning: slowly by itself; a drag turns it (and tilts the view with a mouse), then it goes
// on by itself after a moment. Touch keeps vertical swipes for scrolling the page.
let spin = view ? 0 : 0.25; // radians a second
if (view) turntable.rotation.y = view.yaw * deg;
let idleAt = 0;
let drag = null;
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  turntable.rotation.y += (e.clientX - drag.x) * 0.01;
  if (e.pointerType === 'mouse') {
    elevation = Math.min(70 * deg, Math.max(-20 * deg, elevation + (e.clientY - drag.y) * 0.006));
    fit();
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
const endDrag = () => { drag = null; idleAt = performance.now() + 2500; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// The head's joints (robot.glb's yaw and head nodes) and a short move to show a servo.
let yawNode = null, headNode = null, move = null;
function showMove(id) {
  if (id === 'yaw-servo') move = { joint: 'yaw', t0: performance.now(), ms: 2400 };
  if (id === 'pitch-servo') move = { joint: 'pitch', t0: performance.now(), ms: 2400 };
}
function pose(now) {
  if (!move || !yawNode) return;
  const t = (now - move.t0) / move.ms;
  if (t >= 1) { yawNode.rotation.y = 0; headNode.rotation.x = 0; move = null; return; }
  const s = Math.sin(t * Math.PI * 2) * Math.sin(t * Math.PI);
  if (move.joint === 'yaw') yawNode.rotation.y = 35 * deg * s;
  else headNode.rotation.x = -20 * deg * Math.abs(s); // +pitch lifts the front: about X by -pitch
}

// Markers: one per place. Entries on the same part within near mm of each other share one, at
// the most exact member's place; its label is the name, or a count with the list on hover or tap.
const near = 10;
const markers = []; // {ids, items, dot, label, el, colour}
let parts = [], apps = [], byId = new Map();
let picked = null; // the app shown

function addMarkers(robot) {
  const rank = { exact: 0, joint: 1, near: 2, inside: 3 };
  const groups = [];
  for (const p of parts) {
    if (!p.where) continue;
    const at = new THREE.Vector3().fromArray(p.where.offset);
    let g = groups.find((g) => g.where.part === p.where.part && g.items.some((q) => at.distanceTo(new THREE.Vector3().fromArray(q.where.offset)) < near));
    if (!g) groups.push(g = { where: p.where, items: [] });
    g.items.push(p);
    if (rank[p.where.how] < rank[g.where.how]) g.where = p.where;
  }
  for (const { where, items } of groups) {
    const node = robot.getObjectByName(where.part);
    if (!node) { console.warn('no part', where.part); continue; }
    const kind = items.every((p) => p.kind === 'sensor') ? 'sensor' : items.every((p) => p.kind === 'actuator') ? 'actuator' : 'both';
    const colour = new THREE.Color(css(kind === 'actuator' ? '--actuator' : '--sensor'));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12),
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true }));
    dot.renderOrder = 10;
    dot.position.fromArray(where.offset);
    node.add(dot);
    const box = document.createElement('div'); // placed by CSS2DRenderer
    const el = document.createElement('div'); // moved down by spread() when labels overlap
    el.className = 'label';
    if (items.length === 1) el.textContent = items[0].name;
    else {
      el.classList.add('group');
      el.textContent = items.length + ' parts';
      el.title = items.map((p) => p.name).join(', ');
    }
    box.append(el);
    const label = new CSS2DObject(box);
    label.center.set(0, 0.5); // the label starts at the dot
    label.position.fromArray(where.offset);
    node.add(label);
    const m = { ids: items.map((p) => p.id), items, dot, label, el, colour };
    markers.push(m);
    if (items.length > 1) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation()); // a tap, not a drag
      el.addEventListener('click', (e) => { e.stopPropagation(); openPop(open === m && pinned ? null : m, true); });
      el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !pinned) openPop(m); });
      el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pinned) openPop(null); });
    }
  }
}

// The list of a group's parts, next to its label.
const pop = document.createElement('div');
pop.id = 'pop';
pop.hidden = true;
stage.append(pop);
let open = null, pinned = false;
function openPop(m, pin = false) {
  open = m;
  pinned = !!m && pin;
  pop.hidden = !m;
  if (!m) return;
  const used = picked ? new Set(picked.uses.map((u) => u.part)) : null;
  pop.replaceChildren(...m.items.map((p) => {
    const row = document.createElement('div');
    row.className = 'row' + (used && !used.has(p.id) ? ' dimmed' : used ? ' used' : '');
    const k = document.createElement('span');
    k.className = 'kind ' + p.kind; k.textContent = p.kind;
    row.append(p.name, k);
    return row;
  }));
  placePop();
}
function placePop() {
  if (!open) return;
  const s = stage.getBoundingClientRect(), r = open.el.getBoundingClientRect();
  const x = Math.min(r.left - s.left, s.width - pop.offsetWidth - 6);
  let y = r.bottom - s.top + 4;
  if (y + pop.offsetHeight > s.height - 4) y = r.top - s.top - pop.offsetHeight - 4;
  pop.style.left = Math.max(6, x) + 'px';
  pop.style.top = Math.max(6, y) + 'px';
}
stage.addEventListener('click', () => { if (open) openPop(null); });

const world = new THREE.Vector3(), toCam = new THREE.Vector3(), out = new THREE.Vector3();
function updateMarkers() {
  const show = markersBox.checked;
  const used = picked ? new Set(picked.uses.map((u) => u.part)) : null;
  for (const m of markers) {
    const on = !used || m.ids.some((id) => used.has(id));
    m.dot.visible = show;
    m.label.visible = show;
    if (!show && open === m) openPop(null);
    m.el.classList.toggle('used', !!used && on);
    m.el.classList.toggle('dimmed', !on);
    m.dot.material.color.copy(on ? m.colour : new THREE.Color(css('--dim')));
    m.dot.scale.setScalar(used && on ? 1.5 : 1);
    m.dot.material.opacity = on ? 1 : 0.5;
    // A label on the far side of the robot fades.
    m.dot.getWorldPosition(world);
    out.set(world.x, 0, world.z);
    toCam.copy(camera.position).sub(world).setY(0);
    m.el.classList.toggle('behind', out.lengthSq() > 1e-10 && out.dot(toCam) < 0);
  }
}

// Labels that would cover each other move down, top to bottom.
const screenPos = new THREE.Vector3();
function spread() {
  const w = stage.clientWidth, h = stage.clientHeight, placed = [];
  const shown = markers.filter((m) => m.label.visible).map((m) => {
    m.dot.getWorldPosition(screenPos).project(camera);
    return { m, x: (screenPos.x + 1) / 2 * w + 8, y: (1 - screenPos.y) / 2 * h, wd: m.el.offsetWidth, ht: m.el.offsetHeight };
  }).sort((a, b) => a.y - b.y);
  for (const l of shown) {
    const dx = Math.min(0, w - 6 - (l.x + l.wd)); // kept inside the stage
    const x = l.x + dx;
    let y = l.y;
    for (let moved = true; moved;) { // until it is clear of every placed label
      moved = false;
      for (const p of placed) {
        if (x < p.x + p.wd && p.x < x + l.wd && y < p.y + p.ht + 2 && p.y < y + l.ht) { y = p.y + p.ht + 2; moved = true; }
      }
    }
    l.m.el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(y - l.y)}px)`;
    placed.push({ ...l, x, y });
  }
}

// The panel: all parts, or the picked app's uses.
const sourceLink = (s) => {
  const a = document.createElement('a');
  a.href = `https://github.com/mj41/${s.repo}/blob/${s.ref}/${s.path}#L${s.line}`;
  a.textContent = `${s.repo}/${s.path}:${s.line}`;
  a.target = '_blank'; a.rel = 'noopener';
  return a;
};
function sources(list) {
  const div = document.createElement('div');
  div.className = 'src';
  div.append('Source: ');
  list.forEach((s, i) => { if (i) div.append(', '); div.append(sourceLink(s)); });
  return div;
}
function item(p, does, srcs) {
  const li = document.createElement('li');
  const head = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = p.name;
  const kind = document.createElement('span');
  kind.className = 'kind ' + p.kind; kind.textContent = p.kind;
  head.append(name, kind);
  const d = document.createElement('div');
  d.className = 'does'; d.textContent = does;
  li.append(head, d);
  if (!picked) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = p.chip + (p.where ? ' · ' + p.where.note : ' · where: not in the docs');
    li.append(meta);
  }
  li.append(sources(srcs));
  li.addEventListener('click', () => {
    panel.querySelectorAll('li.active').forEach((x) => x.classList.remove('active'));
    li.classList.add('active');
    showMove(p.id);
    const m = markers.find((m) => m.ids.includes(p.id));
    if (m) {
      m.el.classList.remove('flash'); void m.el.offsetWidth; m.el.classList.add('flash');
      openPop(m.items.length > 1 ? m : null, true);
    }
  });
  return li;
}
function render() {
  panel.replaceChildren();
  if (picked) {
    const h = document.createElement('h2'); h.textContent = picked.name;
    const about = document.createElement('p'); about.className = 'about'; about.textContent = picked.about;
    panel.append(h, about, sources(picked.sources));
    if (picked.leds) {
      const l = document.createElement('p'); l.className = 'about';
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = picked.leds.color;
      l.append(sw, 'LEDs: ' + picked.leds.does);
      panel.append(l, sources(picked.leds.sources));
    }
    const ul = document.createElement('ul'); ul.className = 'items';
    for (const u of picked.uses) ul.append(item(byId.get(u.part), u.does, u.sources));
    panel.append(ul);
  } else {
    for (const kind of ['sensor', 'actuator']) {
      const h = document.createElement('h2'); h.textContent = kind === 'sensor' ? 'Sensors' : 'Actuators';
      const ul = document.createElement('ul'); ul.className = 'items';
      for (const p of parts.filter((p) => p.kind === kind)) ul.append(item(p, p.does, p.sources));
      panel.append(h, ul);
    }
  }
  const unplaced = parts.filter((p) => !p.where && (!picked || picked.uses.some((u) => u.part === p.id)));
  if (unplaced.length) {
    const p = document.createElement('p'); p.className = 'unplaced';
    p.textContent = 'Not marked on the model (the docs do not say where): ' + unplaced.map((p) => p.name).join(', ') + '.';
    panel.append(p);
  }
  setLEDs(picked && picked.leds ? picked.leds.color : ledDefault);
  updateMarkers();
  if (open) openPop(open, pinned);
}

markersBox.addEventListener('change', updateMarkers);
appSelect.addEventListener('change', () => {
  picked = apps.find((a) => a.id === appSelect.value) || null;
  history.replaceState(null, '', picked ? '#' + picked.id : location.pathname);
  render();
});

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!drag && !open && now > idleAt) turntable.rotation.y += spin * dt; // held while a list is open
  pose(now);
  if (markers.length) updateMarkers();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  spread();
  placePop();
  requestAnimationFrame(frame);
}

async function main() {
  resize();
  requestAnimationFrame(frame);
  const [gltf, partsDoc, appsDoc] = await Promise.all([
    new GLTFLoader().loadAsync('robot.glb'),
    fetch('data/parts.json').then((r) => r.json()),
    fetch('data/apps.json').then((r) => r.json()),
  ]);
  parts = partsDoc.parts;
  byId = new Map(parts.map((p) => [p.id, p]));
  apps = appsDoc.apps;
  for (const a of apps) appSelect.add(new Option(a.name, a.id));
  const robot = gltf.scene;
  robot.traverse((o) => { if (o.isMesh && o.name !== 'screen') { o.castShadow = true; o.receiveShadow = true; } });
  lightLEDs(robot);
  turntable.add(robot);
  yawNode = robot.getObjectByName('yaw');
  headNode = robot.getObjectByName('head');
  measure(robot);
  addMarkers(robot);
  const fromHash = apps.find((a) => '#' + a.id === location.hash);
  if (fromHash) { appSelect.value = fromHash.id; picked = fromHash; }
  render();
  status.remove();
}
main().catch((e) => { status.textContent = 'Could not load the robot: ' + e.message; console.error(e); });
