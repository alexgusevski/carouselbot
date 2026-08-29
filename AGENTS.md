# Repository guidance

CarouselBot is a dependency-light, local-first browser editor. Keep changes focused and preserve existing behavior unless the task explicitly calls for a product change.

## Source layout

Browser application source lives in `src/`. The root `app.js` is only the compatibility bootloader; do not add editor logic to it. `dist/` is generated and must not be edited directly.

- `src/editor-model.mjs` — constants and browser-independent model, color, geometry, text-wrapping, and filename helpers.
- `src/editor-state.mjs` — shared editor state, selectors, selection, and state-aware geometry.
- `src/project-store.mjs` — IndexedDB revision checks and cross-tab project notifications.
- `src/editor-view.mjs` — markup and DOM/text painting.
- `src/slide-renderer.mjs` — full-resolution canvas rendering.
- `src/layer-interactions.mjs` — pointer, crop, drag, resize, rotate, and inline-text interactions. It receives stateful controller callbacks instead of importing the controller.
- `src/editor-projects.mjs` — project history, persistence coordination, routing, migration, and dashboard workflows.
- `src/editor-actions.mjs` — layer, text, slide, asset, upload, drop, and clipboard workflows.
- `src/editor-output.mjs` — dashboard covers, slide thumbnails, PNG downloads, and sharing.
- `src/editor-ui.mjs` — editor/dashboard rendering, DOM event binding, menus, inspector controls, selection, and canvas behavior.
- `src/editor.mjs` — composition, initialization, global event wiring, and the stable controller facade.
- `src/agent-commands.mjs` — compatibility agent command surface; it is a leaf module.
- `src/main.mjs` — startup only.

The dependency direction is documented in `docs/ARCHITECTURE.md`. Feature controllers receive their cross-workflow dependencies from `editor.mjs`; they must not import one another or the facade. Use narrowly scoped callbacks when a workflow crosses an ownership boundary.

## Invariants

- Projects remain local to IndexedDB. Do not add network storage or uploads.
- Preserve the canonical `carouselbot-db`, legacy `slide-studio-db`, `projects` store, project revision compare-and-swap behavior, and cross-tab notifications.
- Export dimensions remain 1080 × 1920. Layer positions and sizes are normalized to the stage.
- The model calls placed images `overlays`; the public agent protocol calls them `images`. Preserve that translation.
- Preserve `window.carouselBotReady`, `window.slideStudioReady`, `window.carouselBotAgent`, and `window.slideStudioAgent`.
- Keep the MCP protocol version and command behavior compatible with the companion package.
- Do not change design, copy, DOM hooks, geometry, or rendering as part of an architectural cleanup.

## Verification

Run the smallest relevant test while developing, then the complete gate before handing off:

```bash
npm run test:editor
npm test
npm run build
npm run test:editor:browser
npm run test:migration:browser
npm run test:mcp:browser:local
```

The browser commands require Chrome and loopback networking. Set `CHROME_PATH` if Chrome is not in a standard location.

When adding pure behavior, put it in `editor-model.mjs` where practical and add a Node test. When changing DOM, storage, startup, or module wiring, extend the real-browser smoke test. Avoid adding a testing dependency when the Node runner or existing Chrome DevTools harness is sufficient.

## Build and deployment

`scripts/build.mjs` hashes and copies the complete `src/` module graph. Local module URLs and the root bootloader are deliberately served with `Cache-Control: no-cache` to prevent mixed-version graphs.

Use `npm run deploy:dev` only for the shared `dev` preview after all verification passes. Production deployment has separate safeguards and is not part of routine feature work.
