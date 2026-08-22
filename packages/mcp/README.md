# Slide Studio MCP

Local-first MCP companion for the hosted [Slide Studio test editor](https://slides-mcp-poc-0821.pages.dev). It exposes complete project, slide, text, image, layer, history, rendering, and export controls to any stdio MCP client while the editor remains in the browser.

```bash
npx slides-studio-mcp@beta setup
```

If an agent is doing the setup itself, it should select its current client and run non-interactively:

```bash
npx slides-studio-mcp@beta setup --client=codex --yes
```

Replace `codex` with `claude`, `hermes`, `opencode`, or `openclaw` for the agent doing the setup. OpenCode prints the version-appropriate JSON to merge into its config. Other detected clients are configured through their official CLI. Restart the client after setup if it does not reload MCP servers automatically.

The companion binds only to `127.0.0.1`. There is no hosted relay: projects remain in browser IndexedDB and local images remain on the user's computer.

Any MCP client can launch it with:

```bash
npx -y slides-studio-mcp@beta serve
```

Useful commands:

```bash
npx slides-studio-mcp@beta setup --dry-run
npx slides-studio-mcp@beta doctor
```

Open the test editor, click **Connect AI**, and call `get_design_guidance` before editing. The server enforces that one-time read and provides `render_slide` so agents can inspect actual pixels without permanently storing previews.
