# CarouselBot MCP

Local-first MCP companion for the hosted [CarouselBot editor](https://carousel.bot). It exposes project, slide, text, image, layer, history, rendering, and export controls to any stdio MCP client while the editor remains in the browser.

```bash
npx carouselbot@latest setup
```

Setup pins that exact package version in the generated MCP configuration. Rerun
the command when you intentionally want to update.

For non-interactive agent setup, select the current client explicitly:

```bash
npx carouselbot@latest setup --client=codex --yes
```

Replace `codex` with `claude`, `hermes`, `opencode`, or `openclaw`. OpenCode prints version-appropriate JSON to merge into its config. Other detected clients are configured through their official CLI.

## Use it immediately without restarting

The same validated tool surface is available through the package CLI when a running agent cannot refresh its native MCP tools:

```bash
npx -y carouselbot@latest call get_design_guidance
npx -y carouselbot@latest call list_editors
npx -y carouselbot@latest call begin_edit_session --json '{"editorId":"EDITOR_ID","purpose":"Build my deck"}'
npx -y carouselbot@latest call create_project --json '{"editSessionId":"SESSION_ID","name":"My presentation"}'
```

Every MCP tool name and JSON argument shape works with `call`. The CLI-only `list_tools` helper lists names compactly or returns selected schemas. `render_slide` writes image output to a temporary `previewPath` instead of dumping base64 into the terminal.

Always use `list_editors` to check the browser connection. Do not open CarouselBot or click **Connect AI** through a sandboxed, remote, or agent-controlled browser: that is a different browser session and may not reach the local companion.

Browser reconnection is automatic. Retry transient disconnects; use `restart` only for an explicit protocol mismatch or failed daemon health check. Hermes can refresh native tools with `/reload-mcp` and `/reload-skills`. Claude may need a new session to register a newly added server, but the CLI fallback works immediately.

The companion binds only to `127.0.0.1`. There is no hosted relay: projects remain in browser IndexedDB and local images remain on the user's computer.

## Installed fonts

CarouselBot can use fonts installed on the same Mac as the companion. Open a text layer's font control once and choose **Allow local fonts**. The permission is stored in that browser; until it is granted, agent calls return `FONT_PERMISSION_REQUIRED`.

Agents use project-scoped IDs rather than CSS family guesses:

```text
list_local_fonts({ query: "Didot" })
import_font({ editSessionId, projectId, localFontId })
add_text({ editSessionId, projectId, slideId, text, fontId })
```

`list_project_fonts` reports faces already embedded in a project. `add_text` and `update_text` accept the returned `fontId`, plus optional `fontWeight`, `fontStyle`, and variable-axis settings. The companion returns opaque local font IDs and never exposes font paths. A selected face is transferred over the authenticated loopback connection, persisted only in the browser's local IndexedDB project, and loaded before fitting or rendering. If the exact bytes are missing or invalid, rendering reports `FONT_UNAVAILABLE` instead of silently using a fallback.

Any MCP client can launch it with:

```bash
npx -y carouselbot@latest serve
```

Useful commands:

```bash
npx carouselbot@latest setup --dry-run
npx carouselbot@latest doctor
npx carouselbot@latest restart
```

## Existing Slide Studio installations

`slides-studio-mcp` remains as a compatibility package and delegates to CarouselBot. Existing MCP configurations therefore continue to launch, while running `carouselbot setup` replaces the visible `slide-studio` config key with `carouselbot`.

The new companion accepts both `https://carousel.bot` and the legacy `https://slides-editor.pages.dev` origin during migration. Legacy environment variables beginning with `SLIDE_STUDIO_` and the old daemon state directory remain supported.

## Parallel agents and browser tabs

Call `begin_edit_session` before editing and pass its `editSessionId` to all operations. A session atomically reserves one browser tab and one project, follows that tab instead of global focus, and expires after inactivity. Always call `end_edit_session` when finished.

For parallel editing, reserve a different connected editor for each worker. The daemon rejects conflicting claims with `EDITOR_BUSY` or `PROJECT_BUSY` and records a sanitized local audit through `list_recent_operations`; it never records slide text, prompts, file paths, or image bytes.

Browser writes use revision-checked IndexedDB transactions and cross-tab synchronization. A stale tab cannot replace a newer project snapshot; it reloads the canonical copy and returns `STALE_PROJECT` so the agent can inspect and retry.
