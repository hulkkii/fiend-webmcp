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
import { BASE, connectDialog, toast } from "./ui.js";
import { local } from "./local.js";
import { editDocument, editInput, validateDocument } from "./core.js";
import { createFeedback, captureFeedbackFrame, feedbackCamera } from "./feedback.js";
import { exportGLB } from "./export.js";
import { renderSnapshot } from "./capture.js";
import { registerTools } from "./webmcp.js";

THREE.ObjectLoader.registerGeometry("TextGeometry", TextGeometry);
document.body.classList.add("loading", "scene-editor");
const editor = new Editor();
window.editor = editor;
window.THREE = THREE;
editor.config.setKey("autosave", false, "settings/history", false, "project/renderer/type", "WebGLRenderer");
let renderer, snapshot, dirty = false, applying = false, locked = false, timer, dragging = false;
let queue = Promise.resolve();
editor.signals.rendererCreated.add((value) => { renderer = value; });
const viewport = new Viewport(editor);
const toolbar = new Toolbar(editor);
const menubar = new Menubar(editor);
// The local file actions replace upstream project/script imports and publishing.
menubar.dom.querySelector(".menu")?.remove();
menubar.dom.querySelector(".menu.right")?.remove();
const actions = document.createElement("div");
actions.className = "fiend-menubar-actions";
actions.innerHTML = `<span id="fiend-status" role="status">Opening</span><button class="fiend-button" id="fiend-save">Save</button><button class="fiend-button" id="fiend-backup">Backup JSON</button><button class="fiend-button" id="fiend-export">Export GLB</button><button class="fiend-button" id="fiend-connect">Agent tools</button>`;
const scenesLink = document.createElement("a");
scenesLink.id = "fiend-library";
scenesLink.className = "fiend-scenes-link";
scenesLink.href = BASE;
scenesLink.textContent = "\u2190 All scenes";
menubar.dom.prepend(scenesLink);
menubar.dom.append(actions);
for (const panel of [viewport, toolbar, new Sidebar(editor), menubar, new Resizer(editor), new Animation(editor), new AnimationResizer(editor)]) document.body.append(panel.dom);
const status = actions.querySelector("#fiend-status");
const activity = document.createElement("div"); activity.id = "fiend-activity"; document.body.append(activity);
const sidebar = document.querySelector("#sidebar");
const transforms = editor.sceneHelpers.children.find((node) => node.isTransformControlsRoot)?.controls;
let feedback;
function state(text, error = false) { status.textContent = text; status.dataset.state = error ? "error" : "ok"; }
function lock(value) {
  locked = value;
  viewport.dom.style.pointerEvents = value ? "none" : "";
  sidebar.inert = value || !!feedback?.active;
  menubar.dom.inert = value;
  toolbar.dom.inert = value;
}
function run(task) {
  const next = queue.then(async () => {
    if (dragging) throw new Error("Finish the current drag before using this action.");
    // Commit the focused property field before disabling the editor.
    if (document.activeElement?.matches("input,textarea")) document.activeElement.blur();
    lock(true);
    try { return await task(); }
    catch (error) { state(dirty ? "Unsaved changes" : "Action failed", true); throw error; }
    finally { lock(false); }
  });
  queue = next.catch(() => {});
  return next;
}
function serialize() {
  editor.scene.updateMatrixWorld(true);
  return { ...snapshot.document, scene: editor.scene.toJSON(), backgroundType: editor.backgroundType, environmentType: editor.environmentType };
}
function historyStatus() {
  editor.history.undos = Array.from({ length: snapshot.undoCount ?? 0 }, () => ({}));
  editor.history.redos = Array.from({ length: snapshot.redoCount ?? 0 }, () => ({}));
  editor.signals.historyChanged.dispatch();
}
function accepted(value) {
  snapshot = value;
  document.title = `${snapshot.name} - Fiend`;
  activity.textContent = `${snapshot.name} · revision ${snapshot.revision} · saved in this browser`;
  historyStatus();
  state("Saved locally");
}
function disposeScene(scene) {
  const resources = new Set();
  scene.traverse((node) => {
    if (node.geometry) resources.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}
async function parseDocument(value) {
  const document = validateDocument(value);
  const scene = await new THREE.ObjectLoader().parseAsync(document.scene);
  try { return { scene, camera: await new THREE.ObjectLoader().parseAsync(document.camera) }; }
  catch (error) { disposeScene(scene); throw error; }
}
async function apply(value, parsed) {
  const loaded = parsed ?? await parseDocument(value.document);
  const cameraChanged = !snapshot || snapshot.id !== value.id || JSON.stringify(snapshot.document.camera) !== JSON.stringify(value.document.camera) || JSON.stringify(snapshot.document.controls) !== JSON.stringify(value.document.controls);
  const selected = editor.selected?.uuid;
  applying = true;
  try {
    disposeScene(editor.scene);
    editor.signals.sceneGraphChanged.active = false;
    while (editor.scene.children.length) editor.removeObject(editor.scene.children[0]);
    editor.signals.sceneGraphChanged.active = true;
    editor.backgroundType = value.document.backgroundType;
    editor.environmentType = value.document.environmentType;
    editor.setScene(loaded.scene);
    editor.scene.position.copy(loaded.scene.position);
    editor.scene.quaternion.copy(loaded.scene.quaternion);
    editor.scene.scale.copy(loaded.scene.scale);
    if (cameraChanged) {
      editor.setCameraType(loaded.camera.isOrthographicCamera ? "orthographic" : "perspective");
      editor.camera.copy(loaded.camera);
      editor.camera.name = "Editor camera";
      editor.setViewportCamera(editor.camera.uuid);
      if (value.document.controls) editor.controls.fromJSON(value.document.controls);
      editor.signals.cameraResetted.dispatch();
    }
    if (selected && editor.scene.getObjectByProperty("uuid", selected)) editor.selectByUuid(selected);
    else editor.deselect();
    dirty = false;
    accepted(value);
    editor.signals.windowResize.dispatch();
    editor.signals.cameraChanged.dispatch();
  } finally { applying = false; editor.signals.sceneGraphChanged.active = true; }
}
async function flushNow() {
  clearTimeout(timer);
  if (!dirty || !snapshot) return snapshot;
  state("Saving");
  const result = await local.commit(snapshot.id, snapshot.revision, serialize(), "browser");
  dirty = false;
  accepted(result);
  return result;
}
function changed() {
  if (applying || !snapshot) return;
  dirty = true;
  state("Unsaved changes");
  clearTimeout(timer);
  if (!dragging) timer = setTimeout(() => run(flushNow).catch((error) => toast(error.message)), 250);
}
// Commands execute immediately; durable document history owns undo/redo.
editor.execute = (command) => {
  if (locked || applying) return;
  command.execute();
  changed();
};
for (const name of ["objectAdded", "objectChanged", "objectRemoved", "geometryChanged", "materialChanged", "sceneBackgroundChanged", "sceneEnvironmentChanged", "sceneFogChanged", "sceneGraphChanged"]) editor.signals[name].add(changed);
transforms?.addEventListener("mouseDown", () => { dragging = true; clearTimeout(timer); });
transforms?.addEventListener("mouseUp", () => { dragging = false; if (dirty) changed(); });

async function edit(input) {
  return run(async () => {
    await flushNow();
    const parsedInput = editInput.parse(input);
    if (parsedInput.revision !== undefined && parsedInput.revision !== snapshot.revision) throw new Error("Scene revision changed. Inspect the scene and retry.");
    const result = editDocument(snapshot.document, parsedInput.operations);
    const parsed = await parseDocument(result.document);
    let saved;
    try { saved = await local.commit(snapshot.id, snapshot.revision, result.document, "agent"); }
    catch (error) { disposeScene(parsed.scene); throw error; }
    await apply(saved, parsed);
    return { ...saved, created: result.created };
  });
}
async function history(action, revision) {
  return run(async () => {
    await flushNow();
    const saved = await local[action](snapshot.id, revision ?? snapshot.revision);
    await apply(saved);
    return saved;
  });
}
editor.undo = () => history("undo").catch((error) => toast(error.message));
editor.redo = () => history("redo").catch((error) => toast(error.message));

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const dialog = document.createElement("dialog"); dialog.className = "fiend-dialog";
  const title = document.createElement("h2"); title.textContent = "File ready";
  const link = document.createElement("a"); link.className = "fiend-button"; link.href = url; link.download = filename; link.textContent = `Download ${filename}`;
  const close = document.createElement("button"); close.className = "fiend-button"; close.textContent = "Close"; close.onclick = () => dialog.close();
  dialog.append(title, link, close); document.body.append(dialog); dialog.showModal();
  dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); };
  return { filename, bytes: blob.size, revision: snapshot.revision, url, download: "Use the visible download link. This file URL lasts until the dialog closes." };
}
function filename(extension) { return `${snapshot.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "scene"}.${extension}`; }
async function exportScene() {
  // Backup must remain available when browser storage is full.
  const value = { ...snapshot, document: serialize() };
  return { ...download(new Blob([JSON.stringify({ format: "fiend-local", version: 1, snapshot: value })], { type: "application/json" }), filename("json")), format: "json", unsaved: dirty };
}
async function exportAsset(object = "Scene") {
  return run(async () => {
    await flushNow();
    const bytes = await exportGLB(editor.scene, object);
    return { ...download(new Blob([bytes], { type: "model/gltf-binary" }), filename("glb")), format: "glb" };
  });
}
async function capture(input) {
  return run(async () => {
    await flushNow();
    const result = await renderSnapshot(snapshot, input);
    document.querySelector("#fiend-capture-preview")?.remove();
    const dialog = document.createElement("dialog"); dialog.id = "fiend-capture-preview"; dialog.className = "fiend-dialog fiend-capture";
    const image = new Image(); image.src = result.image; image.alt = `Scene capture at revision ${snapshot.revision}`;
    const close = document.createElement("button"); close.className = "fiend-button"; close.textContent = "Close capture"; close.onclick = () => dialog.close();
    dialog.append(image, close); document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal();
    return { ...result, preview: "#fiend-capture-preview" };
  });
}
feedback = createFeedback({
  store: {
    list: (options) => local.feedbackList(snapshot.id, options),
    add: (input) => local.feedbackAdd(snapshot.id, input),
    resolve: (ids) => local.feedbackResolve(snapshot.id, ids),
  },
  viewport: viewport.dom, buttonHost: actions,
  setActive(active) {
    sidebar.inert = active || locked;
    for (const menu of menubar.dom.querySelectorAll(".menu")) menu.inert = active;
    if (transforms) { transforms.enabled = !active; if (active) transforms.detach(); }
    if (!active) editor.signals.objectSelected.dispatch(editor.selected);
  },
  async capture() {
    await run(flushNow);
    return new Promise((resolve, reject) => {
      const realistic = editor.viewportShading === "realistic";
      const signal = realistic ? editor.signals.pathTracerUpdated : editor.signals.sceneRendered;
      const timeout = setTimeout(() => { signal.remove(captured); reject(new Error("Could not capture this rendering mode.")); }, 5000);
      function captured() {
        signal.remove(captured); clearTimeout(timeout);
        try { resolve(captureFeedbackFrame({ canvas: renderer.domElement, scene: editor.scene, camera: editor.viewportCamera, target: editor.controls.toJSON().center, shading: editor.viewportShading === "default" ? "solid" : editor.viewportShading, revision: snapshot.revision, selected: editor.selector.selection.map((object) => object.uuid) })); }
        catch (error) { reject(error); }
      }
      signal.add(captured);
      if (!realistic) editor.signals.cameraChanged.dispatch();
    });
  },
  async restore(view) {
    const camera = feedbackCamera(view);
    editor.setCameraType(camera.isOrthographicCamera ? "orthographic" : "perspective");
    editor.camera.copy(camera); editor.setViewportCamera(editor.camera.uuid);
    editor.controls.fromJSON({ center: view.target });
    editor.setViewportShading(view.shading === "solid" ? "default" : view.shading);
    editor.signals.cameraResetted.dispatch(); editor.signals.cameraChanged.dispatch();
  },
});
editor.signals.objectSelected.add(() => { if (feedback.active) transforms?.detach(); });
const context = {
  getSnapshot: () => snapshot,
  flush: () => run(flushNow), edit, history, exportScene, exportAsset, capture,
  create: (input) => run(async () => {
    if (feedback.hasDraft) throw new Error("Finish the feedback draft before switching scenes.");
    await flushNow();
    const result = await local.create(input);
    await apply(result);
    window.history.replaceState(null, "", `#scene=${result.id}`);
    feedback.reset();
    return result;
  }),
  feedbackList: (input) => local.feedbackList(snapshot.id, input),
  feedbackResolve: async (ids) => { const result = await local.feedbackResolve(snapshot.id, ids); feedback.receive(result); return result; },
};
window.fiend = context;
scenesLink.onclick = (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  run(flushNow).then(() => { location.href = scenesLink.href; }).catch((error) => toast(error.message));
};
actions.querySelector("#fiend-save").onclick = () => run(flushNow).catch((error) => toast(error.message));
actions.querySelector("#fiend-backup").onclick = () => exportScene().catch((error) => toast(error.message));
actions.querySelector("#fiend-export").onclick = () => exportAsset(editor.selected?.uuid ?? "Scene").catch((error) => toast(error.message));
actions.querySelector("#fiend-connect").onclick = () => connectDialog();
editor.signals.animationPanelChanged.add((height) => {
  const visible = height !== false;
  viewport.dom.classList.toggle("with-animation", visible); toolbar.dom.classList.toggle("with-animation", visible);
  viewport.dom.style.bottom = visible ? `${height}px` : ""; toolbar.dom.style.bottom = visible ? `${height + 20}px` : "";
  editor.signals.windowResize.dispatch();
});
document.addEventListener("keydown", (event) => {
  if (locked || event.target.closest?.("dialog")) event.stopImmediatePropagation();
}, true);
window.addEventListener("resize", () => editor.signals.windowResize.dispatch());
window.addEventListener("beforeunload", (event) => { if (dirty || locked || feedback.hasDraft) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("hashchange", () => { if (!dirty && !locked && !feedback.hasDraft) location.reload(); else toast("Save changes before switching scenes."); });
try {
  const id = new URLSearchParams(location.hash.slice(1)).get("scene");
  const initial = id ? await local.load(id) : await local.create({ template: "empty" });
  await apply(initial);
  window.history.replaceState(null, "", `#scene=${initial.id}`);
  await feedback.refresh();
  const registration = await registerTools(context);
  window.fiendTools = registration;
  if (registration.error) toast(`Agent tools could not register: ${registration.error}`);
  actions.querySelector("#fiend-connect").dataset.available = String(!!document.modelContext?.registerTool);
  window.fiendReady = true;
} catch (error) {
  state("Could not open scene", true); toast(error.message); console.error(error);
} finally { document.body.classList.remove("loading"); }
