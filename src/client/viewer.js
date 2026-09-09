import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { BASE, createScene, toast } from "./ui.js";
import { exportGLB } from "./export.js";
import { createFeedback, feedbackCamera } from "./feedback.js";

const id = location.pathname.split("/").filter(Boolean).at(-1);
const api = `${BASE}/api/scenes/${id}`;
document.body.classList.add("read-only", "loading");
const menu = document.createElement("div");
menu.id = "menubar";
menu.innerHTML = `<div class="viewer-menubar-status"><span id="fiend-status" role="status">Read-only · connecting</span></div><div class="viewer-menubar-actions"><button class="fiend-button" id="fiend-reset">Reset view</button><button class="fiend-button primary" id="fiend-copy">Edit</button><button class="fiend-button" id="fiend-export">Export GLB</button></div>`;
const viewport = document.createElement("div");
viewport.id = "viewport";
const viewOptions = document.createElement("div");
viewOptions.className = "viewer-viewport-controls";
viewOptions.innerHTML = `<select class="Select" aria-label="Rendering mode"><option value="realistic">realistic</option><option value="solid" selected>solid</option><option value="normals">normals</option><option value="wireframe">wireframe</option></select>`;
viewport.append(viewOptions);
const shading = viewOptions.querySelector("select");
const sidebar = document.createElement("aside");
sidebar.id = "sidebar";
sidebar.innerHTML = `<h2 class="viewer-heading">Scene</h2><div class="viewer-tree" role="tree" aria-label="Scene objects"></div><h2 class="viewer-heading">Properties</h2><dl class="viewer-properties"><dt>Selection</dt><dd>No object selected</dd></dl>`;
document.body.append(menu, viewport, sidebar);

