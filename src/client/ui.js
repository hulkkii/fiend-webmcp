import { local } from "./local.js";

export const BASE = new URL("./", import.meta.url).pathname;
export function toast(message) {
  document.querySelector(".fiend-toast")?.remove();
  const el = document.createElement("div");
  el.className = "fiend-toast";
  el.textContent = message;
  el.setAttribute("role", "status");
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}
export async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast("Copied to clipboard"); }
  catch {
    const dialog = document.createElement("dialog"); dialog.className = "fiend-dialog";
    const code = document.createElement("code"); code.textContent = value;
    const button = document.createElement("button"); button.className = "fiend-button";
    button.textContent = "Close"; button.onclick = () => dialog.close();
    dialog.append(code, button); document.body.append(dialog);
    dialog.onclose = () => dialog.remove(); dialog.showModal();
  }
}
export function connectDialog() {
  const available = typeof document.modelContext?.registerTool === "function";
  const dialog = document.createElement("dialog");
  dialog.className = "fiend-dialog";
  dialog.setAttribute("aria-labelledby", "connect-title");
  dialog.innerHTML = `<h2 id="connect-title">Browser tools</h2><p class="availability"></p><p>Keep your scene open in a browser that supports WebMCP. Ask your agent to inspect the scene and use its modeling tools. You can edit alongside it and undo its changes in the editor.</p><div class="actions"><button class="fiend-button close">Close</button></div>`;
  dialog.querySelector(".availability").textContent = window.fiendTools?.error ? `Tools could not register: ${window.fiendTools.error}` : available ? "WebMCP is available in this browser. Tools are registered when a scene is open." : "This browser does not expose WebMCP. Manual editing and local saving are available.";
  dialog.querySelector(".close").onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog); dialog.showModal();
}
export async function createScene(button, template = "starter", source_id, name = "Untitled scene") {
  button.disabled = true;
  try {
    const result = await local.create({ name, template, source_id });
    location.href = `${BASE}editor/index.html#scene=${encodeURIComponent(result.id)}`;
  } catch (error) { toast(error.message); button.disabled = false; }
}
