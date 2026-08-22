# Slide Studio MCP

Local-first MCP companion for the hosted [Slide Studio test editor](https://slides-mcp-poc-0821.pages.dev). It exposes complete project, slide, text, image, layer, history, rendering, and export controls to any stdio MCP client while the editor remains in the browser.

```bash
npx slides-studio-mcp@beta setup
```

If an agent is doing the setup itself, it should select its current client and run non-interactively:

```bash
npx slides-studio-mcp@beta setup --client=codex --yes
```

Replace `codex` with `claude`, `hermes`, `opencode`, or `openclaw` for the agent doing the setup. OpenCode prints the version-appropriate JSON to merge into its config. Other detected clients are configured through their official CLI.

## Use it immediately without restarting

Some clients do not add a newly configured MCP server to the tool catalog of the already-running session. The same validated tool surface is available through the package CLI, so the current agent can continue immediately:

```bash
npx -y slides-studio-mcp@beta call get_design_guidance
npx -y slides-studio-mcp@beta call list_editors
npx -y slides-studio-mcp@beta call list_tools --json '{"names":["add_slide","add_text"]}'
npx -y slides-studio-mcp@beta call create_project --json '{"name":"My presentation"}'
```

Every MCP tool name and JSON argument shape works with `call`. The CLI-only `list_tools` helper lists all names compactly, or returns schemas for the requested names. The CLI automatically applies the guidance gate for each invocation and prints compact JSON. `render_slide` writes image output to a temporary `previewPath` instead of dumping base64 into the terminal.

Always use `list_editors` to check the browser connection. Do not open Slide Studio or click **Connect AI** through a sandboxed, remote, or agent-controlled browser: that is a different browser session and may not have access to the user's local companion. If no editor is listed, ask the user to open the editor in their normal browser on the same computer and connect there, then retry `list_editors`.

Hermes can refresh native tools without restarting by running `/reload-mcp`, then `/reload-skills`. Claude may still need a new session to register a newly added plain stdio server, but its current session can use the CLI fallback instead of stopping.

The companion binds only to `127.0.0.1`. There is no hosted relay: projects remain in browser IndexedDB and local images remain on the user's computer.

Any MCP client can launch it with:

```bash
npx -y slides-studio-mcp@beta serve
```

Useful commands:

```bash
npx slides-studio-mcp@beta setup --dry-run
npx slides-studio-mcp@beta doctor
npx slides-studio-mcp@beta restart
```

`restart` gracefully replaces an outdated local companion. Reload the real browser editor afterward; beta.6 MCP clients automatically recover their daemon registration.

Open the test editor in the user's normal local browser, click **Connect AI**, and call `get_design_guidance` before editing. The server enforces that one-time read and provides `render_slide` so agents can inspect actual pixels without permanently storing previews.
