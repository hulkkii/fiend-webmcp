import puppeteer from "@cloudflare/puppeteer";
import { Buffer } from "node:buffer";
import { room } from "./mcp";
import { BASE, find, SceneError, type Snapshot } from "./scene";
import type { Env } from "./room";

export async function downloadGLB(request: Request, env: Env, ctx: ExecutionContext, id: string) {
  const url = new URL(request.url);
  const object = url.searchParams.get("object") ?? "Scene";
  if (!object.length || object.length > 200) throw new SceneError("Invalid object selector");
  let snapshot: Snapshot | undefined = await room<Snapshot>(env, id);
  const { uuid, name, type } = find(snapshot.document.scene.object, object);
  if (type.endsWith("Light") || type.endsWith("Camera")) throw new SceneError("Choose a mesh, group or scene to export");
  const revision = snapshot.revision;
  const filename = ((object === "Scene" ? snapshot.name : name) ?? "fiend").normalize("NFKD").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "fiend";
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uuid))).toString("hex");
  const key = new Request(`${url.origin}${BASE}/_cache/glb/${id}/${revision}/${hash}`);
  const cache = await caches.open("fiend-glb-v1");
  const headers = new Headers({
    "content-type": "model/gltf-binary",
    "content-disposition": `attachment; filename="${filename}.glb"`,
    "cache-control": "public, max-age=0, must-revalidate",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "Content-Disposition, Content-Length, ETag, X-Fiend-Revision",
    "x-content-type-options": "nosniff",
    "x-fiend-revision": String(revision),
    "referrer-policy": "no-referrer",
    etag: `"fiend-glb-${id}-${revision}-${hash.slice(0, 16)}"`,
  });
  if (request.headers.get("if-none-match") === headers.get("etag")) return new Response(null, { status: 304, headers });
  const cached = await cache.match(key);
  if (cached) {
    const length = cached.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(request.method === "HEAD" ? null : cached.body, { headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers });

  try {
    let payload = JSON.stringify(snapshot);
    snapshot = undefined;
    const browser = await puppeteer.launch(env.BROWSER);
    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      await browser.close().catch((error) => console.error("GLB browser cleanup failed", error));
    }
    try {
      const page = await browser.newPage();
      const api = `${url.origin}${BASE}/api/scenes/${id}`;
      await page.setRequestInterception(true);
      const intercept = (incoming: import("@cloudflare/puppeteer").HTTPRequest) => {
        const pending = incoming.url() === api
          ? incoming.respond({ status: 200, contentType: "application/json", body: payload })
          : incoming.continue();
        void pending.catch(() => {});
      };
      page.on("request", intercept);
      await page.goto(`${url.origin}${BASE}/render/${id}`, { waitUntil: "networkidle0", timeout: 45000 });
      await page.waitForFunction("window.fiendExportPrepare || window.fiendError", { timeout: 30000 });
      page.off("request", intercept);
      await page.setRequestInterception(false);
      payload = "";
      const result = await page.evaluate(`window.fiendExportPrepare ? window.fiendExportPrepare(${JSON.stringify(object)}) : { error: window.fiendError }`) as { error?: string; revision: number; bytes: number };
      if (result.error) throw new Error(result.error);
      if (result.revision !== revision || !Number.isSafeInteger(result.bytes) || result.bytes < 12) throw new Error("Invalid GLB export");
      headers.set("content-length", String(result.bytes));
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const size = Math.min(256 * 1024, result.bytes - offset);
            const encoded = await page.evaluate(`window.fiendExportChunk(${offset}, ${size})`) as string;
            const chunk = Buffer.from(encoded, "base64");
            if (chunk.byteLength !== size) throw new Error("Incomplete GLB export");
            offset += size;
            controller.enqueue(chunk);
            if (offset === result.bytes) { controller.close(); await close(); }
          } catch (error) { controller.error(error); await close(); }
        },
        async cancel() { await close(); },
      });
      const cacheHeaders = new Headers(headers);
      cacheHeaders.set("cache-control", "public, max-age=86400");
      const { readable, writable } = new FixedLengthStream(result.bytes);
      ctx.waitUntil(body.pipeTo(writable).catch((error) => console.error("GLB stream failed", error)));
      const response = new Response(readable, { headers: cacheHeaders });
      ctx.waitUntil(cache.put(key, response.clone()).catch((error) => console.error("GLB cache failed", error)));
      return new Response(response.body, { headers });
    } catch (error) { await close(); throw error; }
  } catch (error) {
    console.error("GLB download unavailable", error);
    return new Response("GLB export temporarily unavailable. Please retry.", { status: 503, headers: { "content-type": "text/plain", "cache-control": "no-store", "retry-after": "10", "access-control-allow-origin": "*" } });
  }
}
