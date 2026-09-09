import { bounds, createInput, editInput, find, inspect, operation, sceneID, z } from "./core.js";

const operationTools = {
  add_mesh: ["add_mesh", "Add a primitive mesh with PBR material. Units are meters, Y is up; Euler rotations are XYZ radians."],
  add_extrusion: ["add_extrusion", "Extrude a closed XY polygon along +Z, with optional bevel."],
  add_lathe: ["add_lathe", "Revolve a [radius,height] profile around Y."],
  add_tube: ["add_tube", "Build a tube along a smooth 3D centerline."],
  add_group: ["add_group", "Create a group. Later operations can reference its UUID or unique name."],
  add_light: ["add_light", "Add an ambient, hemisphere, directional or point light. Directional lights aim at the origin."],
  transform: ["update_object", "Set local position, XYZ Euler rotation in radians, scale or visibility. Other properties remain unchanged."],
  material: ["set_material", "Change a mesh's PBR material. Shared materials are copied so other meshes are unaffected."],
  light: ["set_light", "Change a light's color, intensity, ground color, distance or decay."],
  duplicate: ["duplicate_object", "Deep-copy an object or group with fresh UUIDs and independently editable materials."],
  rename: ["rename_object", "Rename an object. Use unique names for reliable selection."],
  remove: ["remove_object", "Remove an object and its children. Can be undone with undo_scene."],
  reparent: ["reparent_object", "Move an object into a group, preserving its local transform. Scene selects the root."],
  background: ["set_background", "Set background color as #rrggbb."],
  camera: ["set_camera", "Set the saved capture camera position, target and optional field of view."],
  frame: ["frame_object", "Fit the saved camera to an object, group or Scene. Direction points from target to camera; [0,0,1] is front, [1,0,0] side, [0,1,0] top."],
};

const activeScene = { scene_id: sceneID.optional().describe("Optional guard: must match the scene open in this page. Omit to use the active scene.") };
const selector = z.string().min(1).max(200);
const registrations = new WeakMap();

