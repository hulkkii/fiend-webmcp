import puppeteer from "@cloudflare/puppeteer";
import { Buffer } from "node:buffer";
import { room, sceneURL } from "./mcp";
import { BASE, SceneError, type Snapshot } from "./scene";
import type { Env } from "./room";

const WIDTH = 1200;
const HEIGHT = 630;

function imageURL(origin: string, id: string, revision: number) {
  return `${origin}${BASE}/api/scenes/${id}/og.png?revision=${revision}`;
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function sceneMetadata(response: Response, origin: string, snapshot: Snapshot) {
  const title = `${snapshot.name} — Fiend`;
  const description = `Explore ${snapshot.name}, an interactive 3D scene made with Fiend.`;
  const url = sceneURL(origin, snapshot.id);
  const image = imageURL(origin, snapshot.id, snapshot.revision);
  const tags = [
    ["name", "description", description],
    ["property", "og:type", "website"],
    ["property", "og:site_name", "Fiend"],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", url],
    ["property", "og:image", image],
    ["property", "og:image:type", "image/png"],
    ["property", "og:image:width", String(WIDTH)],
    ["property", "og:image:height", String(HEIGHT)],
    ["property", "og:image:alt", `Render of ${snapshot.name}`],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", image],
    ["name", "twitter:image:alt", `Render of ${snapshot.name}`],
  ].map(([attribute, name, value]) => `<meta ${attribute}="${name}" content="${escape(value!)}">`).join("");
  const headers = new Headers(response.headers);
  headers.delete("etag");
  headers.delete("content-length");
  headers.delete("last-modified");
  headers.set("cache-control", "no-store");
  return new HTMLRewriter()
    .on('title, meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]', { element(element) { element.remove(); } })
    .on("head", { element(element) { element.append(`<title>${escape(title)}</title><link rel="canonical" href="${escape(url)}">${tags}`, { html: true }); } })
    .transform(new Response(response.body, { status: response.status, headers }));
}

export async function sceneImage(request: Request, env: Env, ctx: ExecutionContext, id: string) {
  const url = new URL(request.url);
  const revision = url.searchParams.get("revision");
  if (revision !== null && (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)))) throw new SceneError("Invalid scene revision");
  const cache = await caches.open("fiend-og-v1");
  const key = revision === null ? undefined : new Request(imageURL(url.origin, id, Number(revision)));
  if (key) {
    const cached = await cache.match(key);
    if (cached) return request.method === "HEAD" ? new Response(null, { headers: cached.headers }) : cached;
  }
  const snapshot = await room(env, id);
  // Old revisions may have expired from cache. Never label a newer render with an old revision.
  if (revision === null || Number(revision) !== snapshot.revision) {
    return new Response(null, { status: 302, headers: { location: imageURL(url.origin, id, snapshot.revision), "cache-control": "no-store" } });
  }
  const headers = {
    "content-type": "image/png",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    etag: `"fiend-${id}-${snapshot.revision}"`,
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  try {
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
      // Pin the capture to the exact public snapshot, even if the scene is edited while loading.
      const api = `${url.origin}${BASE}/api/scenes/${id}`;
      await page.setRequestInterception(true);
      page.on("request", (incoming) => {
        const pending = incoming.url() === api
          ? incoming.respond({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) })
          : incoming.continue();
        void pending.catch(() => {});
      });
      await page.goto(`${url.origin}${BASE}/render/${id}`, { waitUntil: "networkidle0", timeout: 45000 });
      await page.waitForFunction("window.fiendCapture || window.fiendError", { timeout: 30000 });
      const result = await page.evaluate("window.fiendError ? { error: window.fiendError } : window.fiendCapture()") as { error?: string; image: string; revision: number };
      if (result.error || result.revision !== snapshot.revision || !result.image?.startsWith("data:image/png;base64,")) throw new Error("Scene preview render failed");
      const response = new Response(Buffer.from(result.image.slice("data:image/png;base64,".length), "base64"), { headers });
      ctx.waitUntil(cache.put(key!, response.clone()).catch((error) => console.error("Scene preview cache failed", error)));
      return response;
    } finally { await browser.close(); }
  } catch (error) {
    console.error("Scene preview unavailable", error);
    return new Response("Scene preview temporarily unavailable", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "30" } });
  }
}
