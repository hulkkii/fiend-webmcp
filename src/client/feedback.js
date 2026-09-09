import * as THREE from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { toast } from "./ui.js";

export function captureFeedbackFrame({ canvas, scene, camera, target, shading, revision, selected = [] }) {
  if (!canvas.width || !canvas.height) throw new Error("The viewport is not ready yet");
  const image = document.createElement("canvas");
  const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height));
  image.width = Math.max(1, Math.round(canvas.width * scale));
  image.height = Math.max(1, Math.round(canvas.height * scale));
  image.getContext("2d").drawImage(canvas, 0, 0, image.width, image.height);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const root = clone(scene);
  const originals = [];
  scene.traverse((node) => originals.push(node.uuid));
  let index = 0;
  root.traverse((node) => { node.uuid = originals[index++]; });
  root.updateMatrixWorld(true);
  const frozenCamera = camera.clone();
  camera.getWorldPosition(frozenCamera.position);
  camera.getWorldQuaternion(frozenCamera.quaternion);
  frozenCamera.updateMatrixWorld(true);
  const view = {
    camera: {
      type: camera.type, position: frozenCamera.position.toArray(), quaternion: frozenCamera.quaternion.toArray(), up: camera.up.toArray(),
      near: camera.near, far: camera.far, zoom: camera.zoom,
      ...(camera.isPerspectiveCamera ? { fov: camera.fov } : { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom }),
    },
    target: [...target], shading, width: image.width, height: image.height,
  };
  return { image, root, camera: frozenCamera, view, scene_revision: revision, selected };
}

export function feedbackCamera(view) {
  const state = view.camera;
  const camera = state.type === "OrthographicCamera"
    ? new THREE.OrthographicCamera(state.left ?? -1, state.right ?? 1, state.top ?? 1, state.bottom ?? -1, state.near, state.far)
    : new THREE.PerspectiveCamera(state.fov ?? 45, view.width / view.height, state.near, state.far);
  camera.position.fromArray(state.position);
  camera.quaternion.fromArray(state.quaternion);
  camera.up.fromArray(state.up);
  camera.zoom = state.zoom;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  return camera;
}

function targetFor(frame, object, point) {
  const target = { uuid: object.uuid, name: (object.name || object.type).slice(0, 120), type: object.type };
  if (point) target.point = point.toArray();
  const box = new THREE.Box3().setFromObject(object);
  if (!box.isEmpty()) {
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).project(frame.camera);
      if (p.z >= -1 && p.z <= 1) corners.push([(p.x + 1) / 2, (1 - p.y) / 2]);
    }
    if (corners.length) target.rect = [
      Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1])),
    ].map((value) => THREE.MathUtils.clamp(value, 0, 1));
  }
  return target;
}