THREE.ObjectLoader.registerGeometry("TextGeometry", TextGeometry);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.append(renderer.domElement);
let scene = new THREE.Scene();
let camera = new THREE.PerspectiveCamera(45, 1, .1, 1000);
camera.position.set(6, 4, 7);
let controls = new OrbitControls(camera, renderer.domElement);
let shared, selected, socket, reconnectDelay = 500, received = Promise.resolve();
let pathtracer;
const shadingMaterials = {
  normals: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
  wireframe: new THREE.MeshBasicMaterial({ color: 0xb7b7b7, wireframe: true, side: THREE.DoubleSide }),
};
const status = document.querySelector("#fiend-status");
function render() {
  if (shading.value === "realistic") pathtracer?.reset();
  // Debug shading applies only to this draw, never to scene data or exports.
  const original = scene.overrideMaterial;
  scene.overrideMaterial = shadingMaterials[shading.value] ?? null;
  try { renderer.render(scene, camera); }
  finally { scene.overrideMaterial = original; }
}
function shadingFailed(error) {
  renderer.setAnimationLoop(null);
  shading.value = "solid";
  render();
  toast(`Realistic rendering unavailable: ${error.message}`);
}
async function updateShading() {
  renderer.setAnimationLoop(null);
  render();
  if (shading.value !== "realistic" || !shared) return;
  try {
    const { ViewportPathtracer } = await import("./editor/js/Viewport.Pathtracer.js");
    if (shading.value !== "realistic") return;
    pathtracer ??= new ViewportPathtracer(renderer);
    pathtracer.init(scene, camera);
    pathtracer.setSize();
    renderer.setAnimationLoop(() => {
      try { pathtracer.update(); } catch (error) { shadingFailed(error); }
    });
  } catch (error) { shadingFailed(error); }
}
shading.onchange = updateShading;
controls.addEventListener("change", render);
function resize() {
  const { width, height } = viewport.getBoundingClientRect();
  if (camera.isPerspectiveCamera) camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  if (shading.value === "realistic") pathtracer?.setSize();
  render();
}
new ResizeObserver(resize).observe(viewport);
function dispose(root) {
  const resources = new Set();
  root.traverse((node) => {
    if (node.geometry) resources.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  if (root.background?.isTexture) resources.add(root.background);
  if (root.environment?.isTexture) resources.add(root.environment);
  for (const resource of resources) resource.dispose();
}
function properties(object) {
  selected = object?.uuid;
  const panel = document.querySelector(".viewer-properties");
  panel.replaceChildren();
  const values = object ? {
    Name: object.name || "Unnamed", Type: object.type,
    Position: object.position.toArray().map((value) => value.toFixed(2)).join(", "),
    Rotation: [object.rotation.x, object.rotation.y, object.rotation.z].map((value) => value.toFixed(2)).join(", "),
    Scale: object.scale.toArray().map((value) => value.toFixed(2)).join(", "),
    ...(object.material?.color ? { Color: `#${object.material.color.getHexString()}` } : {}),
  } : { Selection: "No object selected" };
  for (const [name, value] of Object.entries(values)) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = name; dd.textContent = value;
    panel.append(dt, dd);
  }
  for (const button of document.querySelectorAll(".viewer-tree button")) {
    button.classList.toggle("selected", button.dataset.uuid === selected);
    button.setAttribute("aria-selected", String(button.dataset.uuid === selected));
  }
}
function tree() {
  const root = document.querySelector(".viewer-tree");
  root.replaceChildren();
  function visit(node, depth) {
    const button = document.createElement("button");
    button.className = "viewer-object";
    button.dataset.uuid = node.uuid;
    button.style.paddingLeft = `${16 + depth * 12}px`;
    button.textContent = `${node.children.length ? "+" : "·"} ${node.name || node.type}`;
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-level", String(depth + 1));
    button.onclick = () => properties(node);
    button.ondblclick = () => frameObject(node);
    button.title = "Double-click to frame";
    root.append(button);
    for (const child of node.children) visit(child, depth + 1);
  }
  visit(scene, 0);
  properties(selected ? scene.getObjectByProperty("uuid", selected) : undefined);
}
function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, .01);
  const direction = camera.position.clone().sub(controls.target).normalize();
  if (direction.lengthSq() === 0) direction.set(1, .5, 1).normalize();
  let distance = radius * 4;
  if (camera.isPerspectiveCamera) {
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.min(camera.aspect, 1));
    distance = radius / Math.sin(halfFov) * 1.3;
  } else if (camera.isOrthographicCamera) {
    camera.zoom = Math.min(camera.right - camera.left, camera.top - camera.bottom) / (radius * 2 * 1.3);
    camera.updateProjectionMatrix();
  }
  camera.position.copy(center).addScaledVector(direction, distance);
  controls.target.copy(center);
  controls.update();
  render();
}
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "f" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest("input, textarea, select, [contenteditable]")) return;
  event.preventDefault();
  frameObject((selected && scene.getObjectByProperty("uuid", selected)) || scene);
});
async function resetCamera() {
  if (!shared) return;
  const next = await new THREE.ObjectLoader().parseAsync(shared.document.camera);
  controls.dispose();
  camera = next;
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.fromArray(shared.document.controls?.center ?? [0, 0, 0]);
  controls.addEventListener("change", render);
  controls.update();
  resize();
}
async function apply(snapshot) {
  if (shared && snapshot.revision <= shared.revision) return;
  const next = await new THREE.ObjectLoader().parseAsync(snapshot.document.scene);
  const cameraChanged = !shared || JSON.stringify(snapshot.document.camera) !== JSON.stringify(shared.document.camera) || JSON.stringify(snapshot.document.controls) !== JSON.stringify(shared.document.controls);
  renderer.setAnimationLoop(null);
  dispose(scene);
  scene = next;
  shared = snapshot;
  if (cameraChanged) await resetCamera();
  tree(); await updateShading();
  document.title = `${snapshot.name} — Fiend (read-only)`;
  status.textContent = "Read-only · live";
  document.body.classList.remove("loading");
  window.fiendReady = true;
}
function connect() {
  const url = new URL(`${api}/live`, location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.onopen = () => { reconnectDelay = 500; status.textContent = "Read-only · live"; };
  socket.onmessage = (event) => {
    if (event.data === "pong") return;
    const snapshot = JSON.parse(event.data);
    if (snapshot.type === "feedback") { feedback.receive(snapshot); return; }
    if (snapshot.type !== "snapshot") return;
    received = received.then(() => apply(snapshot)).catch((error) => { status.textContent = "Could not load scene"; toast(error.message); });
  };
  socket.onclose = () => { status.textContent = "Read-only · reconnecting…"; setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(15000, reconnectDelay * 2); };
  socket.onerror = () => socket.close();
}
const feedback = createFeedback({
  api, viewport, buttonHost: menu.querySelector(".viewer-menubar-status"),
  async restore(view) {
    renderer.setAnimationLoop(null);
    controls.dispose(); camera = feedbackCamera(view);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.fromArray(view.target);
    controls.addEventListener("change", render);
    shading.value = view.shading;
    controls.update(); resize(); await updateShading();
  },
});
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send("ping"); }, 25000);
connect();
document.querySelector("#fiend-copy").onclick = (event) => createScene(event.currentTarget, "empty", id, `${shared?.name ?? "Scene"} (copy)`.slice(0, 120));
document.querySelector("#fiend-reset").onclick = () => resetCamera().then(updateShading).catch((error) => toast(error.message));
document.querySelector("#fiend-export").onclick = async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const buffer = await exportGLB(scene, selected ?? "Scene");
    const url = URL.createObjectURL(new Blob([buffer], { type: "model/gltf-binary" }));
    const link = document.createElement("a"); link.href = url; link.download = "fiend-asset.glb"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
};
