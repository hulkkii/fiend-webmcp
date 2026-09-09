import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { createInput, editDocument, editInput, initialDocument, MAX_BYTES, SceneError, validateDocument, type Snapshot, type Document } from "./scene";
import { diffScene, mergeScene } from "./sync";
import { editSecret, sameHash, secretHash } from "./access";
import { Buffer } from "node:buffer";
import { feedbackInput, feedbackQuery, resolveFeedbackInput, type FeedbackNote } from "./feedback";

export type Env = { SCENES: DurableObjectNamespace<SceneRoom>; ASSETS: Fetcher; BROWSER: Fetcher };

export function failure(error: unknown) {
  if (error instanceof z.ZodError) return Response.json({ error: z.prettifyError(error) }, { status: 400 });
  if (error instanceof SceneError) return Response.json({ error: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ error: "An unexpected error occurred" }, { status: 500 });
}

export async function readJSON(request: Request, limit = MAX_BYTES) {
  if (Number(request.headers.get("content-length")) > limit) throw new SceneError("Request exceeds size limit", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new SceneError("JSON body required");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new SceneError("Request exceeds size limit", 413); }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new SceneError("Invalid JSON"); }
}

export class SceneRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS scene (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS redo (id INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data BLOB NOT NULL, revision INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS scene_auth (id INTEGER PRIMARY KEY CHECK (id = 1), secret_hash TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS feedback (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, note TEXT NOT NULL, image BLOB NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS feedback_receipts (id TEXT PRIMARY KEY)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO feedback_receipts (id) SELECT id FROM feedback");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS feedback_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO feedback_state (id, version) VALUES (1, 0)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get(): Snapshot {
    const row = this.ctx.storage.sql.exec<{ snapshot: string }>("SELECT snapshot FROM scene WHERE id = 1").toArray()[0];
    if (!row) throw new SceneError("Scene not found", 404);
    return JSON.parse(row.snapshot);
  }

  private persist(snapshot: Snapshot) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO scene (id, snapshot) VALUES (1, ?)", JSON.stringify(snapshot));
  }

  private async authorize(request: Request) {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    const parsed = editSecret.safeParse(token);
    if (!parsed.success) throw new SceneError("A valid scene edit secret is required", 403);
    const hash = await secretHash(parsed.data);
    const row = this.ctx.storage.sql.exec<{ secret_hash: string }>("SELECT secret_hash FROM scene_auth WHERE id = 1").toArray()[0];
    // Legacy scenes without credentials are read-only; an ID cannot claim ownership.
    if (!row || !sameHash(row.secret_hash, hash)) throw new SceneError("A valid scene edit secret is required", 403);
  }

  private broadcast(snapshot: Snapshot) {
    this.send({ type: "snapshot", ...snapshot });
  }

  private send(event: unknown) {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { socket.close(1011, "Reconnect to sync"); }
    }
  }

  private feedbackState() {
    const { version } = this.ctx.storage.sql.exec<{ version: number }>("SELECT version FROM feedback_state WHERE id = 1").one();
    const { pending_count } = this.ctx.storage.sql.exec<{ pending_count: number }>("SELECT COUNT(*) AS pending_count FROM feedback").one();
    return { version, pending_count };
  }

  private feedbackChanged(resolved_ids: string[] = []) {
    const state = this.feedbackState();
    this.send({ type: "feedback", ...state, resolved_ids });
    return state;
  }

  private save(current: Snapshot, document: Document, source: string, history = true): Snapshot {
    const next = { ...current, document, revision: current.revision + 1, updatedAt: new Date().toISOString(), source };
    this.ctx.storage.transactionSync(() => {
      if (history) {
        this.ctx.storage.sql.exec("INSERT INTO history (document) VALUES (?)", JSON.stringify(current.document));
        this.ctx.storage.sql.exec("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 20)");
        this.ctx.storage.sql.exec("DELETE FROM redo");
      }
      this.persist(next);
    });
    this.broadcast(next);
    return next;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      // Consume the bounded forwarded body before responding, including on auth
      // failure, so no request stream outlives its Worker/DO response.
      const body = request.method === "POST" ? await readJSON(request, path === "/asset" ? 12 * 1024 * 1024 : MAX_BYTES) : undefined;
      if (path === "/access" && request.method === "GET") {
        await this.authorize(request);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST" && path !== "/create") await this.authorize(request);
      if (path === "/feedback" && request.method === "GET") {
        const scene = this.get();
        const query = feedbackQuery.parse(Object.fromEntries(url.searchParams));
        const rows = this.ctx.storage.sql.exec<{ sequence: number; id: string; note: string; image?: ArrayBuffer }>(
          `SELECT sequence, id, note${query.images === "1" ? ", image" : ""} FROM feedback WHERE sequence > ? ORDER BY sequence LIMIT ?`, query.after, query.limit + 1,
        ).toArray();
        const notes = rows.slice(0, query.limit).map((row): FeedbackNote => ({
          ...JSON.parse(row.note), sequence: row.sequence,
          image_url: `/labs/fiend/api/scenes/${scene.id}/feedback/${row.id}/image`,
          ...(row.image ? { image: Buffer.from(row.image).toString("base64") } : {}),
        }));
        return Response.json({ ...this.feedbackState(), notes, has_more: rows.length > query.limit, next_after: notes.at(-1)?.sequence ?? query.after }, { headers: { "cache-control": "no-store" } });
      }
      const feedbackImage = path.match(/^\/feedback\/([^/]+)\/image$/);
      if (feedbackImage && request.method === "GET") {
        const id = z.uuid().parse(feedbackImage[1]);
        const row = this.ctx.storage.sql.exec<{ image: ArrayBuffer }>("SELECT image FROM feedback WHERE id = ?", id).toArray()[0];
        if (!row) throw new SceneError("Feedback not found", 404);
        return new Response(row.image, { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (path === "/feedback" && request.method === "POST") {
        const input = feedbackInput.parse(body);
        const current = this.get();
        if (input.scene_revision > current.revision) throw new SceneError("Feedback references a future scene revision");
        const existing = this.ctx.storage.sql.exec("SELECT id FROM feedback_receipts WHERE id = ?", input.id).toArray()[0];
        if (existing) return Response.json({ id: input.id, ...this.feedbackState() });
        if (this.feedbackState().pending_count >= 100) throw new SceneError("Resolve some feedback before adding more than 100 notes", 409);
        const image = Buffer.from(input.image.slice("data:image/jpeg;base64,".length), "base64");
        if (image.byteLength > 1024 * 1024 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw new SceneError("Feedback requires a JPEG screenshot under 1 MiB");
        const { bytes } = this.ctx.storage.sql.exec<{ bytes: number }>("SELECT COALESCE(SUM(length(image)), 0) AS bytes FROM feedback").one();
        if (bytes + image.byteLength > 64 * 1024 * 1024) throw new SceneError("Resolve some feedback to free screenshot storage", 413);
        const { image: _, ...data } = input;
        const note = { ...data, created_at: new Date().toISOString() };
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("INSERT INTO feedback (id, note, image) VALUES (?, ?, ?)", input.id, JSON.stringify(note), image);
          this.ctx.storage.sql.exec("INSERT INTO feedback_receipts (id) VALUES (?)", input.id);
          this.ctx.storage.sql.exec("UPDATE feedback_state SET version = version + 1 WHERE id = 1");
        });
        return Response.json({ id: input.id, ...this.feedbackChanged() }, { status: 201 });
      }
      if (path === "/feedback/resolve" && request.method === "POST") {
        this.get();
        const { feedback_ids } = resolveFeedbackInput.parse(body);
        const placeholders = feedback_ids.map(() => "?").join(", ");
        const resolved_ids = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM feedback WHERE id IN (${placeholders})`, ...feedback_ids).toArray().map((row) => row.id);
        if (!resolved_ids.length) return Response.json({ resolved_ids, ...this.feedbackState() });
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(`DELETE FROM feedback WHERE id IN (${placeholders})`, ...feedback_ids);
          this.ctx.storage.sql.exec("UPDATE feedback_state SET version = version + 1 WHERE id = 1");
        });
        return Response.json({ resolved_ids, ...this.feedbackChanged(resolved_ids) });
      }
      if (path.startsWith("/assets/") && request.method === "GET") {
        const id = z.uuid().parse(path.slice(8));
        const row = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM assets WHERE id = ?", id).toArray()[0];
        if (!row) throw new SceneError("Asset not found", 404);
        return new Response(row.data, { headers: { "content-type": "model/gltf-binary", "content-disposition": `attachment; filename="fiend-${id}.glb"`, "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } });
      }
      if (path === "/asset" && request.method === "POST") {
        const input = z.object({ data: z.string(), revision: z.number().int() }).parse(body);
        this.get();
        const data = Uint8Array.from(atob(input.data), (char) => char.charCodeAt(0));
        if (data.byteLength > 8 * 1024 * 1024) throw new SceneError("GLB exceeds 8 MiB", 413);
        const total = this.ctx.storage.sql.exec<{ size: number }>("SELECT COALESCE(SUM(length(data)), 0) AS size FROM assets").one().size;
        if (total + data.byteLength > 64 * 1024 * 1024) throw new SceneError("Scene's saved exports exceed 64 MiB; use the editor's direct GLB download", 413);
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec("INSERT INTO assets (id, data, revision) VALUES (?, ?, ?)", id, data, input.revision);
        return Response.json({ id, revision: input.revision, bytes: data.byteLength });
      }
      if (path === "/create" && request.method === "POST") {
        const input = z.object({ id: z.uuid(), ...createInput.shape, secret_hash: z.string().regex(/^[0-9a-f]{64}$/), document: z.unknown().optional() }).parse(body);
        if (this.ctx.storage.sql.exec("SELECT id FROM scene").toArray().length) throw new SceneError("Scene already exists", 409);
        const snapshot: Snapshot = { id: input.id, name: input.name, revision: 0, document: input.document ? validateDocument(input.document) : initialDocument(input.template), updatedAt: new Date().toISOString(), source: "create" };
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("INSERT INTO scene_auth (id, secret_hash) VALUES (1, ?)", input.secret_hash);
          this.persist(snapshot);
        });
        return Response.json(snapshot, { status: 201 });
      }
      if (path === "/live" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const snapshot = this.get();
        if (this.ctx.getWebSockets().length >= 100) throw new SceneError("Scene has reached 100 live viewers", 429);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({ type: "snapshot", ...snapshot }));
        pair[1].send(JSON.stringify({ type: "feedback", ...this.feedbackState(), resolved_ids: [] }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (path === "/" && request.method === "GET") return Response.json(this.get());
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      // Parsing and authorization precede state reads. Subsequent reads/writes are synchronous,
      // so concurrent requests cannot interleave a mutation inside this room.
      const current = this.get();
      if (path === "/edit") {
        const input = editInput.parse(body);
        if (input.revision !== undefined && input.revision !== current.revision) throw new SceneError(`Revision conflict: expected ${input.revision}, current ${current.revision}`, 409);
        const result = editDocument(current.document, input.operations);
        const snapshot = this.save(current, result.document, "agent");
        return Response.json({ ...snapshot, created: result.created });
      }
      if (path === "/save") {
        const input = z.object({
          patches: z.array(z.discriminatedUnion("op", [
            z.object({ op: z.enum(["set", "ensure"]), path: z.array(z.string().max(200)).min(1).max(80), value: z.unknown() }),
            z.object({ op: z.literal("remove"), path: z.array(z.string().max(200)).min(1).max(80) }),
          ])).max(5000),
          client: z.uuid(),
        }).parse(body);
        let document: Document;
        try { document = validateDocument(mergeScene(current.document, input.patches)); }
        catch (error) { throw new SceneError(error instanceof Error ? error.message : "Invalid scene edit"); }
        if (diffScene(current.document, document).length === 0) return Response.json({ ...current, source: input.client });
        return Response.json(this.save(current, document, input.client));
      }
      if (path === "/undo" || path === "/redo") {
        const input = z.object({ revision: z.number().int().optional() }).parse(body);
        if (input.revision !== undefined && input.revision !== current.revision) throw new SceneError("Revision conflict", 409);
        const from = path === "/undo" ? "history" : "redo", to = path === "/undo" ? "redo" : "history";
        const row = this.ctx.storage.sql.exec<{ id: number; document: string }>(`SELECT id, document FROM ${from} ORDER BY id DESC LIMIT 1`).toArray()[0];
        if (!row) throw new SceneError(`Nothing to ${path.slice(1)}`);
        let next!: Snapshot;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(`DELETE FROM ${from} WHERE id = ?`, row.id);
          this.ctx.storage.sql.exec(`INSERT INTO ${to} (document) VALUES (?)`, JSON.stringify(current.document));
          next = { ...current, document: JSON.parse(row.document), revision: current.revision + 1, updatedAt: new Date().toISOString(), source: path.slice(1) };
          this.persist(next);
        });
        this.broadcast(next);
        return Response.json(next);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) { return failure(error); }
  }

  webSocketClose(socket: WebSocket) { socket.close(1000, "Connection closed"); }
  webSocketMessage(socket: WebSocket) { socket.close(1008, "Scene WebSockets are read-only"); }
  webSocketError(socket: WebSocket) { socket.close(1011, "Reconnect to sync"); }
}
