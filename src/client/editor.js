import * as THREE from "three";
import { Editor } from "./editor/js/Editor.js";
import { Viewport } from "./editor/js/Viewport.js";
import { Toolbar } from "./editor/js/Toolbar.js";
import { Sidebar } from "./editor/js/Sidebar.js";
import { Menubar } from "./editor/js/Menubar.js";
import { Resizer } from "./editor/js/Resizer.js";
import { Animation } from "./editor/js/Animation.js";
import { AnimationResizer } from "./editor/js/AnimationResizer.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { BASE, connectDialog, copy, toast } from "./ui.js";
import { diffScene, mergeScene } from "./sync.js";
import { createFeedback, captureFeedbackFrame, feedbackCamera } from "./feedback.js";

const id = location.pathname.split("/").filter(Boolean).at(-1);
const api = `${BASE}/api/scenes/${id}`;
const secret = new URLSearchParams(location.hash.slice(1)).get("secret");
const writeHeaders = { "content-type": "application/json", authorization: `Bearer ${secret}` };
document.body.classList.add("loading", "scene-editor");
const actions = document.createElement("div");
actions.className = "fiend-menubar-actions";
actions.innerHTML = `<span id="fiend-status" role="status">Connecting</span><button class="fiend-button" id="fiend-share">Public link</button><button class="fiend-button" id="fiend-connect">Connect agent</button>`;
const activity = document.createElement("div"); activity.id = "fiend-activity"; document.body.append(activity);
const status = actions.querySelector("#fiend-status");
const editor = new Editor();
window.editor = editor;
window.THREE = THREE;
THREE.ObjectLoader.registerGeometry("TextGeometry", TextGeometry);
// The Durable Object is the persistence authority. Avoid cross-scene local storage.
editor.config.setKey("autosave", false, "project/renderer/type", "WebGLRenderer");
let renderer;
editor.signals.rendererCreated.add((value) => { renderer = value; });
const viewport = new Viewport(editor);
const toolbar = new Toolbar(editor);
const menubar = new Menubar(editor);
menubar.dom.querySelector(".menu.right")?.remove();
menubar.dom.append(actions);
for (const panel of [viewport, toolbar, new Sidebar(editor), menubar, new Resizer(editor), new Animation(editor), new AnimationResizer(editor)]) document.body.append(panel.dom);
editor.signals.animationPanelChanged.add((height) => {
  const visible = height !== false;
  viewport.dom.classList.toggle("with-animation", visible);
  toolbar.dom.classList.toggle("with-animation", visible);
  viewport.dom.style.bottom = visible ? `${height}px` : "";
  toolbar.dom.style.bottom = visible ? `${height + 20}px` : "";
  editor.signals.windowResize.dispatch();
});