function fit(image, width, height) {
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale, h = image.height * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

function paint(context, width, height, image, strokes = [], targets = []) {
  const rect = fit(image, width, height);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#080808"; context.fillRect(0, 0, width, height);
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  const position = ([x, y]) => [rect.x + x * rect.width, rect.y + y * rect.height];
  const weight = Math.max(2, rect.width / 450);
  for (const stroke of strokes) {
    const points = stroke.points.map(position);
    const first = points[0], last = points.at(-1);
    for (const [color, lineWidth] of [["#080808", weight + 2], ["#ff8178", weight]]) {
      context.strokeStyle = color; context.fillStyle = color; context.lineWidth = lineWidth;
      context.lineCap = "round"; context.lineJoin = "round"; context.beginPath();
      if (stroke.kind === "box") context.rect(first[0], first[1], last[0] - first[0], last[1] - first[1]);
      else if (stroke.kind === "circle") context.ellipse((first[0] + last[0]) / 2, (first[1] + last[1]) / 2, Math.max(.5, Math.abs(last[0] - first[0]) / 2), Math.max(.5, Math.abs(last[1] - first[1]) / 2), 0, 0, Math.PI * 2);
      else {
        context.moveTo(...first);
        for (const point of points.slice(1)) context.lineTo(...point);
        if (points.length === 1) context.lineTo(first[0] + .1, first[1] + .1);
        if (stroke.kind === "arrow") {
          const angle = Math.atan2(last[1] - first[1], last[0] - first[0]);
          const length = weight * 5;
          for (const offset of [-.5, .5]) {
            context.moveTo(...last);
            context.lineTo(last[0] - Math.cos(angle + offset) * length, last[1] - Math.sin(angle + offset) * length);
          }
        }
      }
      context.stroke();
    }
  }
  targets.forEach((target, index) => {
    if (!target.rect) return;
    const [x, y] = position(target.rect.slice(0, 2));
    const [right, bottom] = position(target.rect.slice(2));
    context.strokeStyle = "#eee"; context.lineWidth = 1; context.setLineDash([5, 4]);
    context.strokeRect(x, y, right - x, bottom - y); context.setLineDash([]);
    context.font = "12px monospace";
    const label = `${index + 1}. ${target.name.slice(0, 24)}`;
    const top = Math.max(rect.y, y - 20);
    context.fillStyle = "#080808"; context.fillRect(x, top, context.measureText(label).width + 8, 19);
    context.fillStyle = "#eee"; context.fillText(label, x + 4, top + 14);
  });
}

export function createFeedback({ api, secret, viewport, buttonHost, capture, restore, setActive = () => {} }) {
  const toggle = document.createElement("button");
  toggle.className = "fiend-button fiend-feedback-toggle";
  toggle.textContent = "Feedback"; toggle.setAttribute("aria-pressed", "false");
  buttonHost.prepend(toggle);
  const panel = document.createElement("section");
  panel.id = "feedback-panel"; panel.hidden = true;
  panel.innerHTML = `<div class="feedback-heading"><h2>Feedback</h2><button class="fiend-button feedback-close" aria-label="Close feedback">Close</button></div>${secret ? '<form class="feedback-form"><div class="feedback-compose-actions"><button type="button" class="fiend-button feedback-capture">Capture view</button><button type="button" class="fiend-button feedback-live">Live view</button></div><p class="feedback-context">Capture a view to select objects or draw on it.</p><label for="feedback-text">Note for your agent</label><textarea id="feedback-text" rows="3" maxlength="4000" placeholder="What would you like changed?" required></textarea><button class="fiend-button primary feedback-submit" type="submit">Leave note</button></form>' : '<p class="feedback-readonly">Notes from collaborators. An edit link is required to leave feedback.</p>'}<div class="feedback-notes"></div><button class="fiend-button feedback-more" hidden>Load more</button>`;
  document.body.append(panel);
  const surface = document.createElement("div");
  surface.className = "feedback-surface"; surface.hidden = true;
  const canvas = document.createElement("canvas");
  const tools = document.createElement("div"); tools.className = "feedback-tools";
  tools.innerHTML = `${secret ? '<select aria-label="Feedback tool" class="Select"><option value="select">Select objects</option><option value="pen">Draw</option><option value="arrow">Arrow</option><option value="box">Box</option><option value="circle">Circle</option></select><button class="fiend-button feedback-undo" type="button">Undo mark</button>' : ''}<span class="feedback-view-label"></span><button class="fiend-button feedback-resume" type="button">Live view</button>`;
  surface.append(canvas, tools); viewport.append(surface);
  const form = panel.querySelector("form"), text = panel.querySelector("textarea"), submit = panel.querySelector(".feedback-submit");
  const mode = tools.querySelector("select"), undo = tools.querySelector(".feedback-undo");
  let opened = false, draft, preview, showingDraft = false, stroke, busy = false;
  let notes = [], version = -1, pendingCount = 0, nextAfter = 0, requestEpoch = 0, previewEpoch = 0;
  const context = canvas.getContext("2d");
  const writes = { "content-type": "application/json", authorization: `Bearer ${secret}` };

  function count(value) {
    pendingCount = value;
    toggle.textContent = value ? `Feedback (${value})` : "Feedback";
  }
  function layout() {
    const sidebar = document.getElementById("sidebar").getBoundingClientRect();
    Object.assign(panel.style, { left: `${sidebar.left}px`, top: `${sidebar.top}px`, width: `${sidebar.width}px`, height: `${sidebar.height}px` });
    const rect = viewport.getBoundingClientRect(), ratio = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    repaint();
  }
  new ResizeObserver(layout).observe(viewport);
  new ResizeObserver(layout).observe(document.getElementById("sidebar"));
  function repaint() {
    const frame = showingDraft ? draft?.frame : preview;
    if (!frame) return;
    const rect = viewport.getBoundingClientRect();
    paint(context, rect.width, rect.height, frame.image, showingDraft ? draft.strokes : [], showingDraft ? draft.targets : []);
  }
  function updateComposer() {
    if (!secret) return;
    submit.disabled = busy || !draft || !text.value.trim();
    panel.querySelector(".feedback-capture").disabled = busy;
    panel.querySelector(".feedback-context").textContent = draft
      ? `Captured at r${draft.frame.scene_revision} · ${draft.targets.length ? draft.targets.map((target) => target.name).join(", ") : "General note"}`
      : "Capture a view to select objects or draw on it.";
    mode.hidden = !showingDraft; undo.hidden = !showingDraft;
  }
  function live() {
    previewEpoch++; preview = undefined; showingDraft = false; surface.hidden = true; stroke = undefined;
    updateComposer();
  }
  function showDraft() {
    if (!draft) return;
    previewEpoch++; preview = undefined; showingDraft = true; surface.hidden = false;
    tools.querySelector(".feedback-view-label").textContent = `Captured view · r${draft.frame.scene_revision}`;
    updateComposer(); layout();
  }
  async function beginDraft() {
    if (!secret || busy) return;
    busy = true; updateComposer();
    try {
      live();
      const frame = await capture();
      draft = { id: crypto.randomUUID(), frame, targets: [], strokes: [] };
      for (const uuid of frame.selected.slice(0, 20)) {
        const object = frame.root.getObjectByProperty("uuid", uuid);
        if (object) draft.targets.push(targetFor(frame, object));
      }
      if (opened) showDraft();
    } catch (error) { toast(error.message); }
    finally { busy = false; updateComposer(); }
  }
  async function showNote(note) {
    const epoch = ++previewEpoch;
    try {
      await restore(note.view);
      const image = new Image(); image.src = note.image_url;
      await image.decode();
      if (epoch !== previewEpoch || !opened) return;
      preview = { id: note.id, image }; showingDraft = false; surface.hidden = false;
      tools.querySelector(".feedback-view-label").textContent = `Saved feedback · r${note.scene_revision}`;
      updateComposer(); layout();
    } catch (error) { if (epoch === previewEpoch) toast(error.message); }
  }
  async function resolve(id) {
    try {
      const response = await fetch(`${api}/feedback/resolve`, { method: "POST", headers: writes, body: JSON.stringify({ feedback_ids: [id] }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      receive(result);
    } catch (error) { toast(error.message); }
  }
  function renderNotes() {
    const container = panel.querySelector(".feedback-notes"); container.replaceChildren();
    if (!notes.length) {
      const empty = document.createElement("p"); empty.className = "feedback-empty"; empty.textContent = "No pending feedback."; container.append(empty);
    }
    for (const note of notes) {
      const article = document.createElement("article"); article.className = "feedback-note";
      const body = document.createElement("p"); body.textContent = note.text;
      const meta = document.createElement("div"); meta.className = "feedback-meta";
      meta.textContent = `r${note.scene_revision} · ${note.targets.length ? note.targets.map((target) => target.name).join(", ") : "General note"}`;
      const actions = document.createElement("div"); actions.className = "feedback-note-actions";
      const view = document.createElement("button"); view.className = "fiend-button"; view.textContent = "View"; view.onclick = () => showNote(note); actions.append(view);
      if (secret) {
        const done = document.createElement("button"); done.className = "fiend-button"; done.textContent = "Resolve"; done.onclick = () => resolve(note.id); actions.append(done);
      }
      article.append(body, meta, actions); container.append(article);
    }
  }
  async function refresh(append = false) {
    const epoch = ++requestEpoch;
    try {
      const response = await fetch(`${api}/feedback?limit=20&after=${append ? nextAfter : 0}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (epoch !== requestEpoch || result.version < version) return;
      version = result.version; count(result.pending_count); nextAfter = result.next_after;
      notes = append ? [...notes, ...result.notes] : result.notes;
      panel.querySelector(".feedback-more").hidden = !result.has_more;
      renderNotes();
    } catch (error) { if (opened && epoch === requestEpoch) toast(error.message); }
  }
  function receive(event) {
    if (preview && event.resolved_ids?.includes(preview.id)) live();
    if (event.version < version) return;
    version = event.version; count(event.pending_count);
    if (opened) refresh();
  }
  function open() {
    opened = true; panel.hidden = false; document.body.classList.add("feedback-open"); toggle.setAttribute("aria-pressed", "true");
    setActive(true); layout(); refresh();
    if (secret) { if (draft) showDraft(); else beginDraft(); }
  }
  function close() {
    opened = false; panel.hidden = true; live(); document.body.classList.remove("feedback-open"); toggle.setAttribute("aria-pressed", "false"); setActive(false);
  }
  toggle.onclick = () => opened ? close() : open();
  panel.querySelector(".feedback-close").onclick = close;
  panel.querySelector(".feedback-more").onclick = () => refresh(true);
  tools.querySelector(".feedback-resume").onclick = live;
  panel.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); event.stopPropagation(); });
  document.addEventListener("keydown", (event) => {
    if (!opened || panel.contains(event.target)) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    // Editor shortcuts must not change geometry while annotating a captured view.
    event.stopImmediatePropagation();
    if (event.key === "Backspace" || event.key === "Delete") event.preventDefault();
  }, true);

  function imagePoint(event) {
    if (!draft) return;
    const bounds = canvas.getBoundingClientRect(), rect = fit(draft.frame.image, bounds.width, bounds.height);
    const x = (event.clientX - bounds.left - rect.x) / rect.width, y = (event.clientY - bounds.top - rect.y) / rect.height;
    return [Number(THREE.MathUtils.clamp(x, 0, 1).toFixed(4)), Number(THREE.MathUtils.clamp(y, 0, 1).toFixed(4))];
  }
  canvas.onpointerdown = (event) => {
    event.preventDefault(); event.stopPropagation();
    if (!secret || !showingDraft || !draft || busy || event.button !== 0) return;
    const point = imagePoint(event);
    if (mode.value === "select") {
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(point[0] * 2 - 1, 1 - point[1] * 2), draft.frame.camera);
      const hit = ray.intersectObjects(draft.frame.root.children, true).find((hit) => {
        for (let node = hit.object; node; node = node.parent) if (!node.visible) return false;
        return true;
      });
      if (!hit) return;
      const index = draft.targets.findIndex((target) => target.uuid === hit.object.uuid);
      if (index >= 0) draft.targets.splice(index, 1);
      else if (draft.targets.length < 20) draft.targets.push(targetFor(draft.frame, hit.object, hit.point));
      updateComposer(); repaint(); return;
    }
    if (draft.strokes.length >= 50) return toast("Up to 50 marks per note");
    stroke = { kind: mode.value, points: [point] }; draft.strokes.push(stroke);
    canvas.setPointerCapture(event.pointerId); repaint();
  };
  canvas.onpointermove = (event) => {
    if (!stroke || !showingDraft || busy) return;
    const point = imagePoint(event);
    if (stroke.kind !== "pen") stroke.points[1] = point;
    else {
      const last = stroke.points.at(-1);
      if (Math.hypot(last[0] - point[0], last[1] - point[1]) < .002) return;
      if (stroke.points.length < 512) stroke.points.push(point); else stroke.points[511] = point;
    }
    repaint();
  };
  canvas.onpointerup = canvas.onpointercancel = () => { stroke = undefined; };
  canvas.onwheel = (event) => event.preventDefault();
  if (secret) {
    mode.onchange = () => { canvas.style.cursor = mode.value === "select" ? "pointer" : "crosshair"; };
    undo.onclick = () => { if (draft) { draft.strokes.pop(); repaint(); } };
    text.oninput = updateComposer;
    panel.querySelector(".feedback-capture").onclick = beginDraft;
    panel.querySelector(".feedback-live").onclick = live;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!draft || busy || !text.value.trim()) return;
      busy = true; stroke = undefined; updateComposer();
      try {
        const screenshot = document.createElement("canvas"); screenshot.width = draft.frame.image.width; screenshot.height = draft.frame.image.height;
        paint(screenshot.getContext("2d"), screenshot.width, screenshot.height, draft.frame.image, draft.strokes, draft.targets);
        const response = await fetch(`${api}/feedback`, { method: "POST", headers: writes, body: JSON.stringify({
          id: draft.id, text: text.value.trim(), scene_revision: draft.frame.scene_revision, targets: draft.targets, strokes: draft.strokes, view: draft.frame.view, image: screenshot.toDataURL("image/jpeg", .88),
        }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        draft = undefined; text.value = ""; live(); receive(result); toast("Feedback added");
      } catch (error) { toast(error.message); }
      finally { busy = false; updateComposer(); }
    };
    updateComposer();
  }
  layout();
  return { receive, get active() { return opened; }, get hasDraft() { return !!text?.value.trim(); } };
}
