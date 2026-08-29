# Editor architecture

CarouselBot is a static, local-first browser application. There is no application backend: projects and imported images remain in IndexedDB, while the optional MCP companion communicates with the open browser over loopback.

The editor deliberately uses a small ES-module graph rather than a framework or bundler. Each extracted module represents a stable responsibility; stateful workflow coordination stays together in one controller.

## Dependency direction

```text
main ────────────────> editor + agent-commands
agent-commands ──────> editor + store + view + renderer + state + model
editor ──────────────> interactions + store + view + renderer + state + model
layer-interactions ──> editor-view + editor-state + editor-model
store/view/renderer ─> editor-state + editor-model
editor-state ────────> editor-model
```

An arrow points from an importing module toward its dependencies. No foundational module imports the controller, so the graph remains acyclic.

`layer-interactions.mjs` receives a small set of controller callbacks when the editor starts. This keeps pointer behavior separate without creating an `editor` ↔ `layer-interactions` import cycle.

## Modules

### Model

`editor-model.mjs` contains constants and behavior that does not depend on mutable editor state or browser lifecycle: routes, color normalization, project cloning, layer ordering, crop normalization, image layout, text wrapping, box geometry, and safe filenames. This is the primary unit-test seam.

### State

`editor-state.mjs` owns the live editor state, history stacks, active-project selectors, layer selection, and calculations that intentionally depend on current crop or stage state. State is shared through ES-module live bindings and is never copied onto `window`.

### Persistence

`project-store.mjs` owns the IndexedDB store and cross-tab notification channel. Writes use the project revision as a compare-and-swap value. A stale write must reload the newer stored project rather than overwrite it.

The controller owns the behaviors that combine persistence with rendering, such as migration imports, stale-project reloads, debounced saves, and external project updates.

### Views and rendering

`editor-view.mjs` creates editor markup and updates live layer DOM. `slide-renderer.mjs` draws the export representation onto a canvas. Both use the same model helpers for colors, crops, layer order, text alignment, wrapping, and boxed-text geometry.

Dashboard covers and slide thumbnails also use the final slide renderer. Blob URLs are versioned and revoked by the controller to prevent stale previews and leaks.

### Interactions and controller

`layer-interactions.mjs` contains pointer mechanics and inline text editing. `editor.mjs` remains the single stateful controller for routing, view lifecycle, event binding, history application, mutations, file handling, clipboard behavior, save scheduling, export, and sharing.

Keeping this coordination together is intentional. Splitting every event handler into a separate module would add callback plumbing or circular imports without creating a meaningful ownership boundary.

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

## Data and rendering invariants

- Output is 1080 × 1920.
- Layer `x`, `y`, `width`, and `height` are normalized to the stage.
- The base photo uses cover sizing plus normalized pan offsets and a 1–3× scale.
- Overlay crop rectangles are normalized within the source image and have a minimum 5% size.
- Layer `z` values determine one combined ordering across text and overlays.
- Text wrapping and boxed-line geometry must agree between DOM previews and exported canvas images.
- TikTok placement chrome is preview-only and is never exported.
- Project images stay embedded in the local project record; they are not uploaded by the application.

## Testing strategy

The permanent regression layers are:

1. Node unit tests for model, state, storage protocol contracts, migration, MCP protocol, and build structure.
2. A focused production-build Chrome smoke test for module loading, direct UI editing and interactions, upload, history, IndexedDB CRUD and revision conflicts, routes, compatibility globals, and canvas rendering.
3. Browser migration and full MCP integration suites for pre-deployment verification.

Avoid committed pixel snapshots. Canvas output can vary across browser and platform versions; behavioral assertions and same-environment differential checks are more reliable for refactors.

## Where a change belongs

- Pure calculation or normalization: `editor-model.mjs`.
- Active selection or state-aware geometry: `editor-state.mjs`.
- IndexedDB transaction or project notification: `project-store.mjs`.
- Markup or live DOM painting: `editor-view.mjs`.
- Final exported pixels: `slide-renderer.mjs`.
- Pointer/crop/resize mechanics: `layer-interactions.mjs`.
- User workflow spanning multiple responsibilities: `editor.mjs`.
- Public automation command: `agent-commands.mjs`, normally backed by an existing model/controller operation.
