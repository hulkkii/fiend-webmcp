import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createLocalStore } from "../src/local";
import { initialDocument, inspect } from "../src/scene";

const store = (historyBytes?: number) => createLocalStore({ indexedDB: new IDBFactory(), historyBytes });
const add = (name: string) => ({ type: "add_mesh", name, geometry: "box" });

describe("local scenes", () => {
  test("separate scenes persist and concurrent tabs cannot overwrite stale revisions", async () => {
    const indexedDB = new IDBFactory();
    const a = createLocalStore({ indexedDB }), b = createLocalStore({ indexedDB });
    const first = await a.create({ name: "First", template: "empty" });
    const second = await a.create({ name: "Second", template: "empty" });
    await a.edit(first.id, { revision: 0, operations: [add("Cube")] });
    await expect(b.commit(first.id, 0, first.document)).rejects.toThrow("Revision conflict");
    expect((await b.load(first.id)).revision).toBe(1);
    expect((await b.load(second.id)).revision).toBe(0);
    expect((await b.list()).map((scene) => scene.name).sort()).toEqual(["First", "Second"]);
  });

  test("failed batches roll back documents, revision and history", async () => {
    const db = store(), scene = await db.create({ template: "empty" });
    await expect(db.edit(scene.id, { operations: [add("Cube"), { type: "remove", object: "missing" }] })).rejects.toThrow("Object not found");
    expect(await db.load(scene.id)).toEqual(scene);
    await expect(db.undo(scene.id)).rejects.toThrow("Nothing to undo");
  });

  test("manual and agent edits share history, redo clears after new edits, no-op saves add nothing", async () => {
    const db = store(), scene = await db.create({ template: "empty" });
    const edited = await db.edit(scene.id, { operations: [add("Cube"), { type: "transform", object: "Cube", position: [1, 2, 3] }] });
    const document = structuredClone(edited.document);
    document.scene.object.name = "Manual scene edit";
    const manual = await db.commit(scene.id, edited.revision, document);
    expect(manual.undoCount).toBe(2);
    expect(await db.commit(scene.id, manual.revision, document)).toEqual(manual);
    expect((await db.undo(scene.id)).document).toEqual(edited.document);
    expect((await db.undo(scene.id)).document).toEqual(scene.document);
    expect((await db.redo(scene.id)).document).toEqual(edited.document);
    await db.edit(scene.id, { operations: [add("Other")] });
    await expect(db.redo(scene.id)).rejects.toThrow("Nothing to redo");
  });

  test("history obeys count and byte caps", async () => {
    const db = store(), scene = await db.create({ template: "empty" });
    for (let n = 0; n < 24; n++) await db.edit(scene.id, { operations: [{ type: "background", color: n % 2 ? "#ffffff" : "#000000" }] });
    expect((await db.load(scene.id)).undoCount).toBe(20);
    const small = store(1), tiny = await small.create({ template: "empty" });
    expect((await small.edit(tiny.id, { operations: [add("Cube")] })).undoCount).toBe(0);
  });

  test("cycles roll back and material edits do not change a duplicated mesh", async () => {
    const db = store(), scene = await db.create({ template: "empty" });
    const initial = await db.edit(scene.id, { operations: [
      { type: "add_group", name: "Parent" }, { type: "add_group", name: "Child", parent: "Parent" },
      add("Cube"), { type: "duplicate", object: "Cube", name: "Copy" },
    ] });
    await expect(db.edit(scene.id, { operations: [{ type: "reparent", object: "Parent", parent: "Child" }] })).rejects.toThrow("cycle");
    expect((await db.load(scene.id)).revision).toBe(initial.revision);
    const edited = await db.edit(scene.id, { operations: [{ type: "material", object: "Copy", material: { color: "#ff0000" } }] });
    const cube = edited.document.scene.object.children!.find((node) => node.name === "Cube")!;
    const copy = edited.document.scene.object.children!.find((node) => node.name === "Copy")!;
    expect(copy.material).not.toBe(cube.material);
    expect(edited.document.scene.materials!.find((material) => material.uuid === copy.material)!.color).toBe(0xff0000);
    expect(edited.document.scene.materials!.find((material) => material.uuid === cube.material)!.color).not.toBe(0xff0000);
  });

  test("duplicate scenes and delete are independent", async () => {
    const db = store(), first = await db.create({ template: "empty" });
    const second = await db.create({ source_id: first.id, name: "Copy" });
    expect(second.document).toEqual(first.document);
    await db.rename(second.id, "Renamed");
    await db.delete(first.id);
    await expect(db.load(first.id)).rejects.toThrow("Scene not found");
    expect((await db.load(second.id)).name).toBe("Renamed");
  });

  test("feedback persists, paginates and remains idempotent after resolution", async () => {
    const db = store(), scene = await db.create({ template: "empty" });
    const note = {
      id: crypto.randomUUID(), text: "Make the top round", scene_revision: 0, targets: [], strokes: [], image: "data:image/jpeg;base64,/9j/",
      view: { camera: { type: "PerspectiveCamera", position: [1, 2, 3], quaternion: [0, 0, 0, 1], up: [0, 1, 0], near: 0.1, far: 100, zoom: 1, fov: 45 }, target: [0, 0, 0], shading: "solid", width: 100, height: 100 },
    };
    await db.feedbackAdd(scene.id, note);
    expect((await db.feedbackAdd(scene.id, note)).pending_count).toBe(1);
    await db.feedbackAdd(scene.id, { ...note, id: crypto.randomUUID() });
    const page = await db.feedbackList(scene.id, { limit: 1, include_images: true, include_strokes: false });
    expect(page.has_more).toBe(true);
    expect(page.notes[0]!.image).toBe("/9j/");
    expect(page.notes[0]!.strokes).toBeUndefined();
    expect((await db.feedbackList(scene.id, { after: page.next_after })).notes).toHaveLength(1);
    await db.feedbackResolve(scene.id, [note.id]);
    expect((await db.feedbackAdd(scene.id, note)).pending_count).toBe(1);
    expect((await db.load(scene.id)).revision).toBe(0);
  });

  test("UTF-8 byte reporting includes multibyte scene names", () => {
    const document = initialDocument("empty");
    document.scene.object.name = "日本語 🐉";
    const result = inspect({ id: crypto.randomUUID(), name: "Test", revision: 0, updatedAt: "", source: "test", document });
    expect(result.storage.bytes).toBe(new TextEncoder().encode(JSON.stringify(document)).byteLength);
    expect(result.storage.bytes).toBeGreaterThan(JSON.stringify(document).length);
  });
});
