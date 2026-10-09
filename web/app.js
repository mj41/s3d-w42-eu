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
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.position = 'absolute';
labels.domElement.style.inset = '0';
labels.domElement.style.pointerEvents = 'none';
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.8);
key.position.set(-0.45, 0.8, 0.55);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.6);
fill.position.set(0.75, 0.25, 0.45);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(32, 1, 0.005, 2);
const target = new THREE.Vector3(0, 0.036, 0);
const turntable = new THREE.Group(); // turns the whole robot
scene.add(turntable);

let distance = 0.26, elevation = 14 * deg;
function placeCamera() {
  camera.position.set(0, target.y + distance * Math.sin(elevation), distance * Math.cos(elevation));
  camera.lookAt(target);
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  distance = w < h ? 0.32 : 0.26; // a phone: narrower, so further away
  camera.updateProjectionMatrix();
  placeCamera();
}
new ResizeObserver(resize).observe(stage);

// Turning: slowly by itself; a drag turns it (and tilts the view with a mouse), then it goes
// on by itself after a moment. Touch keeps vertical swipes for scrolling the page.
let spin = 0.25; // radians a second
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
    placeCamera();
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

// Markers: one per place (entries at the same part and offset share it), a dot and a label.
const markers = []; // {ids, dot, label, el, world}
let parts = [], apps = [], byId = new Map();
let picked = null; // the app shown

function addMarkers(robot) {
  const groups = new Map();
  for (const p of parts) {
    if (!p.where) continue;
    const k = p.where.part + ':' + p.where.offset.join(',');
    if (!groups.has(k)) groups.set(k, { where: p.where, items: [] });
    groups.get(k).items.push(p);
  }
  for (const { where, items } of groups.values()) {
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
    el.textContent = items.map((p) => p.name).join(' · ');
    box.append(el);
    const label = new CSS2DObject(box);
    label.center.set(0, 0.5); // the label starts at the dot
    label.position.fromArray(where.offset);
    node.add(label);
    markers.push({ ids: items.map((p) => p.id), dot, label, el, colour });
  }
}

const world = new THREE.Vector3(), toCam = new THREE.Vector3(), out = new THREE.Vector3();
function updateMarkers() {
  const show = markersBox.checked;
  const used = picked ? new Set(picked.uses.map((u) => u.part)) : null;
  for (const m of markers) {
    const on = !used || m.ids.some((id) => used.has(id));
    m.dot.visible = show;
    m.label.visible = show;
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
    let y = l.y;
    for (const p of placed) {
      if (l.x < p.x + p.wd && p.x < l.x + l.wd && y < p.y + p.ht + 2 && p.y < y + l.ht) y = p.y + p.ht + 2;
    }
    const dx = Math.min(0, w - 6 - (l.x + l.wd)); // kept inside the stage
    l.m.el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(y - l.y)}px)`;
    placed.push({ ...l, x: l.x + dx, y });
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
    if (m) { m.el.classList.remove('flash'); void m.el.offsetWidth; m.el.classList.add('flash'); }
  });
  return li;
}
function render() {
  panel.replaceChildren();
  if (picked) {
    const h = document.createElement('h2'); h.textContent = picked.name;
    const about = document.createElement('p'); about.className = 'about'; about.textContent = picked.about;
    panel.append(h, about, sources(picked.sources));
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
  updateMarkers();
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
  if (!drag && now > idleAt) turntable.rotation.y += spin * dt;
  pose(now);
  if (markers.length) updateMarkers();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  spread();
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
  turntable.add(robot);
  yawNode = robot.getObjectByName('yaw');
  headNode = robot.getObjectByName('head');
  addMarkers(robot);
  const fromHash = apps.find((a) => '#' + a.id === location.hash);
  if (fromHash) { appSelect.value = fromHash.id; picked = fromHash; }
  render();
  status.remove();
}
main().catch((e) => { status.textContent = 'Could not load the robot: ' + e.message; console.error(e); });
