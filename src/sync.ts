import type { Document, Node, SceneJSON } from "./scene";

export type Patch = { op: "set" | "ensure"; path: string[]; value: unknown } | { op: "remove"; path: string[] };
type ObjectEntry = { parent: string | null; order: number; properties: Omit<Node, "children"> };
type FlatScene = {
  root: string;
  properties: Record<string, unknown>;
  objects: Record<string, ObjectEntry>;
  resources: Record<string, Record<string, unknown>>;
  backgroundType: string;
  environmentType: string;
};
const resources = ["geometries", "materials", "textures", "images", "shapes", "skeletons", "animations"];
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flatten(document: Document): FlatScene {
  const properties = { ...document.scene };
  delete (properties as Partial<SceneJSON>).object;
  const assets: FlatScene["resources"] = {};
  for (const key of resources) {
    const items = properties[key];
    assets[key] = {};
    if (Array.isArray(items)) {
      assets[key] = Object.fromEntries(items.map((item) => [item.uuid, item]));
      delete properties[key];
    }
  }
  const objects: FlatScene["objects"] = {};
  function visit(node: Node, parent: string | null, order: number) {
    const { children, ...properties } = node;
    objects[node.uuid] = { parent, order, properties };
    children?.forEach((child, index) => visit(child, node.uuid, index));
  }
  visit(document.scene.object, null, 0);
  return { root: document.scene.object.uuid, properties, objects, resources: assets, backgroundType: document.backgroundType, environmentType: document.environmentType };
}

/** Diff by object/resource UUID, so edits never depend on changing array indices.
 * Camera and orbit controls deliberately do not participate in browser edits. */
export function diffScene(before: Document, after: Document): Patch[] {
  const patches: Patch[] = [];
  const left = flatten(before), right = flatten(after);
  function visit(left: unknown, right: unknown, path: string[]) {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (record(left) && record(right)) {
      for (const key of Object.keys(left)) {
        // A concurrent clone may still reference an asset its original no longer uses.
        if (!Object.hasOwn(right, key) && (path[0] !== "resources" || path.length > 2)) patches.push({ op: "remove", path: [...path, key] });
      }
      for (const key of Object.keys(right)) visit(left[key], right[key], [...path, key]);
      return;
    }
    if (right === undefined) patches.push({ op: "remove", path });
    else patches.push({ op: "set", path, value: right });
  }
  visit(left, right, []);
  // Include dependencies of newly referenced objects. A stale clone can revive a
  // collected mesh asset, but must not overwrite a newer material with old values.
  const assets = new Map<string, { key: string; value: unknown }>();
  for (const [key, values] of Object.entries(right.resources)) for (const [id, value] of Object.entries(values)) assets.set(id, { key, value });
  const supplied = new Set(patches.filter((patch) => patch.op === "set" && patch.path[0] === "resources" && patch.path.length === 3).map((patch) => patch.path[2]));
  const seen = new Set<string>();
  function dependencies(value: unknown) {
    if (typeof value === "string" && assets.has(value) && !seen.has(value)) {
      seen.add(value);
      const asset = assets.get(value)!;
      if (!supplied.has(value)) patches.push({ op: "ensure", path: ["resources", asset.key, value], value: asset.value });
      dependencies(asset.value);
    } else if (Array.isArray(value)) value.forEach(dependencies);
    else if (record(value)) Object.values(value).forEach(dependencies);
  }
  for (const patch of [...patches]) if (patch.op === "set" && patch.path[0] === "objects") dependencies(patch.value);
  return patches;
}

/** Different properties merge; the latest write to the same property wins.
 * A stale edit to a deleted object is ignored rather than resurrecting it. */
export function mergeScene(document: Document, patches: Patch[]): Document {
  const flat = structuredClone(flatten(document));
  for (const patch of patches) {
    if (!patch.path.length || patch.path.length > 80 || patch.path.some((key) => forbidden.has(key))) throw new Error("Invalid edit path");
    if (!["root", "properties", "objects", "resources", "backgroundType", "environmentType"].includes(patch.path[0]!)) throw new Error("Invalid scene edit");
    let target: Record<string, unknown> | undefined = flat as unknown as Record<string, unknown>;
    for (const key of patch.path.slice(0, -1)) {
      const next: unknown = target?.[key];
      if (!record(next)) { target = undefined; break; }
      target = next;
    }
    if (!target) continue;
    const key = patch.path.at(-1)!;
    if (patch.op === "remove") delete target[key];
    else if (patch.op !== "ensure" || !Object.hasOwn(target, key)) target[key] = structuredClone(patch.value);
  }
  const children = new Map<string, [string, ObjectEntry][]>();
  for (const [id, object] of Object.entries(flat.objects)) {
    if (object.parent === null) continue;
    const siblings = children.get(object.parent) ?? [];
    siblings.push([id, object]);
    children.set(object.parent, siblings);
  }
  const visiting = new Set<string>();
  function build(id: string, depth: number): Node {
    const entry = flat.objects[id];
    if (!entry || visiting.has(id) || depth > 64) throw new Error("Invalid scene hierarchy");
    visiting.add(id);
    const object = { ...entry.properties } as Node;
    const ordered = (children.get(id) ?? []).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
    if (ordered.length) object.children = ordered.map(([child]) => build(child, depth + 1));
    visiting.delete(id);
    return object;
  }
  // Reject reparenting cycles, including those disconnected from the root.
  for (const id of Object.keys(flat.objects)) {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current !== null && flat.objects[current]) {
      if (seen.has(current)) throw new Error("Cannot create a hierarchy cycle");
      seen.add(current);
      current = flat.objects[current]!.parent;
    }
  }
  const scene: SceneJSON = { ...flat.properties, object: build(flat.root, 0) };
  const usedGeometry = new Set<unknown>(), usedMaterial = new Set<unknown>();
  function collect(node: Node) {
    usedGeometry.add(node.geometry);
    for (const id of Array.isArray(node.material) ? node.material : [node.material]) usedMaterial.add(id);
    node.children?.forEach(collect);
  }
  collect(scene.object);
  for (const [key, values] of Object.entries(flat.resources)) {
    const items = Object.values(values).filter((item) => key === "geometries" ? usedGeometry.has((item as { uuid: string }).uuid) : key === "materials" ? usedMaterial.has((item as { uuid: string }).uuid) : true);
    if (items.length) scene[key] = items;
  }
  return { ...document, scene, backgroundType: flat.backgroundType, environmentType: flat.environmentType };
}
