# CarouselBot

A focused, local-first editor for creating social carousel images.

**Canonical site:** [carousel.bot](https://carousel.bot)

Everything runs in the browser. Photos and projects stay in IndexedDB on the user's device; nothing is uploaded to an application backend.

## AI agent control

The open-source local MCP companion lets Claude Code, Codex, Hermes, OpenCode, OpenClaw, and any stdio MCP client edit the browser tab live. There is no hosted relay: the agent, image files, and companion stay on the user's computer.

```bash
npx carouselbot@latest setup
```

Open [carousel.bot](https://carousel.bot) in a normal local browser and click **Connect AI** after the agent starts the companion. The MCP can create projects and slides, edit text and image properties, manage assets and history, render temporary previews for visual inspection, and export PNG files locally.

The npm package is only a distribution surface. Its source, skill, guidance, and tests live under `packages/mcp/` in this repository. Existing `slides-studio-mcp` installations are supported by the compatibility package under `packages/slides-studio-mcp/`.

## What it does

- Persists projects and slash-path folder organization locally with IndexedDB
- Uploads multiple PNG, JPEG, WebP, GIF, SVG, or AVIF images
- Crops photos to portrait 9:16 with drag and zoom controls
- Maintains a reusable project asset library
- Adds movable and resizable text and image layers
- Supports text color, outlines, per-line backgrounds, and full-box backgrounds
- Provides a TikTok placement preview that is never exported
- Shares or downloads full-resolution 1080 × 1920 PNGs
- Allows local AI agents to create projects in folders and move them through a loopback-only MCP companion

## Run locally

```bash
npm install
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

## Test

```bash
npm test
npm run test:editor:browser
npm run test:migration:browser
npm run test:mcp:browser:local
npm run build
```

Fast editor tests use Node's built-in test runner. Browser suites launch a temporary Chrome profile and exercise the production build, IndexedDB, canvas rendering, domain migration, and the local MCP integration without adding a browser-test framework dependency.

## Architecture

The browser editor is organized as a small ES-module graph under `src/`. Pure model logic, state, persistence, views, final slide rendering, and pointer interactions have explicit boundaries; stateful workflow coordination remains in one controller. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the dependency direction, invariants, and change guide.

## Deploy to Cloudflare

This project uses Cloudflare Pages Direct Upload. The deployment contains only the browser-ready files in `dist/`; there is no backend function.

```bash
npm run deploy
```

The production deploy command is intentionally main-only. Experimental branches can use the persistent development environment with `npm run deploy:dev`.

Protected `main` updates also run the production deployment job after CI passes. The job uses the `production` GitHub environment, which is restricted to `main`, and skips until these environment secrets are configured:

- `CLOUDFLARE_ACCOUNT_ID` — the account that owns the existing `slides-editor` Pages project.
- `CLOUDFLARE_API_TOKEN` — a custom token limited to that account with **Account → Cloudflare Pages → Edit** permission.

The Cloudflare credentials are exposed only to the final Wrangler upload step; pull-request jobs never receive them. To deploy an already-merged commit after adding or rotating the secrets, manually run the **CI** workflow on `main` from the Actions tab.

The current Pages project name and legacy `slides-editor.pages.dev` hostname are intentionally retained during the domain migration. See [docs/REBRAND_ROLLOUT.md](docs/REBRAND_ROLLOUT.md) before changing GitHub, npm, Cloudflare, or DNS.

## Domain migration

The old and new domains have separate browser storage. The legacy origin therefore remains an application page long enough to read its IndexedDB and copy projects to `carousel.bot` through a token-bound, origin-checked `postMessage` protocol. Projects are transferred one at a time, acknowledged by the new origin, and never deleted from the old origin.

Migration rollout flags live in `app-config.js`. They default to a non-forwarding grace period so a code deployment cannot silently strand browser data.

## Security

Report suspected vulnerabilities privately through the process in [SECURITY.md](SECURITY.md). Pull requests run CI, CodeQL, and dependency review; OpenSSF Scorecard monitors the repository separately. Dependabot proposes dependency and GitHub Action updates.

npm releases use GitHub Actions trusted publishing instead of a stored npm token. The release workflow accepts only version tags whose commits belong to protected `main`, tests that source, and requests npm provenance. Running `carouselbot setup` pins the selected package version in the generated MCP configuration; updating is an explicit rerun of the setup command. The active controls and local trust boundaries are documented in [SECURITY.md](SECURITY.md).

## License

MIT. TikTok Sans is distributed under the SIL Open Font License 1.1; its license is included at `assets/TikTokSans-OFL.txt`. The GitHub Octicons mark is distributed under the MIT License; its notice is included at `assets/Octicons-LICENSE.txt`.
