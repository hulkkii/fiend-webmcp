import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = "dist/labs/fiend";
await mkdir(root, { recursive: true });
await rm(join(root, "icon.svg"), { force: true });
await Promise.all([
  cp("vendor/three/editor", join(root, "editor"), { recursive: true }),
  cp("vendor/three/examples/fonts", join(root, "examples/fonts"), { recursive: true }),
  cp("node_modules/three/build", join(root, "build"), { recursive: true }),
  cp("node_modules/three/examples/jsm", join(root, "examples/jsm"), { recursive: true }),
  cp("src/client", root, { recursive: true }),
]);
await mkdir(join(root, "lib"), { recursive: true });
await cp("vendor/three/LICENSE", join(root, "lib/three-LICENSE.txt"));
await cp("vendor/draco-LICENSE", join(root, "lib/draco-LICENSE.txt"));
await cp("node_modules/three-gpu-pathtracer/LICENSE", join(root, "lib/pathtracer-LICENSE.txt"));
await cp("node_modules/three-mesh-bvh/LICENSE", join(root, "lib/bvh-LICENSE.txt"));
await cp("node_modules/three-gpu-pathtracer/build/index.module.js", join(root, "lib/pathtracer.js"));
await cp("node_modules/three-mesh-bvh/build/index.module.js", join(root, "lib/bvh.js"));
let html = await Bun.file("vendor/three/editor/index.html").text();
html = html.replace("<title>three.js editor</title>", '<title>Fiend — scene editor</title><base href="/labs/fiend/editor/"><link rel="icon" href="data:,"><link rel="stylesheet" href="../fiend.css">');
html = html.replace(/\s*<link rel="(?:apple-touch-icon|manifest|shortcut icon)"[^>]*>/g, "");
html = html.replace("https://cdn.jsdelivr.net/npm/three-gpu-pathtracer@0.0.23/build/index.module.js", "../lib/pathtracer.js");
html = html.replace("https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.7.4/build/index.module.js", "../lib/bvh.js");
html = html.replace("https://cdn.jsdelivr.net/gh/google/draco@1.5.7/javascript/draco_encoder.js", "js/libs/draco_encoder.js");
html = html.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="../scene.js"></script>');
html = html.replace('<link rel="stylesheet" href="css/main.css">', '<link rel="stylesheet" href="css/main.css"><link rel="stylesheet" href="../editor.css"><link rel="stylesheet" href="../feedback.css">');
await Bun.write(join(root, "editor/index.html"), html);
const sync = await Bun.build({ entrypoints: ["src/sync.ts"], outdir: root, target: "browser", minify: false });
if (!sync.success) throw new AggregateError(sync.logs, "Could not build scene synchronization");
// These two upstream paths assume the editor is mounted at the site root.
for (const file of ["js/Loader.js", "js/libs/ui.three.js"]) {
  const path = join(root, "editor", file);
  await Bun.write(path, (await Bun.file(path).text()).replaceAll("../../examples/", "../examples/"));
}
console.log(`Built Fiend and the upstream Three.js r186 editor → ${root}`);
