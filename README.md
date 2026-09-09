# Fiend in your browser

A personal 3D asset workshop for you and an agent. Model in the Three.js editor, let an agent use the page's WebMCP tools, and export GLB assets.

All application logic and scene storage run in your browser. There is no application backend, MCP server, account, or API key. This fork is for one user and browser, with no public scene links or cross-device synchronization.

## Run locally

Install [Bun](https://bun.sh), then run:

```sh
bun install
bun run dev
```

Open [Fiend](http://localhost:8787). The development server serves static files only. Run `bun run build` after changing source files and reload the page.

Create a scene from the scene library, or import a JSON backup. Use **Scenes** to return to the library, where you can rename, duplicate, and delete scenes. **Save** retries local saving. Changes also autosave.

## Work with an agent

Open a scene in an agent browser that supports WebMCP, such as a supported Codex in-app browser. Ask the agent to inspect the scene and build an object. Keep that page open while working.

Fiend registers 27 tools through `document.modelContext.registerTool`. The **Agent tools** button reports availability. If WebMCP is unavailable, manual editing and saving still work. No MCP connection URL or edit secret is needed.

The tool catalog includes:

| Purpose | Tools |
| --- | --- |
| Scenes | `create_scene`, `inspect_scene`, `inspect_object` |
| Modeling | `add_mesh`, `add_group`, `add_extrusion`, `add_lathe`, `add_tube` |
| Editing | `update_object`, `duplicate_object`, `rename_object`, `remove_object`, `reparent_object` |
| Appearance | `set_material`, `add_light`, `set_light`, `set_background` |
| Camera | `set_camera`, `frame_object`, `capture_scene` |
| History | `edit_scene`, `undo_scene`, `redo_scene` |
| Feedback | `get_feedback`, `resolve_feedback` |
| Export | `export_asset`, `export_scene` |

Tools act on the open scene. An optional `scene_id` guards against editing a different scene. Objects can be selected by UUID or a unique name. Coordinates are Y-up in meters, Euler rotations use XYZ radians, and colors use `#rrggbb`.

Use `edit_scene` for atomic batches of up to 100 operations. A failed batch leaves the scene unchanged. Manual and agent changes share undo/redo history. Orbiting and selecting objects do not create history entries. Explicit camera tools update the saved capture camera.

`capture_scene` renders locally and opens a PNG preview in the page, with object positions and bounds returned to the agent. The agent can inspect the preview through its browser. Image content blocks from traditional MCP are not required.

[OpenAI's WebMCP documentation](https://learn.chatgpt.com/docs/webmcp) describes browser availability and supported APIs.

## Save and export

Scenes persist in IndexedDB for the current browser profile and origin. A different port, hostname, browser, or profile has separate storage. Clearing site data removes scenes. Keep JSON backups of work you want to preserve.

**Backup JSON** prepares a download of the current scene, including unsaved work if local saving fails. Import that backup from the scene library. Original Fiend editor JSON exports can also be imported. Backups contain the scene and camera; feedback notes and undo history stay in browser storage.

**Export GLB** exports the selected object or the whole scene when nothing is selected. The export preserves geometry, materials, hierarchy, and local pivots, and excludes preview lights and cameras. Click the download link in the file dialog to save it. File URLs are temporary and belong to the current page.

Undo/redo keeps at most 20 entries and a 100 MiB history budget. A scene is limited to 50 MiB of JSON, 2,000 objects, and 64 hierarchy levels. Browser storage quotas and device memory can impose lower limits. A stale edit from another tab is rejected instead of silently overwriting saved work.

## Feedback

Open **Feedback** to capture the current view, select objects, draw annotations, and leave a note for your agent. Saved views stay fixed as the scene changes. Ask the agent to read feedback and resolve the notes it addresses. Notes and screenshots save locally and do not enter scene history.

## Build and deployment

```sh
bun run build
bun run check
bun test
```

Host the contents of `dist/` on a static HTTP server or HTTPS host. Relative assets and hash-based scene navigation support hosting at a subdirectory. No route rewrites or cloud services are required. Use HTTP or HTTPS rather than opening `index.html` as a file.

The core application assets are bundled locally. Offline reopening is not currently provided by a service worker. The editor's optional upstream asset loaders may need additional resources for some formats.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/scene.ts` | Validated modeling operations and Three.js document transformations |
| `src/local.ts` | IndexedDB, revisions, history, and feedback |
| `src/client/editor.js` | Local editor integration and shared action ordering |
| `src/client/webmcp.js` | Page tool registration and schemas |
| `src/client/capture.js` | Local screenshot rendering |
| `src/client/export.js` | Browser GLB export |
| `src/client/feedback.js` | Captured feedback and annotation UI |
| `src/client/landing.js` | Local scene library and JSON import |
| `scripts/build.ts` | Static build with the pinned Three.js editor |
| `scripts/dev.ts` | Local static HTTP server |

Based on [anomalyco/fiend](https://github.com/anomalyco/fiend). The editor and bundled font licenses are retained. See [vendor provenance](vendor/README.md).
