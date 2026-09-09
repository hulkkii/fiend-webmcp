import { copy } from "./ui.js";

document.querySelector("#copy-endpoint").onclick = () => copy(document.querySelector("#endpoint").textContent.replace(/\s+/g, " ").trim());
