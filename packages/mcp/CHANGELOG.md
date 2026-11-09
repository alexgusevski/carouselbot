# Changelog

## 0.5.0

The first npm release since 0.4.2. It ships everything listed under 0.4.3 (browser pairing, production-only origins, the owner-only state folder) plus the changes below.

### Security

- **MCP SDK 2.4.0.** `@modelcontextprotocol/server` moves to 2.4.0, past the vulnerable 2.0.0–2.2.0 range ("Shared transport or server instances delivered one HTTP client's messages to another" and "One HTTP request within the default size limit could exhaust server memory"). The companion speaks MCP over stdio with one server per process and runs its own loopback bridge with per-request size limits, so neither issue was reachable. `npm audit` of a fresh install now reports nothing.
- **Bounded `carouselbot call --stdin`.** Tool arguments read from stdin are capped at 144 MiB, the same limit the bridge applies to one tool call, and oversized input fails before it is buffered.
- **Exact dependency pins.** `fontkit` 2.0.4 and `zod` 4.6.7 are pinned exactly, like the MCP SDK.

### Compatibility

- **Node.js 22 or newer.** Node 20 reached end of life in April 2026, so `engines.node` is now `>=22`. CI runs the companion tests on Node 22 and the full suite on Node 26.
- The carousel.bot editor works with both 0.4.2 (connects directly) and 0.5.0 (asks for the pairing code once).
- `slides-studio-mcp` 0.5.0 depends on `carouselbot` 0.5.0.

## 0.4.3

Not published to npm. These changes ship in 0.5.0.

### Security

- **Browser pairing.** The companion now trusts a browser only after you approve it once. CarouselBot shows a one-time code; approve it with `npx carouselbot pair <code>` or by giving the code to your agent (`pair_browser` tool). Paired browsers reconnect on reloads and new tabs automatically. `npx carouselbot pair --forget-all` removes every paired browser. Pairing keys are stored only as SHA-256 hashes in an owner-only file.
- **Production origins only.** The companion trusts `https://carousel.bot` and `https://slides-editor.pages.dev`. Local development origins (`http://127.0.0.1:4173`, `http://localhost:4173`) require `CAROUSELBOT_DEV_ORIGINS=1`, so an unrelated project on Vite's default preview port can no longer reach the bridge.
- **Owner-only state folder on every start.** The daemon resets its state folder to `0700` each time it starts, including folders created by older versions and the legacy `SlideStudioMCP` location.
- **Patched dependencies.** `@modelcontextprotocol/server` 2.0.0 → 2.3.1 (GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq) and `zod` → ^4.6.7 (GHSA-mrhx-c7xc-m3w5). The companion uses stdio and its own loopback server, so these SDK issues were not reachable, and every install now resolves the fixed versions.

### Compatibility

- The carousel.bot editor works with both 0.4.2 (connects directly) and 0.4.3 (asks for the pairing code once).
- An editor page loaded before this release gets a clear "reload CarouselBot" message from a 0.4.3 companion instead of a session.
- `slides-studio-mcp` 0.4.3 depends on `carouselbot` 0.4.3.
