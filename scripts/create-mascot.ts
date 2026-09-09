import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const client = new Client({ name: "fiend-mascot", version: "2" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://anoma.ly/labs/fiend/mcp")));
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  const item = (result.content as { type: string; text?: string }[]).find((item) => item.type === "text");
  return JSON.parse(item!.text!);
}
try {
  const scene = await call("create_scene", { name: "Fiend — twisted mask", template: "empty" });
  const directory = join(homedir(), ".local/share/fiend");
  await mkdir(directory, { recursive: true });
  const credentials = join(directory, `${scene.id}.json`);
  await Bun.write(credentials, JSON.stringify(scene, null, 2));
  await chmod(credentials, 0o600);

  const ceramic = { color: "#48434d", roughness: .3, metalness: .5 };
  const dark = { color: "#242329", roughness: .35, metalness: .55 };
  const ridge = { color: "#6d6571", roughness: .28, metalness: .55 };
  const light = { color: "#dedbd4", emissive: "#aaa59e", emissiveIntensity: .12, roughness: .42, metalness: .1 };
  const operations: Record<string, unknown>[] = [
    { type: "add_group", name: "Twisted mask" },
    {
      type: "add_extrusion", name: "Warped ceramic face", parent: "Twisted mask",
      points: [[-.68,.61],[-.25,.83],[.04,.64],[.52,.91],[.78,.32],[.55,-.33],[.12,-.88],[-.25,-.61],[-.61,-.19]],
      depth: .26, bevel: .13, position: [0,0,-.12], rotation: [.08,-.12,-.06], material: ceramic,
    },
    {
      type: "add_mesh", name: "Knotted outer shell", parent: "Twisted mask", geometry: "torus_knot",
      size: [.69,.17,1], scale: [.96,1.15,.7], rotation: [.25,.32,.18], position: [0,.02,-.2], material: dark,
    },
    {
      type: "add_extrusion", name: "Left sunken eye", parent: "Twisted mask",
      points: [[-.60,.34],[-.10,.075],[-.13,-.055],[-.46,.105]], depth: .027, bevel: .012,
      position: [0,0,.298], rotation: [0,0,-.025], material: light,
    },
    {
      type: "add_extrusion", name: "Right sunken eye", parent: "Twisted mask",
      points: [[.115,.02],[.61,.36],[.48,.055],[.14,-.105]], depth: .027, bevel: .012,
      position: [0,0,.325], rotation: [0,0,-.025], material: light,
    },
    {
      type: "add_tube", name: "Heavy left brow", parent: "Twisted mask",
      points: [[-.82,.53,.05],[-.55,.43,.32],[-.29,.25,.40],[-.09,.16,.38]], radius: .085, material: ceramic,
    },
    {
      type: "add_tube", name: "Raised right brow", parent: "Twisted mask",
      points: [[.105,.105,.40],[.32,.29,.39],[.59,.48,.32],[.81,.58,.04]], radius: .075, material: ridge,
    },
    {
      type: "add_tube", name: "Crooked frown", parent: "Twisted mask",
      points: [[-.31,-.43,.235],[-.12,-.32,.30],[.09,-.34,.31],[.29,-.49,.25]], radius: .023, material: dark,
    },
    {
      type: "add_tube", name: "Left swept thorn", parent: "Twisted mask",
      points: [[-.51,.50,-.06],[-.83,.85,-.04],[-.94,1.22,.05],[-.78,1.57,.06],[-.45,1.77,-.06]],
      radius: .13, material: ceramic,
    },
    {
      type: "add_mesh", name: "Left thorn point", parent: "Twisted mask", geometry: "cone",
      size: [.135,.51,1], position: [-.27,1.85,-.12], rotation: [-.3,.1,-1.10], material: ceramic,
    },
    {
      type: "add_tube", name: "Right folded thorn", parent: "Twisted mask",
      points: [[.54,.47,-.08],[.88,.88,-.22],[.99,1.29,-.18],[.77,1.56,.02],[.49,1.42,.25],[.55,1.12,.31]],
      radius: .105, material: ridge,
    },
    {
      type: "add_mesh", name: "Inward thorn point", parent: "Twisted mask", geometry: "cone",
      size: [.107,.36,1], position: [.59,.96,.32], rotation: [.1,0,2.9], material: ridge,
    },
    {
      type: "add_tube", name: "Twisted lower seam", parent: "Twisted mask",
      points: [[-.70,-.10,-.03],[-.62,-.54,.06],[-.31,-.85,.05],[.13,-.99,-.04],[.49,-.75,-.23],[.39,-.38,-.36]],
      radius: .09, material: ceramic,
    },
    {
      type: "add_tube", name: "Back tension loop", parent: "Twisted mask",
      points: [[-.56,.48,-.25],[-.34,.73,-.62],[.23,.65,-.71],[.64,.11,-.47],[.42,-.53,-.49],[-.19,-.62,-.67],[-.55,-.16,-.45]],
      radius: .11, closed: true, material: ridge,
    },
    { type: "frame", object: "Twisted mask", direction: [.1,.06,1], padding: 1.2 },
  ];
  await call("edit_scene", { scene_id: scene.id, secret: scene.secret, operations });
  const asset = await call("export_asset", { scene_id: scene.id, secret: scene.secret, object: "Twisted mask" });
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error("Could not download the mascot export");
  await mkdir("src/client/assets", { recursive: true });
  await Bun.write("src/client/assets/fiend.glb", await response.arrayBuffer());
  await Bun.write("src/client/assets/fiend.json", JSON.stringify({ scene_id: scene.id, scene_url: scene.url, asset_url: asset.url, revision: asset.revision }, null, 2));
  console.log(`Created through Fiend: ${scene.url}`);
  console.log(`Edit credentials: ${credentials}`);
} finally { await client.close(); }
