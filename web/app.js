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
// A fixed view (?view=front|back|left|right|head|leds|top, for comparing with photos): the robot
// turned to it (yaw, degrees: the robot's side the camera sees), not spinning; a close-up nearer
// (zoom) and aimed at a height (aim, 0 the robot's foot, 1 its top).
const views = {
  front: { yaw: 0 }, back: { yaw: 180 }, left: { yaw: -90 }, right: { yaw: 90 },
  head: { yaw: -30, elevation: 20, zoom: 0.55, aim: 0.72 },
  leds: { yaw: -55, elevation: 38, zoom: 0.45, aim: 0.95 },
  top: { yaw: 0, elevation: 70, zoom: 0.6, aim: 0.95 },
};
const view = views[new URLSearchParams(location.search).get('view')] || null;
if (view && view.elevation !== undefined) elevation = view.elevation * deg;
let fitBox = null; // the robot's bounds at rest: {r (about the yaw axis), y0, y1}, metres
function placeCamera() {
  camera.position.set(0, target.y + distance * Math.sin(elevation), distance * Math.cos(elevation));
  camera.lookAt(target);
}

// The LEDs, as robot3d draws them (s-w42-eu-assets robot3d/shade.go: ledBar, barGlow): six
// under each bar (on the left, +X, LED 0 at the front; on the right LED 11 at the front). A lit
// LED's part of its bar shows its colour (0.35 of it, and 0.75 as its own light), an unlit one
// the bar's milky plastic (its colour in robot.glb); on the shell's sides a lit LED adds its light
// round the bar, fading over about a millimetre (0.35 exp(-d / 1.1 mm), out to 4 mm). Only the
// colours change: an app's leds from data (each LED, or one colour for all), else ledDefault.
const ledDefault = '#7fd4f5'; // as on the photos of a real robot (light blue)
const ledUniforms = {
  uLed: { value: Array.from({ length: 12 }, () => new THREE.Color()) },
  uLedOn: { value: new Array(12).fill(0) },
  uBar: { value: new THREE.Vector4() }, // the bars' z0, z1, y0, y1 at rest (mm), from robot.glb
};
// ledColors gives the 12 LEDs' colours ('' or null: off) from an app's leds: each, robot3d's
// -leds form ("#rrggbb*12", or 12 comma-separated, empty for off), or color for all.
function ledColors(leds) {
  if (!leds) return new Array(12).fill(ledDefault);
  if (!leds.each) return new Array(12).fill(leds.color);
  const all = /^(#[0-9a-f]{6})\*12$/.exec(leds.each);
  return all ? new Array(12).fill(all[1]) : leds.each.split(',');
}
function setLEDs(leds) {
  ledColors(leds).forEach((hex, i) => {
    ledUniforms.uLedOn.value[i] = hex ? 1 : 0;
    if (hex) ledUniforms.uLed.value[i].set(hex);
  });
}
const ledGLSL = `
uniform vec3 uLed[12];
uniform float uLedOn[12];
uniform vec4 uBar;
varying vec3 vRest;
varying vec3 vRestNormal;
int ledAt(float z, bool left) {
  int k = int(clamp((uBar.y - z) / ((uBar.y - uBar.x) / 6.0), 0.0, 5.0));
  return left ? k : 11 - k;
}
`;
// withLEDs patches a material: the bar's (bar true) or the shell's glow round the bars.
function withLEDs(material, bar) {
  material = material.clone();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ledUniforms);
    shader.vertexShader = 'varying vec3 vRest;\nvarying vec3 vRestNormal;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvRestNormal = normal;');
    const lit = bar ? `
      int k = ledAt(vRest.z, vRest.x > 0.0);
      if (uLedOn[k] > 0.5) { diffuseColor.rgb = uLed[k] * 0.35; totalEmissiveRadiance += uLed[k] * 0.75; }` : `
      if (abs(vRestNormal.x) > 0.97 && abs(vRest.x) > 26.0) {
        float dz = max(0.0, max(uBar.x - vRest.z, vRest.z - uBar.y));
        float dy = max(0.0, max(uBar.z - vRest.y, vRest.y - uBar.w));
        float d = length(vec2(dz, dy));
        int k = ledAt(clamp(vRest.z, uBar.x, uBar.y), vRest.x > 0.0);
        if (d < 4.0 && uLedOn[k] > 0.5) totalEmissiveRadiance += uLed[k] * 0.35 * exp(-d / 1.1);
      }`;
    shader.fragmentShader = ledGLSL + shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + lit);
  };
  material.customProgramCacheKey = () => (bar ? 'led-bar' : 'led-glow');
  return material;
}
function lightLEDs(robot) {
  const bar = robot.getObjectByName('led-bar-left');
  bar.geometry.computeBoundingBox();
  const { min, max } = bar.geometry.boundingBox; // millimetres at rest, the bar along Z
  ledUniforms.uBar.value.set(min.z, max.z, min.y, max.y);
  for (const name of ['led-bar-left', 'led-bar-right']) {
    const o = robot.getObjectByName(name);
    o.material = withLEDs(o.material, true);
  }
  const body = robot.getObjectByName('body');
  body.material = withLEDs(body.material, false);
  setLEDs(null);
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

// Turning: slowly by itself until the button stops it, or a drag (which turns it, and tilts the
// view with a mouse) or a pick in the list (which turns the picked part to the front) does.
// Touch keeps vertical swipes for scrolling the page.
const spin = 0.25; // radians a second
const spinButton = document.getElementById('spin');
let autoTurn = false;
function setAutoTurn(on) {
  autoTurn = on;
  spinButton.textContent = on ? '⏸ Stop turning' : '▶ Turn';
  spinButton.setAttribute('aria-pressed', String(on));
}
setAutoTurn(!view);
if (view) turntable.rotation.y = view.yaw * deg;
spinButton.addEventListener('pointerdown', (e) => e.stopPropagation());
spinButton.addEventListener('click', (e) => { e.stopPropagation(); turnTo = null; setAutoTurn(!autoTurn); });
let drag = null, turnTo = null;
stage.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (dx || dy) { setAutoTurn(false); turnTo = null; }
  turntable.rotation.y += dx * 0.01;
  if (e.pointerType === 'mouse') {
    elevation = Math.min(70 * deg, Math.max(-20 * deg, elevation + dy * 0.006));
    fit();
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
const endDrag = () => { drag = null; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// faceTo turns the robot (and tilts the view) so that a direction at rest faces the camera.
function faceTo(out) {
  const from = turntable.rotation.y;
  let to = from;
  if (Math.hypot(out.x, out.z) > 0.3) {
    const a = -Math.atan2(out.x, out.z);
    to = from + ((((a - from) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  }
  const up = out.y / out.length();
  turnTo = { from, to, el0: elevation, el1: up > 0.7 ? 55 * deg : up > 0.2 ? 30 * deg : 12 * deg, t0: performance.now(), ms: 700 };
  setAutoTurn(false);
}
function turning(now) {
  if (!turnTo) return;
  const t = Math.min(1, (now - turnTo.t0) / turnTo.ms), s = t * t * (3 - 2 * t);
  turntable.rotation.y = turnTo.from + (turnTo.to - turnTo.from) * s;
  elevation = turnTo.el0 + (turnTo.el1 - turnTo.el0) * s;
  placeCamera();
  if (t >= 1) turnTo = null;
}

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

// Markers: one per place, on the robot's surface: where a ray from outside along the entry's out
// (data/parts.json) meets the robot at rest. Entries on the same part within near mm of each
// other share one; its label is the name, or a count with the list on hover or tap. The screen's
// entries (area screen) outline the screen. Only the selected entries of the list show.
const near = 10;
const markers = []; // {ids, items, obj, label, el, colour, out}
let parts = [], apps = [], byId = new Map();
let picked = null; // the app shown
const selected = new Set(); // ids checked in the list
let focused = null; // the marker picked last in the list

function outOf(where) {
  if (where.out) return new THREE.Vector3().fromArray(where.out).normalize();
  const o = new THREE.Vector3(where.offset[0], 0, where.offset[2]);
  return o.lengthSq() > 1 ? o.normalize() : new THREE.Vector3(0, 0, 1);
}
// onSurface gives where the ray from outside along out meets the robot, in node's space.
function onSurface(robot, node, offset, out) {
  const p = node.localToWorld(new THREE.Vector3().fromArray(offset));
  const ray = new THREE.Raycaster(p.clone().addScaledVector(out, 0.2), out.clone().negate(), 0, 0.2);
  const hit = ray.intersectObject(robot, true).find((h) => h.object.isMesh);
  return node.worldToLocal((hit ? hit.point : p).clone());
}
function addMarkers(robot, screen) {
  const rank = { exact: 0, joint: 1, near: 2, inside: 3 };
  const groups = [];
  for (const p of parts) {
    if (!p.where) continue;
    const at = new THREE.Vector3().fromArray(p.where.offset);
    let g = groups.find((g) => g.where.part === p.where.part && (g.where.area || '') === (p.where.area || '') &&
      g.items.some((q) => at.distanceTo(new THREE.Vector3().fromArray(q.where.offset)) < near));
    if (!g) groups.push(g = { where: p.where, items: [] });
    g.items.push(p);
    if (rank[p.where.how] < rank[g.where.how]) g.where = p.where;
  }
  robot.updateMatrixWorld(true);
  for (const { where, items } of groups) {
    const node = robot.getObjectByName(where.area === 'screen' ? 'screen' : where.part);
    if (!node) { console.warn('no part', where.part); continue; }
    const kind = items.every((p) => p.kind === 'sensor') ? 'sensor' : items.every((p) => p.kind === 'actuator') ? 'actuator' : 'both';
    const colour = new THREE.Color(css(kind === 'actuator' ? '--actuator' : '--sensor'));
    const out = outOf(where);
    let obj, at;
    if (where.area === 'screen' && screen) { // a frame round the screen
      const [cx, cy, cz] = screen.centre, w = screen.width / 2, h = screen.height / 2;
      const shape = new THREE.Shape().moveTo(-w - 1.6, -h - 1.6).lineTo(w + 1.6, -h - 1.6).lineTo(w + 1.6, h + 1.6).lineTo(-w - 1.6, h + 1.6);
      shape.holes.push(new THREE.Path().moveTo(-w - 0.6, -h - 0.6).lineTo(-w - 0.6, h + 0.6).lineTo(w + 0.6, h + 0.6).lineTo(w + 0.6, -h - 0.6));
      obj = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: colour, transparent: true }));
      obj.position.set(cx, cy, cz + 0.2);
      at = new THREE.Vector3(cx + w + 1.6, cy + h + 1.6, cz + 0.2);
    } else {
      obj = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12),
        new THREE.MeshBasicMaterial({ color: colour, depthTest: false, transparent: true }));
      at = onSurface(robot, node, where.offset, out);
      obj.position.copy(at);
    }
    obj.renderOrder = 10;
    obj.raycast = () => {}; // not in the way of the next markers' rays
    node.add(obj);
    const box = document.createElement('div'); // placed by CSS2DRenderer
    const el = document.createElement('div'); // moved down by spread() when labels overlap
    el.className = 'label';
    box.append(el);
    const label = new CSS2DObject(box);
    label.center.set(0, 0.5); // the label starts at the dot
    label.position.copy(at);
    node.add(label);
    const m = { ids: items.map((p) => p.id), items, obj, label, el, colour, out, shown: [] };
    markers.push(m);
    el.addEventListener('pointerdown', (e) => e.stopPropagation()); // a tap, not a drag
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (m.shown.length > 1) openPop(open === m && pinned ? null : m, true);
      else if (m.shown.length) focus(m.shown[0], true);
    });
    el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !pinned && m.shown.length > 1) openPop(m); });
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pinned) openPop(null); });
  }
}

