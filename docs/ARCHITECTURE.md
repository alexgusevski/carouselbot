# Editor architecture

CarouselBot is a static, local-first browser application. There is no application backend: projects and imported images remain in IndexedDB, while the optional MCP companion communicates with the open browser over loopback.

The editor deliberately uses a small ES-module graph rather than a framework or bundler. Each module represents a stable responsibility, while `editor.mjs` remains the composition root and compatibility facade.

## Dependency direction

```text
main ───────────────> editor + agent-commands
agent-commands ─────> editor + store + view + renderer + fonts + state + model
editor ─────────────> projects + actions + output + UI + store + state + model
UI ─────────────────> interactions + view + fonts + state + model
projects ───────────> store + view + fonts + state + model
actions ────────────> store + renderer + fonts + state + model
output ─────────────> renderer + view + state + model
interactions ───────> view + state + model
view/renderer ──────> fonts + state + model
fonts/store ────────> model
state ──────────────> model
```

An arrow points from an importing module toward its dependencies. The four feature controllers do not import one another; `editor.mjs` supplies their cross-workflow callbacks during composition. No foundational module imports a controller or the facade, so the static graph remains acyclic.

`editor-ui.mjs` creates `layer-interactions.mjs` with a small set of named callbacks. The same explicit injection pattern connects project, action, output, and UI workflows without circular imports or a mutable service locator.

## Modules

### Model

`editor-model.mjs` contains constants and behavior that does not depend on mutable editor state or browser lifecycle: project and virtual-folder routes, folder-path normalization, color normalization, project cloning, layer ordering, crop normalization, image layout, text wrapping, box geometry, and safe filenames. This is the primary unit-test seam.

### State

`editor-state.mjs` owns the live editor state, history stacks, active-project selectors, layer selection, and calculations that intentionally depend on current crop or stage state. State is shared through ES-module live bindings and is never copied onto `window`.

### Persistence

`project-store.mjs` owns the IndexedDB store and cross-tab notification channel. Writes use the project revision as a compare-and-swap value. A stale write must reload the newer stored project rather than overwrite it.

`editor-projects.mjs` owns the behaviors that combine persistence with rendering, such as migration imports, stale-project reloads, debounced saves, external project updates, history, routes, and project deletion. It also contains the legacy-record normalization seam exercised by Node tests.

Dashboard folders are derived from each project's optional canonical `folderPath` (for example `/campaigns`). They are intentionally not separate IndexedDB records: moving a project remains one revision-checked project write, cross-tab notifications need no second protocol, and legacy-origin migration copies folder membership with the project. Empty folders therefore disappear automatically.

### Views and rendering

`editor-view.mjs` creates editor markup and updates live layer DOM. `slide-renderer.mjs` draws the export representation onto a canvas. Both use the same model helpers for colors, crops, layer order, text alignment, wrapping, and boxed-text geometry.

`project-fonts.mjs` owns project-font normalization, private local face data, `FontFace` registration, public redaction, and the shared font descriptors used by DOM and canvas rendering. `ensureProjectFontsLoaded` is the exact-font gate before measurement or rendered output. A missing or invalid imported face remains editable with a visible warning, but rendering and export fail with `FONT_UNAVAILABLE` instead of silently accepting fallback pixels.

Dashboard covers and slide thumbnails also use the final slide renderer. `editor-output.mjs` versions and revokes their Blob URLs to prevent stale previews and leaks, and owns the related PNG download and Web Share workflows.

### Actions and UI

`editor-actions.mjs` owns state-changing editor workflows for layers, text, slides, assets, uploads, drops, and clipboard data. It coordinates the existing model, state, store, and image helpers but does not own DOM binding.

`editor-ui.mjs` owns dashboard/editor rendering and DOM behavior: menus, event binding, inspector controls, selection, stage sizing, and zoom. `layer-interactions.mjs` remains focused on pointer mechanics and inline text editing.

The split stops at these workflow boundaries. Individual controls and event handlers remain together instead of becoming one-file abstractions with no independent ownership.

### Composition and lifecycle

`editor.mjs` constructs the four feature controllers, wires only the callbacks that cross their boundaries, initializes IndexedDB, installs document-level events, and re-exports the stable controller functions used by the agent compatibility layer. Import-time project synchronization listeners remain owned by the project controller; initialization-time browser listeners remain in the facade.