// Exported for tests; production callers use registerTools.
export function createToolDefinitions(context) {
  const definitions = [];
  let queue = Promise.resolve();
  function add(name, description, shape, handler, readOnly = false, needsScene = true) {
    const schema = z.object(shape).strict();
    definitions.push({
      name, description,
      inputSchema: z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
      annotations: { readOnlyHint: readOnly },
      execute(input = {}) {
        const run = queue.then(async () => {
          try {
            const parsed = schema.parse(input);
            await context.flush();
            const snapshot = context.getSnapshot();
            if (needsScene && !snapshot) throw new Error("Open a local scene first.");
            if (parsed.scene_id && parsed.scene_id !== snapshot?.id) throw new Error("The requested scene is not open. Open it in this page first.");
            return await handler(parsed, snapshot);
          } catch (error) {
            return { isError: true, error: error instanceof Error ? error.message : String(error) };
          }
        });
        queue = run.catch(() => {});
        return run;
      },
    });
  }
  add("create_scene", "Create and open a scene saved in this browser. Optional source_id copies a scene in the same browser.", createInput.shape, async (input) => {
    const result = await context.create(input);
    const snapshot = context.getSnapshot() ?? result;
    return { id: snapshot.id, name: snapshot.name, revision: snapshot.revision };
  }, false, false);
  add("inspect_scene", "Read the active scene hierarchy, UUIDs, transforms, materials, saved camera and revision. Units are meters, Y is up and rotations are XYZ radians. Prefer this to full JSON.", activeScene, (_, snapshot) => inspect(snapshot), true);
  add("inspect_object", "Inspect an object by UUID or unique name, including raw properties, materials and world-space bounds.", { ...activeScene, object: selector }, ({ object }, snapshot) => {
    const node = find(snapshot.document.scene.object, object);
    const box = bounds(snapshot.document, object);
    const ids = Array.isArray(node.material) ? node.material : [node.material];
    return { revision: snapshot.revision, object: node, materials: snapshot.document.scene.materials?.filter((item) => ids.includes(item.uuid)), bounds: box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() } };
  }, true);
  async function edit(input) {
    const result = await context.edit(input);
    const snapshot = context.getSnapshot();
    return { id: snapshot.id, revision: snapshot.revision, created: result?.created ?? [] };
  }
  add("edit_scene", "Apply 1–100 operations atomically as one undo step. A failed operation changes nothing. Later operations can reference names created earlier. Optional revision prevents stale edits.", { ...activeScene, ...editInput.shape }, ({ scene_id, ...input }) => edit(input));
  for (const schema of operation.options) {
    const type = schema.shape.type.value;
    const [name, description] = operationTools[type];
    const { type: omitted, ...shape } = schema.shape;
    add(name, description, { ...activeScene, ...shape, revision: editInput.shape.revision }, ({ scene_id, revision, ...args }) => edit({ operations: [{ type, ...args }], revision }));
  }
  for (const action of ["undo", "redo"]) {
    add(`${action}_scene`, `${action === "undo" ? "Undo" : "Redo"} the most recent edit in the shared manual and agent history. History is bounded by local storage limits.`, { ...activeScene, revision: editInput.shape.revision }, async ({ revision }) => {
      await context.history(action, revision);
      const snapshot = context.getSnapshot();
      return { id: snapshot.id, revision: snapshot.revision };
    });
  }
  add("get_feedback", "Read pending human feedback with saved view, revision and drawing summaries. Reading does not resolve notes. Read all pages then resolve only addressed IDs. Images are local data URLs, also visible in the feedback interface.", {
    ...activeScene, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(10).default(5), include_images: z.boolean().default(false), include_strokes: z.boolean().default(false),
  }, ({ scene_id, ...input }) => context.feedbackList(input), true);
  add("resolve_feedback", "Resolve only the supplied feedback IDs after addressing them. Leaves scene history unchanged.", { ...activeScene, feedback_ids: z.array(z.uuid()).min(1).max(100) }, ({ feedback_ids }) => context.feedbackResolve(feedback_ids));
  add("export_scene", "Prepare a local JSON backup download. Returns filename, format, byte size and revision. The page provides a download action.", activeScene, () => context.exportScene(), true);
  add("export_asset", "Prepare a local GLB download of Scene or an object/group. Excludes preview lights and cameras, preserving hierarchy, pivots and materials. Returned URLs belong to this page only.", { ...activeScene, object: selector.default("Scene") }, ({ object }) => context.exportAsset(object), true);
  add("capture_scene", "Render a PNG locally from the saved camera and display it in the page. Returns object screen positions and bounds; inspect the visible preview with browser vision. Use frame_object or set_camera first.", { ...activeScene, width: z.number().int().min(256).max(1600).default(1024), height: z.number().int().min(256).max(1200).default(768) }, async ({ width, height }) => {
    const { image, ...result } = await context.capture({ width, height });
    return { ...result, preview: result.preview ?? "Capture preview is visible in the page.", format: "png" };
  }, true);
  return definitions;
}

export async function registerTools(context) {
  const api = globalThis.document?.modelContext;
  if (typeof api?.registerTool !== "function") return { supported: false, count: 0 };
  const previous = registrations.get(api);
  if (previous) {
    previous.context.current = context;
    return previous.result;
  }
  const reference = { current: context };
  const proxy = new Proxy({}, { get: (_, key) => (...args) => reference.current[key](...args) });
  const definitions = createToolDefinitions(proxy);
  const registered = [];
  try {
    for (const definition of definitions) {
      await api.registerTool(definition);
      registered.push(definition.name);
    }
    const result = { supported: true, count: registered.length };
    registrations.set(api, { context: reference, result });
    return result;
  } catch (error) {
    if (typeof api.unregisterTool === "function") {
      for (const name of registered) {
        try { await api.unregisterTool(name); } catch { /* Keep the registration error visible. */ }
      }
    }
    return { supported: true, count: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