// The list of a group's parts, next to its label; a row picks its part.
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
  pop.replaceChildren(...m.shown.map((p) => {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'kind ' + p.kind; k.textContent = p.kind;
    row.append(p.name, k);
    row.addEventListener('pointerdown', (e) => e.stopPropagation());
    row.addEventListener('click', (e) => { e.stopPropagation(); focus(p, true); });
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

// listed: the entries the panel lists (the app's uses, or all); a feature (with) shows on its parts.
const listed = () => (picked ? picked.uses.map((u) => byId.get(u.part)).filter(Boolean) : parts);
function shownOn(m) {
  const ids = new Set(listed().filter((p) => selected.has(p.id)).map((p) => p.id));
  const shown = m.items.filter((p) => ids.has(p.id));
  for (const p of parts) if (p.with && ids.has(p.id) && p.with.some((w) => m.ids.includes(w)) && !shown.length) shown.push(...m.items.filter((q) => p.with.includes(q.id)));
  return shown;
}
// updateMarkers sets each marker's label and shows the selected ones (on selection changes).
function updateMarkers() {
  for (const m of markers) {
    m.shown = shownOn(m);
    const on = m.shown.length > 0;
    m.obj.visible = on;
    m.label.visible = on;
    if (!on && open === m) openPop(null);
    if (!on && focused === m) focused = null;
    m.el.classList.toggle('group', m.shown.length > 1);
    m.el.textContent = m.shown.length > 1 ? m.shown.length + ' parts' : m.shown.length ? m.shown[0].name : '';
    m.el.title = m.shown.map((p) => p.name).join(', ');
    m.el.classList.toggle('used', !!picked);
    m.el.classList.toggle('focus', focused === m);
  }
  const ids = listed().map((p) => p.id);
  const n = ids.filter((id) => selected.has(id)).length;
  markersBox.checked = n === ids.length;
  markersBox.indeterminate = n > 0 && n < ids.length;
}
// Each frame: a marker on a side facing away (its out, turned with the robot) fades; the focused
// one pulses.
const world = new THREE.Vector3(), toCam = new THREE.Vector3(), out = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
function frameMarkers(now) {
  for (const m of markers) {
    if (!m.obj.visible) continue;
    const f = focused === m;
    m.obj.getWorldPosition(world);
    out.copy(m.out).applyAxisAngle(yAxis, turntable.rotation.y);
    toCam.copy(camera.position).sub(world).normalize();
    const behind = out.dot(toCam) < -0.05;
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    if (m.obj.geometry.type === 'SphereGeometry') m.obj.scale.setScalar(f ? 1.6 + 0.6 * pulse : picked ? 1.3 : 1);
    m.obj.material.opacity = behind ? 0.25 : f ? 0.7 + 0.3 * pulse : 1;
    m.el.classList.toggle('behind', behind);
  }
}

// Labels that would cover each other move down, top to bottom.
const screenPos = new THREE.Vector3();
function spread() {
  const w = stage.clientWidth, h = stage.clientHeight, placed = [];
  const shown = markers.filter((m) => m.label.visible).map((m) => {
    m.label.getWorldPosition(screenPos).project(camera);
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

// focus: a part picked in the list (or on its label): checked, its marker turned to the front,
// pulsing, its servo moving; fromStage: its row scrolled into view.
function focus(p, fromStage = false) {
  if (!selected.has(p.id)) { selected.add(p.id); const cb = panel.querySelector(`input[data-id="${p.id}"]`); if (cb) cb.checked = true; }
  const target = p.with ? p.with[0] : p.id;
  focused = markers.find((m) => m.ids.includes(target)) || null;
  updateMarkers();
  panel.querySelectorAll('li.active').forEach((x) => x.classList.remove('active'));
  const li = panel.querySelector(`li[data-id="${p.id}"]`);
  if (li) { li.classList.add('active'); if (fromStage) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  showMove(target);
  if (focused) {
    faceTo(focused.out);
    focused.el.classList.remove('flash'); void focused.el.offsetWidth; focused.el.classList.add('flash');
    if (!fromStage) openPop(focused.shown.length > 1 ? focused : null, true);
  }
}

// The panel: the apps (each a link, #id), then all parts, or the picked app and its uses; each
// entry with a checkbox (show it on the robot), All checks or clears the list.
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
const link = (href, text, external = true) => {
  const a = document.createElement('a');
  a.href = href; a.textContent = text;
  if (external) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
};
function item(p, does, srcs) {
  const li = document.createElement('li');
  li.dataset.id = p.id;
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.dataset.id = p.id; cb.checked = selected.has(p.id);
  cb.title = 'Show on the robot';
  cb.setAttribute('aria-label', 'Show ' + p.name + ' on the robot');
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => { if (cb.checked) selected.add(p.id); else selected.delete(p.id); updateMarkers(); });
  const body = document.createElement('div');
  const head = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'name'; name.textContent = p.name;
  const kind = document.createElement('span');
  kind.className = 'kind ' + p.kind; kind.textContent = p.kind;
  head.append(name, kind);
  const d = document.createElement('div');
  d.className = 'does'; d.textContent = does;
  body.append(head, d);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const where = p.with ? 'a feature of ' + p.with.map((w) => byId.get(w).name).join(' and ')
    : p.where ? p.where.note : 'where: not in the docs';
  meta.textContent = picked ? (p.with || !p.where ? where : '') : p.chip + ' · ' + where;
  if (meta.textContent) body.append(meta);
  body.append(sources(srcs));
  li.append(cb, body);
  li.addEventListener('click', (e) => { if (!e.target.closest('a')) focus(p); });
  return li;
}
function appLinks(a) {
  const div = document.createElement('div');
  div.className = 'links';
  if (a.web) div.append(link(a.web, new URL(a.web).host + ' ↗'));
  div.append(link(`https://github.com/mj41/${a.repo}`, a.repo + ' ↗'));
  return div;
}
function render() {
  panel.replaceChildren();
  selected.clear();
  for (const p of listed()) selected.add(p.id);
  focused = null;
  if (picked) {
    const h = document.createElement('h2'); h.textContent = picked.name;
    const about = document.createElement('p'); about.className = 'about'; about.textContent = picked.about;
    panel.append(h, about, appLinks(picked), sources(picked.sources));
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
    const h = document.createElement('h2'); h.textContent = 'Apps';
    const ul = document.createElement('ul'); ul.className = 'apps';
    for (const a of apps) {
      const li = document.createElement('li');
      li.append(link('#' + a.id, a.name, false), ' — ' + a.about + ' ', appLinks(a));
      ul.append(li);
    }
    panel.append(h, ul);
    for (const kind of ['sensor', 'actuator']) {
      const h = document.createElement('h2'); h.textContent = kind === 'sensor' ? 'Sensors' : 'Actuators';
      const ul = document.createElement('ul'); ul.className = 'items';
      for (const p of parts.filter((p) => p.kind === kind)) ul.append(item(p, p.does, p.sources));
      panel.append(h, ul);
    }
  }
  const unplaced = listed().filter((p) => !p.where && !p.with);
  if (unplaced.length) {
    const p = document.createElement('p'); p.className = 'unplaced';
    p.textContent = 'Not marked on the model (the docs do not say where): ' + unplaced.map((p) => p.name).join(', ') + '.';
    panel.append(p);
  }
  setLEDs(picked ? picked.leds : null);
  updateMarkers();
  if (open) openPop(null);
}

// All: checks or clears every entry of the list.
markersBox.addEventListener('change', () => {
  for (const p of listed()) if (markersBox.checked) selected.add(p.id); else selected.delete(p.id);
  panel.querySelectorAll('input[data-id]').forEach((cb) => { cb.checked = selected.has(cb.dataset.id); });
  updateMarkers();
});
// The app: from the address (#id), so each app has its own link; the picker changes it.
function pickFromHash() {
  const a = apps.find((a) => '#' + a.id === location.hash) || null;
  if (a === picked && panel.childElementCount) return;
  picked = a;
  appSelect.value = a ? a.id : '';
  render();
}
appSelect.addEventListener('change', () => {
  if (appSelect.value) location.hash = appSelect.value;
  else { history.pushState(null, '', location.pathname + location.search); pickFromHash(); }
});
window.addEventListener('hashchange', pickFromHash);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (autoTurn && !drag && !open) turntable.rotation.y += spin * dt; // held while a list is open
  turning(now);
  pose(now);
  frameMarkers(now);
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
  addMarkers(robot, (gltf.parser.json.extras || {}).screen); // at rest, before it turns
  turntable.add(robot);
  yawNode = robot.getObjectByName('yaw');
  headNode = robot.getObjectByName('head');
  measure(robot);
  pickFromHash();
  status.remove();
}
main().catch((e) => { status.textContent = 'Could not load the robot: ' + e.message; console.error(e); });