let applying = false, pending = [], inFlight;
let timer, socket, received = Promise.resolve(), reconnectDelay = 500;
let shared, viewDocument;
function state(message, error = false) { status.textContent = message; status.dataset.state = error ? "error" : "ok"; }
function updateStatus() {
  if (socket?.readyState !== WebSocket.OPEN) state("Reconnecting…", true);
  else state(pending.length || inFlight ? "Syncing…" : "Live");
}
function serialize() {
  editor.scene.updateMatrixWorld(true);
  return { ...shared?.document, scene:editor.scene.toJSON(), backgroundType:editor.backgroundType, environmentType:editor.environmentType };
}
async function apply(snapshot) {
  captureLocal();
  const acknowledged = inFlight?.id === snapshot.source;
  if (acknowledged) inFlight = undefined;
  if (shared && snapshot.revision <= shared.revision && !acknowledged && viewDocument) return;
  const previous = shared;
  if (!shared || snapshot.revision > shared.revision) shared = snapshot;
  const optimistic = [...(inFlight?.patches ?? []), ...pending];
  const display = optimistic.length ? mergeScene(shared.document, optimistic) : shared.document;
  const cameraChanged = !previous || JSON.stringify(shared.document.camera) !== JSON.stringify(previous.document.camera) || JSON.stringify(shared.document.controls) !== JSON.stringify(previous.document.controls);
  if (viewDocument && !cameraChanged && diffScene(viewDocument, display).length === 0) {
    updateStatus();
    if (pending.length && !inFlight) scheduleSave();
    return;
  }
  applying = true;
  viewport.dom.style.pointerEvents = "none";
  document.querySelector("#sidebar").inert = true;
  const selected = editor.selected?.uuid;
  try {
    // Parse first so a broken imported scene cannot erase the current viewport.
    const scene = await new THREE.ObjectLoader().parseAsync(display.scene);
    const camera = cameraChanged ? await new THREE.ObjectLoader().parseAsync(shared.document.camera) : null;
    editor.signals.sceneGraphChanged.active = false;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    editor.scene.traverse((node) => {
      if (node.geometry) geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    while (editor.scene.children.length) editor.removeObject(editor.scene.children[0]);
    for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
    editor.signals.sceneGraphChanged.active = true;
    editor.history.clear();
    editor.backgroundType = display.backgroundType;
    editor.environmentType = display.environmentType;
    editor.setScene(scene);
    editor.scene.position.copy(scene.position);
    editor.scene.quaternion.copy(scene.quaternion);
    editor.scene.scale.copy(scene.scale);
    if (camera) {
      editor.setCameraType(camera.isOrthographicCamera ? "orthographic" : "perspective");
      editor.camera.copy(camera);
      editor.camera.name = "Editor camera";
      if (shared.document.controls) editor.controls.fromJSON(shared.document.controls);
      editor.signals.cameraResetted.dispatch();
    }
    if (selected && editor.scene.getObjectByProperty("uuid", selected)) editor.selectByUuid(selected);
    else editor.deselect();
    viewDocument = serialize();
    document.title = `${shared.name} — Fiend`;
    activity.textContent = `scene ${id.slice(0,8)} / ${shared.source === "agent" ? "last edit from agent" : "shared workspace"}`;
    editor.signals.windowResize.dispatch();
    updateStatus();
    window.fiendReady = true;
    document.body.classList.remove("loading");
  } finally {
    applying = false;
    viewport.dom.style.pointerEvents = "";
    document.querySelector("#sidebar").inert = feedback.active;
    if (pending.length && !inFlight) scheduleSave();
  }
}

function scheduleSave(delay = 200) {
  clearTimeout(timer);
  timer = setTimeout(save, delay);
}
function captureLocal() {
  if (applying || !viewDocument) return;
  const current = serialize();
  const patches = diffScene(viewDocument, current);
  if (!patches.length) return;
  pending.push(...patches);
  viewDocument = current;
  updateStatus();
  scheduleSave();
}
function receive(snapshot) {
  received = received.then(() => apply(snapshot)).catch((error) => { state("Could not sync scene", true); toast(error.message); console.error(error); });
  return received;
}
function save() {
  captureLocal();
  if (inFlight) return inFlight.request;
  if (!pending.length || applying) return Promise.resolve();
  const transaction = { id:crypto.randomUUID(), patches:pending.splice(0) };
  inFlight = transaction;
  updateStatus();
  transaction.request = (async () => {
    let retry = false;
    try {
      const response = await fetch(`${api}/save`, { method:"POST", headers:writeHeaders, body:JSON.stringify({ patches:transaction.patches, client:transaction.id }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          if (inFlight?.id === transaction.id) inFlight = undefined;
          toast(result.error);
          const latest = await fetch(api).then((response) => response.json());
          // Reconcile the rejected local operation against the accepted scene.
          viewDocument = undefined;
          await receive({ ...latest, source:transaction.id });
          return;
        }
        throw new Error(result.error);
      }
      await receive(result);
    } catch (error) {
      if (inFlight?.id === transaction.id) {
        pending.unshift(...transaction.patches);
        inFlight = undefined;
        state("Reconnecting…", true);
        retry = true;
      }
      console.error(error);
    } finally {
      if (pending.length && !inFlight) scheduleSave(retry ? 1500 : 200);
    }
  })();
  return transaction.request;
}
function changed() { if (!applying) queueMicrotask(captureLocal); }
for (const name of ["objectAdded", "objectChanged", "objectRemoved", "geometryChanged", "materialChanged", "sceneBackgroundChanged", "sceneEnvironmentChanged", "sceneFogChanged", "sceneGraphChanged", "historyChanged"]) editor.signals[name].add(changed);
// Orbit, zoom, pan, camera selection and resize are local observations.

const transforms = editor.sceneHelpers.children.find((node) => node.isTransformControlsRoot)?.controls;
const feedback = createFeedback({
  api, secret, viewport: viewport.dom, buttonHost: actions,
  setActive(active) {
    document.querySelector("#sidebar").inert = active;
    for (const menu of menubar.dom.querySelectorAll(".menu")) menu.inert = active;
    if (transforms) { transforms.enabled = !active; if (active) transforms.detach(); }
    if (!active) editor.signals.objectSelected.dispatch(editor.selected);
  },
  async capture() {
    await save(); await received;
    while (applying) await received;
    if (!shared || pending.length || inFlight) throw new Error("Wait for the scene to finish syncing before capturing feedback");
    return new Promise((resolve, reject) => {
      const realistic = editor.viewportShading === "realistic";
      const signal = realistic ? editor.signals.pathTracerUpdated : editor.signals.sceneRendered;
      const timeout = setTimeout(() => { signal.remove(captured); reject(new Error("Could not capture the current render. Try another rendering mode.")); }, 5000);
      function captured() {
        if (applying) return;
        signal.remove(captured); clearTimeout(timeout);
        try {
          resolve(captureFeedbackFrame({
            canvas: renderer.domElement, scene: editor.scene, camera: editor.viewportCamera,
            target: editor.controls.toJSON().center, shading: editor.viewportShading,
            revision: shared.revision, selected: editor.selector.selection.map((object) => object.uuid),
          }));
        } catch (error) { reject(error); }
      }
      signal.add(captured);
      if (!realistic) editor.signals.cameraChanged.dispatch();
    });
  },
  async restore(view) {
    const camera = feedbackCamera(view);
    editor.setCameraType(camera.isOrthographicCamera ? "orthographic" : "perspective");
    editor.camera.copy(camera);
    editor.setViewportCamera(editor.camera.uuid);
    editor.controls.fromJSON({ center: view.target });
    editor.setViewportShading(view.shading);
    editor.signals.cameraResetted.dispatch();
    editor.signals.cameraChanged.dispatch();
  },
});
editor.signals.objectSelected.add(() => { if (feedback.active) transforms?.detach(); });

function connect() {
  const url = new URL(`${api}/live`, location.origin); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.onopen = () => { reconnectDelay = 500; updateStatus(); };
  socket.onmessage = (event) => {
    if (event.data === "pong") return;
    const snapshot = JSON.parse(event.data);
    if (snapshot.type === "feedback") { feedback.receive(snapshot); return; }
    if (snapshot.type !== "snapshot") return;
    receive(snapshot);
  };
  socket.onclose = () => { state("Reconnecting…", true); setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(15000, reconnectDelay * 2); };
  socket.onerror = () => socket.close();
}
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send("ping"); }, 25000);
connect();

async function history(action) {
  await save();
  if (pending.length || inFlight) return;
  const response = await fetch(`${api}/${action}`, { method:"POST", headers:writeHeaders, body:"{}" });
  const result = await response.json();
  if (!response.ok) return toast(result.error);
  await receive(result);
}
editor.undo = () => history("undo").catch((error) => toast(error.message));
editor.redo = () => history("redo").catch((error) => toast(error.message));
document.querySelector("#fiend-share").onclick = () => copy(`${location.origin}${BASE}/s/${id}`);
document.querySelector("#fiend-connect").onclick = () => connectDialog(id, secret);
document.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
document.addEventListener("drop", (event) => {
  event.preventDefault(); if (event.dataTransfer.types[0] === "text/plain") return;
  if (event.dataTransfer.items) editor.loader.loadItemList(event.dataTransfer.items); else editor.loader.loadFiles(event.dataTransfer.files);
});
window.addEventListener("resize", () => editor.signals.windowResize.dispatch());
window.addEventListener("beforeunload", (event) => { if (pending.length || inFlight || feedback.hasDraft) { event.preventDefault(); event.returnValue = ""; } });
editor.signals.windowResize.dispatch();
