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
  const prompt = id ? `add ${endpoint} server and then use it to work on this scene\n\nscene_id: ${id}` : `add ${endpoint} server and then use it to build a treasure chest`;
  const dialog = document.createElement("dialog");
  dialog.className = "fiend-dialog";
  dialog.setAttribute("aria-labelledby", "connect-title");
  dialog.innerHTML = `<h2 id="connect-title">Connect agent</h2><p>works best in <a href="http://opencode.ai/v2">opencode2</a></p><code></code><p class="context"></p><div class="actions"><button class="fiend-button close">Close</button><button class="fiend-button primary copy">Copy prompt</button></div>`;
  dialog.querySelector("code").textContent = prompt;
  dialog.querySelector(".context").textContent = secret ? "Paste this into your agent. The copied prompt includes this scene’s edit access." : "Paste this prompt into your agent to get started.";
  dialog.querySelector(".close").onclick = () => dialog.close();
  dialog.querySelector(".copy").onclick = () => copy(secret ? `${prompt}\nsecret: ${secret}` : prompt);
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
