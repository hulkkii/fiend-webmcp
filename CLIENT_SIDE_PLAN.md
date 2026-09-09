# Browser-only Fiend plan

Research date: 2026-09-09. Original codebase reviewed at commit `263ff7d`.

## Implementation status

The single-browser version is implemented. The backend and server MCP are removed. IndexedDB stores local scenes, bounded history, and feedback. The existing editor exposes 27 WebMCP tools; GLB export and PNG capture run locally. The static dev app was exercised in the Codex browser with real tool calls, manual editing, feedback, export, and reload persistence. Build, TypeScript, and eight focused storage tests pass.

The checklist below records the original proposal rather than a current release blocker list. Offline reopening through a service worker is deferred. JSON backups preserve scene/camera data; feedback and undo history remain in IndexedDB. Public links and cross-device synchronization are excluded as requested. Current usage is in README.md.

## Feasibility

Yes. Fiend can become a static web application that stores scenes locally and exposes modeling tools through WebMCP. Keep Three.js, the vendored editor, constrained modeling operations, and browser GLB export. Replace the Cloudflare scene service with browser storage and local state management.

This assessment comes from source inspection and current documentation. The browser-only implementation has since been built and tested as described above.

The proposed first release serves one person and an agent working in the same open editor. It has no application backend, remote database, MCP server, or application API key. Static hosting still delivers HTML, JavaScript, and assets. Development still uses a build tool and a static HTTP server. Opening the HTML directly through `file://` is outside the target.

Client-only application code does not mean local AI inference. The external agent can still use a cloud model, and scene information returned by tools can leave the browser through that agent. Running an AI model locally would be a separate project.

## What WebMCP provides

