import { BASE, toast } from "./ui.js";

const id = location.pathname.split("/").filter(Boolean).at(-1);
const secret = new URLSearchParams(location.hash.slice(1)).get("secret");
let editable = false;
let accessError;
if (secret) {
  try {
    const response = await fetch(`${BASE}/api/scenes/${id}/access`, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store" });
    editable = response.ok;
    if (!editable) accessError = response.status === 403 ? "This edit link is invalid. The scene is read-only." : "Could not verify edit access. Opening read-only.";
  } catch { accessError = "Could not verify edit access. Opening read-only."; }
}
window.addEventListener("hashchange", () => location.reload());
if (editable) await import("./editor.js");
else {
  await import("./viewer.js");
  if (accessError) toast(accessError);
}
