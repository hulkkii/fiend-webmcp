import { BASE, createInput, sceneID, SceneError } from "./scene";
import { createScene, handleMcp, room } from "./mcp";
import { failure, readJSON, type Env } from "./room";
import { sceneImage, sceneMetadata } from "./og";
import { downloadGLB } from "./download";
export { SceneRoom } from "./room";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id", "access-control-max-age": "86400" } });
      const path = url.pathname;
      if (path === `${BASE}/mcp` || path === `${BASE}/mcp/`) {
        const response = await handleMcp(request, env);
        const headers = new Headers(response.headers);
        headers.set("access-control-allow-origin", "*");
        headers.set("access-control-expose-headers", "MCP-Session-Id, MCP-Protocol-Version");
        headers.set("cache-control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      }
      if (path === `${BASE}/api/scenes` && request.method === "POST") return Response.json(await createScene(env, url.origin, createInput.parse(await readJSON(request))), { status: 201, headers: { "cache-control": "no-store" } });
      const feedback = path.match(/^\/labs\/fiend\/api\/scenes\/([^/]+)\/feedback(\/resolve|\/[^/]+\/image)?$/);
      if (feedback) {
        const id = sceneID.parse(feedback[1]);
        const internal = new URL(request.url);
        internal.pathname = `/feedback${feedback[2] ?? ""}`;
        return env.SCENES.getByName(id).fetch(new Request(internal, request));
      }
      const asset = path.match(/^\/labs\/fiend\/api\/scenes\/([^/]+)\/assets\/([^/]+)\.glb$/);
      if (asset && request.method === "GET") {
        const id = sceneID.parse(asset[1]);
        const assetID = sceneID.parse(asset[2]);
        return env.SCENES.getByName(id).fetch(`https://scene/assets/${assetID}`);
      }
      const api = path.match(/^\/labs\/fiend\/api\/scenes\/([^/]+)(?:\/(live|save|edit|undo|redo|export|access))?$/);
      if (api) {
        const id = sceneID.parse(api[1]);
        if (api[2] === "export" && request.method === "GET") {
          const snapshot = await room(env, id);
          return Response.json({ ...snapshot.document, scripts: {}, history: {}, metadata: { type: "App", version: 1 } }, { headers: { "content-disposition": `attachment; filename="fiend-${id}.json"` } });
        }
        const internal = new URL(request.url);
        internal.pathname = api[2] ? `/${api[2]}` : "/";
        return env.SCENES.getByName(id).fetch(new Request(internal, request));
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const download = path.match(/^\/labs\/fiend\/s\/([^/]+)\.glb$/);
      if (download) return await downloadGLB(request, env, ctx, sceneID.parse(download[1]));
      const image = path.match(/^\/labs\/fiend\/api\/scenes\/([^/]+)\/og\.png$/);
      if (image) return await sceneImage(request, env, ctx, sceneID.parse(image[1]));
      const scene = path.match(/^\/labs\/fiend\/(s|render)\/([^/]+)\/?$/);
      let snapshot;
      if (scene) {
        sceneID.parse(scene[2]);
        snapshot = await room(env, scene[2]!);
        url.pathname = `${BASE}/${scene[1] === "s" ? "editor/index.html" : "render.html"}`;
      } else if (path === BASE || path === `${BASE}/`) url.pathname = `${BASE}/index.html`;
      else if (!path.startsWith(`${BASE}/`)) throw new SceneError("Not found", 404);
      const response = await env.ASSETS.fetch(new Request(url, request));
      const headers = new Headers(response.headers);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "same-origin");
      if (scene) headers.set("cache-control", "no-store");
      const result = new Response(response.body, { status: response.status, headers });
      return scene?.[1] === "s" && snapshot && response.ok ? sceneMetadata(result, url.origin, snapshot) : result;
    } catch (error) { return failure(error); }
  },
} satisfies ExportedHandler<Env>;