### Agent compatibility and startup

`agent-commands.mjs` translates the public command protocol into the same model and controller operations used by the UI. Internal placed-image records are `overlays`; protocol responses expose them as `images`.

The root `app.js` immediately establishes the readiness promise and dynamically loads `src/main.mjs`. Startup then installs the agent compatibility globals before initializing IndexedDB and rendering the current route. The following aliases are public compatibility surfaces:

```text
window.carouselBotReady
window.slideStudioReady
window.carouselBotAgent
window.slideStudioAgent
```

The local MCP bridge waits for the readiness promise before processing operations.

The stdio MCP process and shared loopback daemon have independent lifetimes. The daemon health response advertises its internal action set and daemon API version; a newly launched MCP process replaces a daemon that cannot implement its tool surface before registering with the host. Existing MCP processes and remembered browser connections reconnect to the replacement automatically. Package setup additionally upgrades a compatible-but-older daemon so installed agent skills, schemas, and daemon code move forward together. Browser `protocolVersion` remains a separate compatibility contract and must not be used as a proxy for MCP-to-daemon capabilities.

### Local-font companion boundary

Installed fonts are an optional capability of the loopback MCP companion. After explicit permission in the editor, the companion indexes supported macOS font directories, parses each face (including every TTC face), and returns only stable opaque `localFontId` metadata. Filesystem paths, index fingerprints, and raw bytes never appear in MCP or inspection responses.

An import resolves one selected face inside the companion and transfers its bytes once to the reserved browser tab over the authenticated loopback bridge. TTC faces are repacked as standalone SFNT data before transfer. The browser stores those bytes only in the local IndexedDB project record, registers a generated CSS family, and returns a project-scoped `fontId`; agents apply that ID to text instead of guessing a family name. The companion retains only its private index, recent-use metadata, and short-lived pending transfers.

## Data and rendering invariants

- Output is 1080 × 1920.
- Layer `x`, `y`, `width`, and `height` are normalized to the stage.
- The base photo uses cover sizing plus normalized pan offsets and a 1–3× scale.
- Overlay crop rectangles are normalized within the source image and have a minimum 5% size.
- Layer `z` values determine one combined ordering across text and overlays.
- Text wrapping and boxed-line geometry must agree between DOM previews and exported canvas images.
- Imported font bytes remain local, and font metadata returned to agents never contains a filesystem path or stored bytes.
- A text layer using a project font is measured and rendered only after that exact face has loaded.
- TikTok placement chrome is preview-only and is never exported.
- Project images stay embedded in the local project record; they are not uploaded by the application.
- Layer geometry is applied with dynamic style attributes. The deployment CSP permits style attributes while keeping stylesheet and script sources restricted to the application origin.

## Testing strategy

The permanent regression layers are:

1. Node unit tests for model, state, storage protocol contracts, migration, MCP protocol, and build structure.
2. A focused production-build Chrome smoke test for module loading, direct UI editing and interactions, upload, history, IndexedDB CRUD and revision conflicts, routes, compatibility globals, and canvas rendering.
3. Browser migration and full MCP integration suites for pre-deployment verification.

Avoid committed pixel snapshots. Canvas output can vary across browser and platform versions; behavioral assertions and same-environment differential checks are more reliable for refactors.

## Where a change belongs

- Pure calculation or normalization: `editor-model.mjs`.
- Project-font records, exact-face loading, or shared font descriptors: `project-fonts.mjs`.
- Active selection or state-aware geometry: `editor-state.mjs`.
- IndexedDB transaction or project notification: `project-store.mjs`.
- Markup or live DOM painting: `editor-view.mjs`.
- Final exported pixels: `slide-renderer.mjs`.
- Pointer/crop/resize mechanics: `layer-interactions.mjs`.
- Project history, routes, saves, migration, or cross-tab reload: `editor-projects.mjs`.
- Layer, slide, asset, upload, drop, or clipboard mutation: `editor-actions.mjs`.
- Preview cache, PNG download, or Web Share workflow: `editor-output.mjs`.
- DOM rendering, binding, inspector, selection, or canvas interaction: `editor-ui.mjs`.
- Cross-controller wiring or document-level startup lifecycle: `editor.mjs`.
- Public automation command: `agent-commands.mjs`, normally backed by an existing model/controller operation.
