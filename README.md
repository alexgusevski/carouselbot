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

- Persists projects locally with IndexedDB
- Uploads multiple PNG, JPEG, WebP, GIF, SVG, or AVIF images
- Crops photos to portrait 9:16 with drag and zoom controls
- Maintains a reusable project asset library
- Adds movable and resizable text and image layers
- Supports text color, outlines, per-line backgrounds, and full-box backgrounds
- Provides a TikTok placement preview that is never exported
- Shares or downloads full-resolution 1080 × 1920 PNGs
- Allows local AI agents to edit through a loopback-only MCP companion

## Run locally

```bash
npm install
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

## Test

```bash
npm run test:migration
npm run test:migration:browser
npm run test:mcp
npm run test:mcp:browser:local
npm run build
```

## Deploy to Cloudflare

This project uses Cloudflare Pages Direct Upload. The deployment contains only the browser-ready files in `dist/`; there is no backend function.

```bash
npm run deploy
```

The production deploy command is intentionally main-only. Experimental branches can use the persistent development environment with `npm run deploy:dev`.

The current Pages project name and legacy `slides-editor.pages.dev` hostname are intentionally retained during the domain migration. See [docs/REBRAND_ROLLOUT.md](docs/REBRAND_ROLLOUT.md) before changing GitHub, npm, Cloudflare, or DNS.

## Domain migration

The old and new domains have separate browser storage. The legacy origin therefore remains an application page long enough to read its IndexedDB and copy projects to `carousel.bot` through a token-bound, origin-checked `postMessage` protocol. Projects are transferred one at a time, acknowledged by the new origin, and never deleted from the old origin.

Migration rollout flags live in `app-config.js`. They default to a non-forwarding grace period so a code deployment cannot silently strand browser data.

## Security

Report suspected vulnerabilities privately through the process in [SECURITY.md](SECURITY.md). Pull requests are checked by CI, CodeQL, dependency review, and OpenSSF Scorecard. Dependency and GitHub Action updates are proposed automatically by Dependabot, and release packages are published from tagged GitHub releases through the provenance-enabled workflow in `.github/workflows/publish.yml`.

## License

MIT. TikTok Sans is distributed under the SIL Open Font License 1.1; its license is included at `assets/TikTokSans-OFL.txt`. The GitHub Octicons mark is distributed under the MIT License; its notice is included at `assets/Octicons-LICENSE.txt`.
