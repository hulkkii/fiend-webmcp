import { resolve, relative, isAbsolute } from "node:path";

const root = resolve("dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 8787),
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response("Invalid path", { status: 400 }); }
    if (pathname.includes("\\") || pathname.includes("\0")) return new Response("Invalid path", { status: 400 });
    const path = resolve(root, `.${pathname}${pathname.endsWith("/") ? "index.html" : ""}`);
    const within = relative(root, path);
    if (within.startsWith("..") || isAbsolute(within)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
  },
});
console.log(`Fiend: ${server.url}`);
