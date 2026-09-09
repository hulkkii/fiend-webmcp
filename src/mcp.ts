import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import puppeteer from "@cloudflare/puppeteer";
import { z } from "zod";
import { BASE, bounds, createInput, editInput, find, inspect, operation, sceneID, SceneError, type Snapshot } from "./scene";
import { readJSON, type Env } from "./room";
import { createSecret, editSecret, secretHash } from "./access";
import { resolveFeedbackInput, type FeedbackPage, type FeedbackResolution } from "./feedback";

export function sceneURL(origin: string, id: string) { return `${origin}${BASE}/s/${id}`; }
export function glbURL(origin: string, id: string, object = "Scene") {
  const url = new URL(`${sceneURL(origin, id)}.glb`);
  if (object !== "Scene") url.searchParams.set("object", object);
  return url.href;
}

export async function room<T = Snapshot & { created?: { uuid: string; name: string }[] }>(env: Env, id: string, path = "/", body?: unknown, secret?: string): Promise<T> {
  sceneID.parse(id);
  const stub = env.SCENES.getByName(id);
  const headers = new Headers({ "content-type": "application/json" });
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  const response = await stub.fetch(`https://scene${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.json<{ error: string }>();
    throw new SceneError(result.error, response.status);
  }
  return response.json();
}

export async function createScene(env: Env, origin: string, input: z.infer<typeof createInput>) {
  const id = crypto.randomUUID();
  const secret = createSecret();
  const source = input.source_id ? await room(env, input.source_id) : undefined;
  const snapshot = await room(env, id, "/create", { name: input.name, template: input.template, id, secret_hash: await secretHash(secret), document: source?.document });
  const url = sceneURL(origin, id);
  return { id, secret, name: snapshot.name, revision: snapshot.revision, url, edit_url: `${url}#secret=${secret}`, glb_url: glbURL(origin, id), mcp: `${origin}${BASE}/mcp` };
}

function text(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function errorResult(error: unknown) {
  return { isError: true, ...text({ error: error instanceof Error ? error.message : "Tool failed" }) };
}

const toolNames: Record<z.infer<typeof operation>["type"], [string, string]> = {
  add_mesh: ["add_mesh", "Create a primitive mesh with a name, dimensions, transform and PBR material. Returns its UUID. Coordinates use Y-up; rotations are radians."],
  add_extrusion: ["add_extrusion", "Extrude a closed 2D outline along Z with optional bevel. Make custom silhouettes, signs, blades, walls and flat props without writing geometry code."],
  add_lathe: ["add_lathe", "Revolve a [radius,height] profile around Y. Make low-poly bottles, barrels, vases, wheels and turned parts with a controlled segment count."],
  add_tube: ["add_tube", "Build a tube following a smooth 3D path. Useful for pipes, cables, handles, branches and curved structural parts."],
  add_group: ["add_group", "Create a group for arranging objects hierarchically. Reference it by UUID or a unique name in later tools or batch operations."],
  add_light: ["add_light", "Create an ambient, hemisphere, directional or point light. Directional lights aim at the origin."],
  transform: ["update_object", "Set an object's local position, Euler rotation (radians), scale, or visibility. Unspecified properties stay unchanged."],
  material: ["set_material", "Change a mesh's PBR material: color, roughness, metalness, opacity, emissive or wireframe. Shared materials are copied so other meshes are unaffected."],
  light: ["set_light", "Change an existing light's color, intensity, ground color, distance or decay."],
  duplicate: ["duplicate_object", "Deep-copy an object or group with fresh UUIDs. Optionally choose a parent and transform. Materials can be edited independently afterwards."],
  rename: ["rename_object", "Rename an object. Prefer unique, meaningful names to make subsequent tool calls easier."],
  remove: ["remove_object", "Remove an object and all its children. Can be undone with undo_scene."],
  reparent: ["reparent_object", "Move an object into another group, preserving its local transform. Use Scene for the root."],
  background: ["set_background", "Set the scene background to a six-digit hex color."],
  camera: ["set_camera", "Set the shared perspective camera position, look-at target and optional field of view. Viewers see the new framing live."],
  frame: ["frame_object", "Fit the shared camera around an object, group or entire Scene using world-space geometry bounds. Direction is from target to camera; [0,0,1] is front, [1,0,0] is side, [0,1,0] is top."],
};

export async function handleMcp(request: Request, env: Env) {
  // Stateless MCP has no server-initiated event stream or session to delete.
  if (request.method === "GET" || request.method === "DELETE") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const origin = new URL(request.url).origin;
  const server = new McpServer({ name: "fiend", version: "0.1.0" }, {
    instructions: "Fiend is a public, collaborative Three.js editor. create_scene returns id, secret, url (public read-only), edit_url (private collaborative URL with the secret in its fragment), and glb_url. Give the owner edit_url and use url for public sharing. Retain the secret privately; it is only returned at creation. Scene edits, undo/redo and resolve_feedback require secret. Reads and GLB downloads require only the public ID. To download a game-ready GLB, fetch https://anoma.ly/labs/fiend/s/{scene_id}.glb directly; no tool call or secret is needed. Add ?object={URL-encoded object UUID or unique name} to export a specific group. Fetching generates the current asset on demand, strips preview lights/cameras and preserves geometry, materials and hierarchy. export_asset simply returns this URL. The URL follows the latest scene; download the file into your game for a fixed asset. Never put secrets in scene data, feedback, public URLs or exports. To copy a scene, use create_scene with source_id. When the user left feedback, call get_feedback, read all pages, make the requested changes, then resolve_feedback with only the addressed IDs. Fetching never clears notes. Feedback records the original view/revision, so inspect current objects before editing. Select objects by UUID or unique name. Units are meters, Y is up, rotations are XYZ radians, colors are #rrggbb. Use edit_scene for atomic batches and frame_object then capture_scene to inspect results. Browser navigation and feedback do not create scene revisions. Prefer compact inspection over full JSON.",
  });
  server.registerTool("create_scene", { description: "Create a persistent scene and return its public id, private edit secret, read-only url, collaborative edit_url and direct glb_url. Save the secret; it is only returned at creation. No account required. Optionally copy an existing public scene using source_id.", inputSchema: createInput.shape }, async (input) => {
    try { return text(await createScene(env, origin, input)); } catch (error) { return errorResult(error); }
  });
  server.registerTool("inspect_scene", { description: "Get the scene hierarchy, object UUIDs/names, transforms, materials, shared camera and current revision. Compact alternative to raw scene JSON.", inputSchema: { scene_id: sceneID }, annotations: { readOnlyHint: true } }, async ({ scene_id }) => {
    try { return text({ ...inspect(await room(env, scene_id)), url: sceneURL(origin, scene_id), glb_url: glbURL(origin, scene_id) }); } catch (error) { return errorResult(error); }
  });
  server.registerTool("inspect_object", { description: "Inspect an object or group by UUID or unique name, including its raw Three.js properties, materials and world-space bounds. Useful for precise placement and sizing.", inputSchema: { scene_id: sceneID, object: z.string() }, annotations: { readOnlyHint: true } }, async ({ scene_id, object }) => {
    try {
      const snapshot = await room(env, scene_id);
      const node = find(snapshot.document.scene.object, object);
      const box = bounds(snapshot.document, object);
      const ids = Array.isArray(node.material) ? node.material : [node.material];
      return text({ revision: snapshot.revision, object: node, materials: snapshot.document.scene.materials?.filter((item) => ids.includes(item.uuid)), bounds: box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() } });
    } catch (error) { return errorResult(error); }
  });
  async function edit(id: string, secret: string, body: unknown) {
    const result = await room(env, id, "/edit", body, secret);
    return text({ id, revision: result.revision, created: result.created, url: sceneURL(origin, id) });
  }
  server.registerTool("edit_scene", { description: "Apply 1–100 operations atomically with one broadcast and one undo step. Requires the scene edit secret. If any operation fails, nothing changes. Later operations can refer to names created earlier in the batch. Optional revision prevents stale edits.", inputSchema: { scene_id: sceneID, secret: editSecret, ...editInput.shape } }, async ({ scene_id, secret, ...input }) => {
    try { return await edit(scene_id, secret, input); } catch (error) { return errorResult(error); }
  });
  for (const schema of operation.options) {
    const type = schema.shape.type.value;
    const [name, description] = toolNames[type];
    const { type: _, ...fields } = schema.shape;
    const inputSchema: z.ZodRawShape = { scene_id: sceneID, secret: editSecret, ...fields, revision: editInput.shape.revision };
    server.registerTool(name, { description, inputSchema }, async (input) => {
      const { scene_id, secret, revision, ...args } = input;
      try { return await edit(sceneID.parse(scene_id), editSecret.parse(secret), { operations: [{ type, ...args }], revision }); } catch (error) { return errorResult(error); }
    });
  }
  for (const action of ["undo", "redo"] as const) {
    server.registerTool(`${action}_scene`, { description: `${action === "undo" ? "Undo" : "Redo"} the most recent shared scene edit. Requires the edit secret. Supports the last 20 edits, including browser edits and atomic MCP batches.`, inputSchema: { scene_id: sceneID, secret: editSecret, revision: editInput.shape.revision } }, async ({ scene_id, secret, revision }) => {
      try { const snapshot = await room(env, scene_id, `/${action}`, { revision }, secret); return text({ id: scene_id, revision: snapshot.revision, url: sceneURL(origin, scene_id) }); } catch (error) { return errorResult(error); }
    });
  }
  server.registerTool("get_scene_link", { description: "Return the public read-only share link and direct glb_url for a scene. Fetch glb_url to generate and download the current asset. These URLs cannot authorize writes or reveal the edit secret.", inputSchema: { scene_id: sceneID }, annotations: { readOnlyHint: true } }, async ({ scene_id }) => {
    try { const snapshot = await room(env, scene_id); return text({ id: scene_id, name: snapshot.name, url: sceneURL(origin, scene_id), glb_url: glbURL(origin, scene_id) }); } catch (error) { return errorResult(error); }
  });
  server.registerTool("get_feedback", {
    description: "Fetch pending human feedback with object UUIDs/names, saved camera/rendering mode, scene revision, drawing summaries and annotated screenshots. Reading never clears notes. Follow next_after when has_more, then resolve only the notes you address. Images are in note order, labeled by feedback ID. Raw normalized drawing points are optional to keep the normal response compact.",
    inputSchema: { scene_id: sceneID, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(10).default(5), include_images: z.boolean().default(true), include_strokes: z.boolean().default(false) },
    annotations: { readOnlyHint: true },
  }, async ({ scene_id, after, limit, include_images, include_strokes }) => {
    try {
      const page = await room<FeedbackPage>(env, scene_id, `/feedback?after=${after}&limit=${limit}&images=${include_images ? 1 : 0}`);
      const notes = page.notes.map(({ image, strokes, ...note }) => ({
        ...note, image_url: `${origin}${note.image_url}`,
        drawings: strokes.map((stroke) => ({ kind: stroke.kind, point_count: stroke.points.length })),
        ...(include_strokes ? { strokes } : {}),
      }));
      const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [
        { type: "text", text: JSON.stringify({ ...page, notes }, null, 2) },
      ];
      for (const note of page.notes) if (note.image) content.push({ type: "text", text: `Annotated screenshot for feedback ${note.id}` }, { type: "image", mimeType: "image/jpeg", data: note.image });
      return { content };
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("resolve_feedback", {
    description: "Clear specific feedback notes and their screenshots after addressing them. Requires the scene edit secret. Only the supplied IDs are cleared; notes added meanwhile remain pending. Repeating a resolution is safe. Does not alter the scene or its undo history.",
    inputSchema: { scene_id: sceneID, secret: editSecret, ...resolveFeedbackInput.shape },
  }, async ({ scene_id, secret, feedback_ids }) => {
    try { return text(await room<FeedbackResolution>(env, scene_id, "/feedback/resolve", { feedback_ids }, secret)); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("export_scene", { description: "Export the full Three.js scene JSON and camera. For normal inspection prefer inspect_scene to save context. The download URL can be opened directly.", inputSchema: { scene_id: sceneID }, annotations: { readOnlyHint: true } }, async ({ scene_id }) => {
    try { const snapshot = await room(env, scene_id); return text({ ...snapshot, download: `${origin}${BASE}/api/scenes/${scene_id}/export` }); } catch (error) { return errorResult(error); }
  });
  server.registerTool("capture_scene", { description: "Render the scene from its saved camera and return a PNG image plus labeled object screen positions. Runs in a Cloudflare browser, even when no viewer is connected. Use frame_object or set_camera first to choose the view.", inputSchema: { scene_id: sceneID, width: z.number().int().min(256).max(1600).default(1024), height: z.number().int().min(256).max(1200).default(768) }, annotations: { readOnlyHint: true } }, async ({ scene_id, width, height }) => {
    try {
      await room(env, scene_id);
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        await page.goto(`${origin}${BASE}/render/${scene_id}`, { waitUntil: "networkidle0", timeout: 45000 });
        await page.waitForFunction("window.fiendCapture || window.fiendError", { timeout: 30000 });
        const result = await page.evaluate("window.fiendError ? { error: window.fiendError } : window.fiendCapture()") as { error?: string; image: string; objects: unknown; revision: number };
        if (result.error) throw new Error(result.error);
        return { content: [{ type: "image" as const, mimeType: "image/png", data: result.image.split(",")[1]! }, { type: "text" as const, text: JSON.stringify({ revision: result.revision, width, height, objects: result.objects, url: sceneURL(origin, scene_id) }) }] };
      } finally { await browser.close(); }
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("export_asset", {
    description: "Return a public URL to download a self-contained GLB of the scene or selected object/group. No secret required. Fetch the URL to generate the current asset on demand; no separate export job is needed. Preview lights/cameras are excluded, with names, hierarchy, pivots and PBR materials preserved. Download the file into your game for a fixed asset, since the URL follows scene updates.",
    inputSchema: { scene_id: sceneID, object: z.string().min(1).max(200).default("Scene"), secret: editSecret.optional().describe("Not required; accepted for older clients") },
    annotations: { readOnlyHint: true },
  }, async ({ scene_id, object }) => {
    try {
      const snapshot = await room(env, scene_id);
      find(snapshot.document.scene.object, object);
      return text({ scene_id, object, revision: snapshot.revision, format: "glb", url: glbURL(origin, scene_id, object), scene: sceneURL(origin, scene_id) });
    } catch (error) { return errorResult(error); }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, request.method === "POST" ? { parsedBody: await readJSON(request) } : undefined);
  } finally { await server.close(); }
}
