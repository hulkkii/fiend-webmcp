import { z } from "zod";
import { createInput, editInput, editDocument, initialDocument, validateDocument, sceneID, SceneError, type Document, type Snapshot } from "./scene";
import { feedbackInput, resolveFeedbackInput } from "./feedback";

type Entry = { document: Document; bytes: number };
type SceneRecord = { id: string; snapshot: Snapshot; undo: Entry[]; redo: Entry[] };
type Note = Omit<z.infer<typeof feedbackInput>, "image"> & { sequence: number; created_at: string; image: Blob };
type FeedbackRecord = { id: string; version: number; sequence: number; receipts: string[]; notes: Note[] };
const emptyFeedback = (id: string): FeedbackRecord => ({ id, version: 0, sequence: 0, receipts: [], notes: [] });
const revisionInput = z.number().int().nonnegative();
const queryInput = z.object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(20).default(20), include_images: z.boolean().default(false), include_strokes: z.boolean().default(true) });

/** One read/write transaction owns each mutation, including its revision check. */
export function createLocalStore(options: { indexedDB?: IDBFactory; name?: string; historyBytes?: number } = {}) {
  let opening: Promise<IDBDatabase> | undefined;
  const budget = options.historyBytes ?? 100 * 1024 * 1024;
  function database() {
    if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new Error("Browser storage is unavailable. Enable IndexedDB to save scenes.")); return; }
      const request = factory.open(options.name ?? "fiend-local", 1);
      request.onupgradeneeded = () => {
        for (const name of ["scenes", "feedback"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
      };
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error("Close other Fiend tabs to upgrade browser storage, then reload.")); };
      request.onerror = () => reject(request.error ?? new Error("Could not open browser storage"));
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        request.result.onversionchange = () => { request.result.close(); opening = undefined; };
        resolve(request.result);
      };
    }).catch((error) => { opening = undefined; throw error; });
    return opening;
  }
  async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      let failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Saving failed. Your last saved scene is intact. Export your unsaved work and retry."));
      try { run(tx, (value) => { result = value; }, fail); } catch (error) { fail(error); }
    });
  }
  function required(value: SceneRecord | undefined): SceneRecord {
    if (!value) throw new SceneError("Scene not found in this browser", 404);
    return value;
  }
  function check(record: SceneRecord, expected?: number) {
    if (expected !== undefined && revisionInput.parse(expected) !== record.snapshot.revision) throw new SceneError(`Revision conflict: expected ${expected}, current ${record.snapshot.revision}. Reload this scene before editing.`, 409);
  }
  function trim(entries: Entry[], other: Entry[] = []) {
    let bytes = [...entries, ...other].reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length + other.length > 20 || bytes > budget) {
      const removed = other.length ? other.shift() : entries.shift();
      if (!removed) break;
      bytes -= removed.bytes;
    }
  }
  function entry(document: Document): Entry { return { document, bytes: new TextEncoder().encode(JSON.stringify(document)).byteLength }; }
  function advance(record: SceneRecord, document: Document, source: string) {
    record.snapshot = { ...record.snapshot, document, revision: record.snapshot.revision + 1, updatedAt: new Date().toISOString(), source, undoCount: record.undo.length, redoCount: record.redo.length };
    return record.snapshot;
  }
  function mutate<T>(id: string, change: (record: SceneRecord) => T): Promise<T> {
    sceneID.parse(id);
    return transaction(["scenes"], "readwrite", (tx, done, fail) => {
      const store = tx.objectStore("scenes");
      const request = store.get(id);
      request.onsuccess = () => {
        try { const record = required(request.result); const value = change(record); store.put(record); done(value); }
        catch (error) { fail(error); }
      };
    });
  }
  async function load(id: string): Promise<Snapshot> {
    sceneID.parse(id);
    return transaction(["scenes"], "readonly", (tx, done, fail) => {
      const request = tx.objectStore("scenes").get(id);
      request.onsuccess = () => { try { done(required(request.result).snapshot); } catch (error) { fail(error); } };
    });
  }
  function feedbackChange<T>(id: string, mode: IDBTransactionMode, change: (feedback: FeedbackRecord, scene: Snapshot) => T): Promise<T> {
    sceneID.parse(id);
    return transaction(["scenes", "feedback"], mode, (tx, done, fail) => {
      const scene = tx.objectStore("scenes").get(id);
      scene.onsuccess = () => {
        try {
          const snapshot = required(scene.result).snapshot;
          const store = tx.objectStore("feedback"), request = store.get(id);
          request.onsuccess = () => {
            try { const feedback = request.result ?? emptyFeedback(id); const result = change(feedback, snapshot); if (mode === "readwrite") store.put(feedback); done(result); }
            catch (error) { fail(error); }
          };
        } catch (error) { fail(error); }
      };
    });
  }
  const state = (feedback: FeedbackRecord) => ({ version: feedback.version, pending_count: feedback.notes.length });
  return {
    load,
    async list() {
      return transaction<Omit<Snapshot, "document">[]>(["scenes"], "readonly", (tx, done) => {
        const metadata: Omit<Snapshot, "document">[] = [];
        const request = tx.objectStore("scenes").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { done(metadata.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); return; }
          const { document: _, ...item } = (cursor.value as SceneRecord).snapshot;
          metadata.push(item);
          cursor.continue();
        };
      });
    },
    async create(input: unknown = {}): Promise<Snapshot> {
      const parsed = createInput.parse(input);
      const document = parsed.source_id ? (await load(parsed.source_id)).document : initialDocument(parsed.template);
      const snapshot: Snapshot = { id: crypto.randomUUID(), name: parsed.name, revision: 0, document, updatedAt: new Date().toISOString(), source: "create", undoCount: 0, redoCount: 0 };
      return transaction(["scenes"], "readwrite", (tx, done) => { tx.objectStore("scenes").add({ id: snapshot.id, snapshot, undo: [], redo: [] }); done(snapshot); });
    },
    rename(id: string, name: string) {
      const parsed = createInput.shape.name.parse(name);
      return mutate(id, (record) => { record.snapshot.name = parsed; return advance(record, record.snapshot.document, "rename"); });
    },
    async delete(id: string): Promise<void> {
      sceneID.parse(id);
      return transaction(["scenes", "feedback"], "readwrite", (tx, done) => { tx.objectStore("scenes").delete(id); tx.objectStore("feedback").delete(id); done(undefined); });
    },
    commit(id: string, expectedRevision: number, input: unknown, source = "browser") {
      revisionInput.parse(expectedRevision);
      const document = structuredClone(validateDocument(input));
      return mutate(id, (record) => {
        check(record, expectedRevision);
        if (JSON.stringify(record.snapshot.document) === JSON.stringify(document)) return record.snapshot;
        record.undo.push(entry(record.snapshot.document)); trim(record.undo); record.redo = [];
        return advance(record, document, source);
      });
    },
    edit(id: string, input: unknown) {
      const parsed = editInput.parse(input);
      return mutate(id, (record) => {
        check(record, parsed.revision);
        const { document, created } = editDocument(record.snapshot.document, parsed.operations);
        record.undo.push(entry(record.snapshot.document)); trim(record.undo); record.redo = [];
        return { ...advance(record, document, "agent"), created };
      });
    },
    undo(id: string, revision?: number) {
      return mutate(id, (record) => {
        check(record, revision);
        const previous = record.undo.pop();
        if (!previous) throw new SceneError("Nothing to undo", 409);
        record.redo.push(entry(record.snapshot.document)); trim(record.redo, record.undo);
        return advance(record, previous.document, "undo");
      });
    },
    redo(id: string, revision?: number) {
      return mutate(id, (record) => {
        check(record, revision);
        const next = record.redo.pop();
        if (!next) throw new SceneError("Nothing to redo", 409);
        record.undo.push(entry(record.snapshot.document)); trim(record.undo, record.redo);
        return advance(record, next.document, "redo");
      });
    },
    async feedbackList(id: string, input: unknown = {}) {
      const query = queryInput.parse(input);
      const page = await feedbackChange(id, "readonly", (feedback) => {
        const candidates = feedback.notes.filter((note) => note.sequence > query.after);
        const notes = candidates.slice(0, query.limit);
        return { ...state(feedback), notes, has_more: candidates.length > query.limit, next_after: notes.at(-1)?.sequence ?? query.after };
      });
      const notes = await Promise.all(page.notes.map(async ({ image, strokes, ...note }) => {
        const base64 = query.include_images ? btoa(Array.from(new Uint8Array(await image.arrayBuffer()), (byte) => String.fromCharCode(byte)).join("")) : undefined;
        return { ...note, drawings: strokes.map((stroke) => ({ kind: stroke.kind, point_count: stroke.points.length })), ...(query.include_strokes ? { strokes } : {}), ...(base64 ? { image: base64, image_url: `data:image/jpeg;base64,${base64}` } : {}) };
      }));
      return { ...page, notes };
    },
    feedbackAdd(id: string, input: unknown) {
      const parsed = feedbackInput.parse(input);
      const bytes = Uint8Array.from(atob(parsed.image.split(",")[1]!), (char) => char.charCodeAt(0));
      if (bytes.length > 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new SceneError("Feedback requires a JPEG screenshot under 1 MiB");
      return feedbackChange(id, "readwrite", (feedback, scene) => {
        if (feedback.receipts.includes(parsed.id)) return { id: parsed.id, ...state(feedback) };
        if (parsed.scene_revision > scene.revision) throw new SceneError("Feedback references a future scene revision");
        if (feedback.notes.length >= 100) throw new SceneError("Resolve some feedback before adding more than 100 notes", 409);
        if (feedback.notes.reduce((sum, note) => sum + note.image.size, bytes.length) > 64 * 1024 * 1024) throw new SceneError("Resolve feedback to free screenshot storage", 413);
        const { image: _, ...note } = parsed;
        feedback.notes.push({ ...note, image: new Blob([bytes], { type: "image/jpeg" }), sequence: ++feedback.sequence, created_at: new Date().toISOString() });
        feedback.receipts.push(parsed.id); feedback.version++;
        return { id: parsed.id, ...state(feedback) };
      });
    },
    feedbackResolve(id: string, ids: string[]) {
      const { feedback_ids } = resolveFeedbackInput.parse({ feedback_ids: ids });
      return feedbackChange(id, "readwrite", (feedback) => {
        const resolved_ids = feedback.notes.filter((note) => feedback_ids.includes(note.id)).map((note) => note.id);
        if (resolved_ids.length) { feedback.notes = feedback.notes.filter((note) => !feedback_ids.includes(note.id)); feedback.version++; }
        return { resolved_ids, ...state(feedback) };
      });
    },
  };
}

export const local = createLocalStore();