WebMCP exposes page functions as tools with descriptions and structured input schemas. It is currently a draft community report, not a finalized W3C standard. It provides a way for a user and an agent to operate the same application. [WebMCP specification](https://webmachinelearning.github.io/webmcp/)

OpenAI's current integration uses `document.modelContext.registerTool`. Register JavaScript tools in the top-level page after checking that this method exists. Its built-in browser does not discover iframe tools or declarative HTML form tools. Tools depend on the open page. Availability also depends on app version, model, workspace, and rollout. The documentation currently names GPT-5.6 Sol and Terra as supported, excludes Luna, and says Enterprise and Edu workspaces are unsupported. Recheck these details during the first milestone. [OpenAI site tools documentation](https://learn.chatgpt.com/docs/webmcp)

A normal MCP client cannot be assumed to consume these page tools. Unsupported browsers must retain the manual editor. WebMCP replaces agent access to Fiend operations; the application must still implement storage, history, rendering, and validation.

## Findings from the codebase

Paths below are relative to the repository root.

| Current code | Finding | Proposed treatment |
| --- | --- | --- |
| `src/scene.ts` | Zod operation schemas, `initialDocument`, `editDocument`, `validateDocument`, `inspect`, `find`, and `bounds`. Depends on Three.js, Zod, and Node `Buffer`. | Reuse in a browser build. Replace the two `Buffer.byteLength` calls with UTF-8 byte measurement using `TextEncoder`. |
| `src/mcp.ts` | Registers tools, adds scene credentials, calls Durable Objects, and launches Cloudflare rendering. | Reuse tool names and descriptions where their meaning still fits. Replace transport handlers with local operations. Do not import this module into the browser. |
| `src/room.ts`, `src/storage.ts` | SQLite scene persistence, revisions, undo/redo, feedback, exported assets, and WebSocket broadcasts. | Replace with IndexedDB and a small local scene controller. Do not port SQLite chunk storage or WebSocket machinery. |
| `src/client/editor.js` | Already creates the Three.js editor in the browser. Disables upstream autosave, sends HTTP patches, applies socket snapshots, clears upstream history, and overrides undo/redo. | Retain editor composition. Replace synchronization and history wiring together. |
| `src/client/scene.js`, `src/client/ui.js`, `src/client/landing.js` | Scene routing and creation rely on server IDs, access verification, and MCP connection instructions. | Use local scene IDs and a local scene library. Replace connection instructions with browser tool availability. |
| `src/client/export.js` | `exportGLB` already exports in the browser, strips lights/cameras, and preserves selected-object local transforms. | Reuse directly for local file export. |
| `src/client/render.js` | Actual capture and export use Three.js in a browser, but load the document from HTTP and are driven by Puppeteer. | Extract the render work to accept a local snapshot. Remove the HTTP bootstrap and Puppeteer dependency. |
| `src/client/feedback.js`, `src/feedback.ts` | Capture and annotation are local already. Saving, listing, and resolution call HTTP endpoints. Validation schemas are separate. | Keep the annotation UI and schemas. Store notes and image blobs locally. |
| `src/sync.ts` | UUID-based scene diff/merge shared with the browser. | Reuse only if useful for editor change detection. Remote rebase queues are unnecessary for the first release. |
| `vendor/three/editor/js/Storage.js` | IndexedDB support exists, but uses one fixed record in `threejs-editor` and callback-based error handling. | Use native IndexedDB with a Fiend-specific database and scene keys. Enabling upstream autosave alone does not supply a scene library. |
| `src/worker.ts`, `src/download.ts`, `src/og.ts`, `src/access.ts` | Routing, public URLs, headless exports/previews, and edit-secret access control. | Remove from the client fork after replacements work. |
| `scripts/build.ts`, `wrangler.jsonc`, `package.json`, `tsconfig.json` | Bun builds static assets under `/labs/fiend`; Wrangler provides runtime routes and Cloudflare bindings. Client JavaScript is not covered by the current TypeScript check. | Keep Bun and pinned dependencies. Build browser modules and serve static output without Wrangler. Add checks for new client logic. |

The existing operation limits are useful starting points: 100 operations per batch, 2,000 objects, 64 hierarchy levels, and 50 MiB of scene JSON. Browser memory and storage measurements must determine practical limits. Twenty full 50 MiB history entries would already approach 1 GiB before other data.

## Scope and trade-offs

| Capability | Browser-only outcome |
| --- | --- |
| Modeling, materials, hierarchy, inspection, framing | Keep through local operations. |
| Manual editing alongside an agent | Keep, with both using one ordered mutation path and one undo history. |
| Save and reopen scenes | Keep within the same browser profile and origin. Add explicit backup files. |
| GLB and editor JSON export | Keep as local downloads. |
| Agent screenshots | Render locally. Verify the agent's supported image result format before promising parity. |
| Feedback notes and annotations | Keep locally, including agent read and resolve tools. |
| Path-traced viewing | Retain where the device supports it. Keep ordinary rendering available. |
| Public scene URLs and permanent GLB URLs | Remove from the first release. Local IDs and blob URLs do not share scene data with another device. |
| Live collaboration across devices | Remove from the first release. WebMCP does not supply synchronization or shared storage. |
| Tools while the page is closed | Unavailable in this design. |
| Scene-specific social link previews | Remove. Static application metadata can remain. |
| Offline editing after initial load | Add an app cache milestone. AI access is a separate connectivity requirement. |

IndexedDB can store structured scene records and blobs without a new database dependency. Data belongs to the application's origin. Browser quotas, eviction, private browsing, and user deletion affect durability, so autosave must be paired with backup export and visible errors. A persistent-storage request can help but is not a backup guarantee. [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), [storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

## Proposed structure

```text
Manual Three.js editor       Agent in a compatible browser
          |                              |
          |                        WebMCP handlers
          +---------------+--------------+
                          |
               Local scene controller
              validation, revisions, history
                    |             |
                 IndexedDB    Three.js viewport
                              capture and export
```

Keep the current plain JavaScript editor and Bun build. No frontend framework, backend emulation, MCP bridge, CRDT, or SQL-in-WASM is needed for this scope.

Start with two new modules: a local scene controller that also owns IndexedDB access, and WebMCP registration. Extract capture logic only where needed. Keep schemas and document transformations in `src/scene.ts`. Bundle Zod with the browser logic and share the editor's existing Three.js import mapping to avoid two Three.js runtimes.

Use local scene IDs, with hash-based navigation such as `editor/index.html#scene=<uuid>`. The fragment identifies local data, carries no edit secret, and works without server route rewrites. Explicitly label such addresses as local bookmarks.

The controller owns the committed snapshot and bounded history. Flush a completed manual edit before an agent mutation, validate the candidate document, parse it successfully, and commit its document/history/revision in one IndexedDB transaction. Publish success only after transaction completion. On failure, retain the previous committed state and preserve any unsaved manual work for retry or export.

Use the same history for toolbar, keyboard, and agent undo/redo. Commit a transform drag as one edit rather than one entry per pointer movement. Orbit, selection, and resize remain local view changes. Explicit camera tools change the saved capture camera.

## Task list

### 1. Prove WebMCP compatibility before migration

- [ ] Open a small static proof page in the intended agent browser and record its app, model, and API support.
- [ ] Register `inspect_scene` and `add_mesh` through `document.modelContext.registerTool`, guarded by feature detection.
- [ ] Demonstrate actual agent discovery and invocation, with the created mesh visible on the same page.
- [ ] Test JSON results, invalid input, handler errors, repeated registration, and page navigation. Keep registration scoped to the active scene.
- [ ] Test a locally rendered PNG and a prepared GLB download. Record what the agent can receive, view, and download. Do not assume existing MCP image content blocks work unchanged.
- [ ] Verify that the editor remains usable when WebMCP is absent or disabled.

Completion criterion: an agent can inspect and edit a static Three.js page without an MCP server. Record any image or download limitations before proceeding.

### 2. Make the modeling core browser-compatible

- [ ] Replace Node `Buffer` byte counting in `src/scene.ts` with `TextEncoder`.
- [ ] Add a browser-targeted build for the scene operations using the existing Bun tooling and Zod dependency.
- [ ] Keep Node, Cloudflare, Puppeteer, and MCP SDK imports out of that bundle.
- [ ] Reuse existing input schemas at runtime. Produce WebMCP JSON Schemas from them where supported, checking defaults and discriminated operations against the installed Zod version.
- [ ] Add focused tests for batch rollback, references to earlier batch additions, duplicate-name rejection, cycle rejection, independent material edits, and non-ASCII byte counting.

Completion criterion: the browser can create, inspect, and atomically modify a document using the existing constrained operations.

### 3. Implement local persistence and history

- [ ] Create a versioned IndexedDB database with scenes keyed by UUID. Store feedback and image blobs separately.
- [ ] Implement create, list, load, rename, duplicate, and delete for local scenes.
- [ ] Serialize mutations and keep revision checks. Prevent a second tab from silently overwriting newer data through an atomic stored-revision check and a reload/conflict message.
- [ ] Implement bounded undo/redo in the same transaction as the scene commit. Apply both entry-count and byte limits.
- [ ] Handle database opening, schema upgrades, blocked upgrades, transaction aborts, and quota failures. Display saved, saving, and unsaved states truthfully.
- [ ] Request persistent storage where available and provide an export action when saving fails.
- [ ] Verify multiple-scene isolation, reload persistence, stale revisions, and transaction rollback. Check that a failed save leaves the last durable scene intact.

Completion criterion: two independent scenes survive reload, and mixed manual/agent history can be undone and redone without data loss.

### 4. Connect the existing editor to local state

- [ ] Replace the access check in `src/client/scene.js` and scene creation in `src/client/ui.js` with local loading and creation.
- [ ] Replace the HTTP saves, WebSocket lifecycle, pending remote patches, and server history calls in `src/client/editor.js`.
- [ ] Route manual scene changes and tool operations through the controller. Prevent feedback loops while applying snapshots.
- [ ] Replace upstream history overrides consistently, including keyboard shortcuts. Preserve selection and local view across unrelated edits.
- [ ] Add a minimal local scene library and rename the connection status to describe local persistence.
- [ ] Remove public-share and edit-secret UI. Provide import, backup, and export actions.
- [ ] Retain keyboard access and announce save and tool errors through the existing status UI.

Completion criterion: create a scene, drag an object, change it through an agent, undo both changes in order, reload, and reopen the saved scene with no API or WebSocket requests.

### 5. Port the tool catalog

- [ ] Port `create_scene`, `inspect_scene`, and `inspect_object` to local scenes. Default editing tools to the active scene and validate any explicit scene ID against it.
- [ ] Port `edit_scene` and all operation wrappers from `src/mcp.ts`: mesh/group/extrusion/lathe/tube creation, lights, transforms, materials, duplicate, rename, remove, reparent, background, camera, and framing.
- [ ] Port `undo_scene` and `redo_scene` to the shared local history.
- [ ] Remove `secret`, server URLs, and server-specific instructions from tool schemas and results. Preserve units, angle conventions, UUID selectors, and useful operation limits.
- [ ] Return committed revision, affected or created UUIDs, and concise results. Wait for the visible scene to reflect the committed edit before reporting completion.
- [ ] Omit `get_scene_link` from the first release. Add a clearly named local-bookmark tool only if it proves useful.
- [ ] Keep handlers constrained. Do not expose arbitrary JavaScript execution. Validate runtime arguments even when schemas are published.

Completion criterion: an agent can assemble and refine an asset through local tools, and a failed batch changes neither the document nor history.

### 6. Finish capture, export, import, and feedback

- [ ] Reuse `exportGLB` for scene/group export and add editor JSON download. Prepare a visible download action when automatic download is unavailable.
- [ ] Return filename, format, byte size, and revision for exports. Never describe a blob URL as a durable public URL or a download as a verified file on disk.
- [ ] Refactor capture from `src/client/render.js` to use a committed snapshot and its saved camera. Preserve object screen positions and bounds, exclude editor helpers, and dispose temporary GPU resources.
- [ ] Use the image delivery method verified in milestone 1. If inline tool images fail, expose a visible capture preview for ordinary browser inspection and document the limitation.
- [ ] Replace feedback fetches with local storage calls. Port `get_feedback` and `resolve_feedback`, retaining pagination, fixed captured views, selective resolution, and no scene-history entries.
- [ ] Import the original application's exported editor JSON into a new local scene. Also define a versioned backup format for scene metadata and optional feedback.
- [ ] Validate imports before replacing any state. Exclude executable project scripts and handle missing textures, external URLs, and oversized files explicitly.
- [ ] Round-trip JSON and GLB files. Check procedural geometry, materials, hierarchy, pivots, and exclusion of preview lights/cameras.

Completion criterion: model an asset, capture it, leave and resolve feedback, export it, and import a backup without contacting the original backend.

### 7. Remove backend requirements and verify static delivery

- [ ] Change `dev` to serve the static build and replace the Cloudflare deployment command with documented static hosting steps.
- [ ] Remove server-only source files and dependencies after the local replacements pass. Remove Wrangler configuration and Worker types from the client fork.
- [ ] Update `scripts/build.ts`, HTML base paths, import maps, and hard-coded `/labs/fiend` links for the selected static mount path.
- [ ] Audit runtime asset requests. `vendor/three/editor/js/Loader.js` still references a remote Rhino library; bundle optional dependencies or clearly exclude those import formats from offline support.
- [ ] Add a versioned service worker cache if offline reopening is part of release scope. Audit the vendored service worker before enabling it and avoid competing registrations.
- [ ] Verify that cached core editing, save/load, capture, and export work without network access. Test cache upgrades without touching scene data.
- [ ] Update the README with local storage boundaries, backup instructions, supported browsers, WebMCP setup, and removed public/collaboration features. Preserve vendor license notices and provenance.
- [ ] Check the production network log for calls to `/api/scenes`, `/mcp`, WebSockets, and the original hosted service. Require none during the core workflow.

Completion criterion: the production build runs from static files with no Fiend backend. Document the tested browser and agent combination, plus any offline import exceptions.

## Release order

Complete milestone 1 first. It is the main integration uncertainty. Milestones 2 through 5 deliver the local editor and modeling tools. Milestone 6 completes the asset workflow. Milestone 7 removes the old infrastructure and verifies delivery.

Keep cross-device synchronization, public publishing, embedded chat, local model inference, and headless automation outside this first release. They change the product scope and are not required to make a useful personal Fiend.
