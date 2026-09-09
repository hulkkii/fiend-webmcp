export const BASE = "/labs/fiend";
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
  catch { const dialog = document.createElement("dialog"); dialog.className = "fiend-dialog"; const code = document.createElement("code"); code.textContent = value; const button = document.createElement("button"); button.className = "fiend-button"; button.textContent = "Close"; button.onclick = () => dialog.close(); dialog.append(code, button); document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal(); }
}
export function connectDialog(id, secret) {
  const endpoint = `${location.origin}${BASE}/mcp`;
  const dialog = document.createElement("dialog");
  dialog.className = "fiend-dialog";
  dialog.setAttribute("aria-labelledby", "connect-title");
  dialog.innerHTML = `<h2 id="connect-title">Connect to Fiend</h2><p>Add this public remote MCP server to your agent. Scene writes require an edit secret.</p><code></code><p class="context"></p><p>Build, inspect, and address feedback with 28 tools. Changes appear live. Share the public scene link for read-only access.</p><div class="actions"><button class="fiend-button close">Close</button><button class="fiend-button copy">Copy MCP URL</button>${secret ? '<button class="fiend-button primary credentials">Copy agent access</button>' : ""}</div>`;
  dialog.querySelector("code").textContent = endpoint;
  dialog.querySelector(".context").textContent = id ? `Scene ID: ${id}. ${secret ? "Copy agent access to provide the ID and edit secret privately to your agent." : "This link is read-only. An edit link is required to change this scene."}` : "Start with create_scene. It returns a public ID, a private edit secret, and separate viewing and editing links.";
  dialog.querySelector(".close").onclick = () => dialog.close();
  dialog.querySelector(".copy").onclick = () => copy(endpoint);
  if (secret) dialog.querySelector(".credentials").onclick = () => copy(JSON.stringify({ scene_id: id, secret }));
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
export async function createScene(button, template = "starter", source_id, name = "Untitled scene") {
  button.disabled = true;
  try {
    const response = await fetch(`${BASE}/api/scenes`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ name, template, source_id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    location.href = `${BASE}/s/${result.id}#secret=${encodeURIComponent(result.secret)}`;
  } catch (error) { toast(error.message); button.disabled = false; }
}
