import * as THREE from "three";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { local } from "./local.js";
import { validateDocument } from "./core.js";
import { BASE, toast, createScene, connectDialog } from "./ui.js";

THREE.ObjectLoader.registerGeometry("TextGeometry", TextGeometry);
const list = document.querySelector("#scene-list");
const importButton = document.querySelector("#import-scene");
const input = document.querySelector("#import-file");
document.querySelector("#new-scene").onclick = (event) => createScene(event.currentTarget);
document.querySelector("#connect-agent").onclick = connectDialog;
importButton.onclick = () => input.click();

function action(label, handler) {
  const button = document.createElement("button");
  button.className = "fiend-button"; button.textContent = label;
  button.onclick = async () => {
    button.disabled = true;
    try { await handler(); await refresh(); }
    catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };
  return button;
}
async function refresh() {
  const scenes = await local.list();
  list.replaceChildren();
  if (!scenes.length) { list.textContent = "No scenes yet. Create one or import a backup."; return; }
  for (const scene of scenes) {
    const row = document.createElement("article"); row.className = "scene-row";
    const details = document.createElement("div"); details.className = "scene-details";
    const link = document.createElement("a");
    link.href = `${BASE}editor/index.html#scene=${encodeURIComponent(scene.id)}`;
    link.textContent = scene.name;
    const updated = document.createElement("small");
    updated.textContent = `Saved ${new Date(scene.updatedAt).toLocaleString()}`;
    details.append(link, updated);
    const actions = document.createElement("div"); actions.className = "library-actions";
    actions.append(
      action("Rename", async () => {
        const name = prompt("Scene name", scene.name);
        if (name !== null) await local.rename(scene.id, name);
      }),
      action("Duplicate", () => local.create({ name: `${scene.name} copy`, source_id: scene.id })),
      action("Delete", async () => {
        if (confirm(`Delete "${scene.name}" and its local history? This cannot be undone.`)) await local.delete(scene.id);
      }),
    );
    row.append(details, actions); list.append(row);
  }
}
input.onchange = async () => {
  const file = input.files[0];
  if (!file) return;
  importButton.disabled = true;
  let created;
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error("Scene JSON must be no larger than 50 MiB.");
    const json = JSON.parse(await file.text());
    if (json.format !== undefined && (json.format !== "fiend-local" || json.version !== 1)) throw new Error("Unsupported backup format or version.");
    const snapshot = json.snapshot ?? json;
    const document = validateDocument(snapshot.document ?? snapshot);
    const loader = new THREE.ObjectLoader();
    await loader.parseAsync(document.scene);
    await loader.parseAsync(document.camera);
    created = await local.create({ name: snapshot.name || file.name.replace(/\.json$/i, ""), template: "empty" });
    await local.commit(created.id, created.revision, document, "import");
    location.href = `${BASE}editor/index.html#scene=${encodeURIComponent(created.id)}`;
  } catch (error) {
    if (created) await local.delete(created.id).catch(() => {});
    toast(error.message);
  } finally { input.value = ""; importButton.disabled = false; }
};
refresh().catch((error) => { list.textContent = `Could not load scenes: ${error.message}`; });
window.addEventListener("pageshow", (event) => { if (event.persisted) refresh().catch((error) => toast(error.message)); });
