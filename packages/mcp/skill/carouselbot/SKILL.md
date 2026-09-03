---
name: carouselbot
description: Create, edit, visually inspect, and export CarouselBot slides through the local CarouselBot MCP companion.
---

# CarouselBot

Use the CarouselBot MCP tools for all carousel changes. The hosted browser editor is the live visual surface; local files and rendered images pass only through the local companion.

Before using any browser or making edits, call `list_editors`. A registered editor is the user's real browser tab and is the only browser surface the agent should use.

- If an editor is listed, use the MCP tools against it. Do not open CarouselBot or click **Connect AI** with browser automation.
- Sandboxed, remote, and agent-controlled browser sessions are separate from the user's local browser and usually cannot reach the local companion. Never use one to test or establish the connection.
- If no editor is listed, ask the user to open the editor in their normal browser on the same computer, click **Connect AI**, and accept the browser permission. Then retry `list_editors`.
- A loaded MCP server and a connected browser editor are different states. Determine browser connectivity only from `list_editors`, not from a sandbox browser or the agent's tool catalog.

Browser reconnection is automatic. After `EDITOR_DISCONNECTED`, `EDITOR_RELOADED`, a dropped browser request, or an empty `list_editors` result that follows a working connection, wait briefly and retry `list_editors` several times. Do not restart the companion for a transient browser disconnect: restarting invalidates every browser session and makes recovery slower. If the editor does not return, ask the user to keep or reload the real editor tab; preserve completed project work and begin a new edit session after it reconnects.

The MCP checks the shared daemon's actual internal capabilities before advertising tools. It automatically replaces an outdated daemon, keeps the MCP process alive, and lets the remembered browser connection reconnect. Do not ask the user to reload MCP or restart Hermes for daemon recovery.

If an advertised tool nevertheless returns `UNSUPPORTED_INTERNAL_ACTION` or `Unknown internal action`, stop after that first failure; do not fan out parallel retries that can trip the host's whole-server circuit breaker. Retry `list_editors` once so automatic recovery can finish, then retry the original tool once. If recovery itself reports that no compatible companion could start, run `npx -y carouselbot@latest doctor` and then `npx -y carouselbot@latest restart` once. Only ask the user to reload their real editor tab if it does not reconnect automatically. Never restart the companion for a transient browser disconnect.

If the native MCP tools are not registered in the current session, do not stop or ask for a restart. Use the same validated tools through the local CLI fallback:

```bash
npx -y carouselbot@latest call get_design_guidance
npx -y carouselbot@latest call list_editors
npx -y carouselbot@latest call list_tools --json '{"names":["create_project","move_project","add_slide","add_text"]}'
npx -y carouselbot@latest call create_project --json '{"name":"My presentation","folderPath":"/campaigns"}'
```

Every tool accepts the same JSON arguments as MCP. Use `list_tools` without arguments for compact discovery or pass `{"names":[...]}` to retrieve selected schemas. Prefer `apply_operations` for batches. `render_slide` writes its returned image to a temporary local `previewPath`; inspect that file and remove the temporary directory after the review. A daemon replacement never requires `/reload-mcp`. Hermes only needs `/reload-mcp` when a package update adds entirely new native tool names to an already-running agent session; use the CLI fallback immediately in that rare case. A newly installed skill becomes active in the next session or after `/reload-skills`, but correctness must never depend on the user doing that manually.

Before the first mutation in a task, call `get_design_guidance`. The server intentionally rejects mutations until this guidance has been read.

Before editing, reserve a target with `begin_edit_session`. Pass its `editSessionId` to every mutating tool, relevant reads, notifications, and `apply_operations`. Release it with `end_edit_session` as soon as the work finishes or fails. Reservations expire after inactivity, but explicit release is the normal cleanup path.

For parallel work, the parent agent owns orchestration:

1. Call `list_editors` and `list_edit_sessions` before spawning editing workers.
2. Reserve one distinct editor per editing worker with `begin_edit_session`, and assign one project per session. Never launch more editing workers than available unassigned editors. Research-only workers do not need a session.
3. Give each worker its exact `editorId`, `editSessionId`, and `projectId` (once known). A worker must never select or use another worker's editor.
4. If a worker creates a project, the daemon binds that new project to its session automatically. Report the returned `projectId` to the parent.
5. Treat `EDITOR_BUSY`, `PROJECT_BUSY`, and `SESSION_PROJECT_MISMATCH` as coordination signals. Do not retry against a different target silently. Re-plan, wait, or use another unassigned editor.
6. End every worker session in cleanup, including after errors. Use `list_recent_operations` to investigate routing, conflicts, or failed edits without exposing prompts, text, paths, or image bytes.

With only one agent and one editor, the server can create an implicit session for compatibility. Explicit sessions are still preferred because they make routing deterministic. Never rely on which tab is focused once multiple editors exist.

Inspect the assigned editor before editing and keep the returned IDs and revision. Work on the assigned project and slide. Pass `expectedRevision` for sensitive mutations. If `STALE_PROJECT` is returned, the browser has reloaded the canonical IndexedDB copy; inspect again and retry with current IDs. Prefer `apply_operations` for compact related changes while preserving logical order.

When the user asks for a font installed on their Mac, use the deterministic two-ID flow:

1. Call `list_local_fonts` with a family/style query and choose an exact face from its metadata. Never guess a CSS family or construct a `localFontId`.
2. Call `import_font` with that opaque `localFontId`. Keep the returned project-scoped `fontId`.
3. Pass the returned `fontId` to `add_text` or `update_text`. Import and application are separate calls for a newly selected face; do not invent a batch placeholder.
4. Render and inspect the result. Use `list_project_fonts` to reuse faces already embedded in the project.

If listing returns `FONT_PERMISSION_REQUIRED`, ask the user to open the real CarouselBot tab and choose **Allow local fonts** from the text font control, then retry. Do not bypass this with browser automation. Font paths and bytes are intentionally unavailable to agents. If rendering reports `FONT_UNAVAILABLE`, preserve the editable text, report the missing face, and ask the user to replace or re-import it rather than accepting fallback pixels.

Use `fontWeight` or `fontVariationSettings.wght` when varying an imported face. Preserve existing non-weight variable settings, but do not newly apply `wdth`, `opsz`, `slnt`, or custom axes until CarouselBot advertises exact exported-canvas parity for them.

All ordinary words must remain CarouselBot text layers, including words styled with a local font. Never generate or import a text-only PNG/SVG and place it as an image merely to imitate a font. If an exact face cannot be listed, imported, or rendered, keep the copy editable in an available face and tell the user what was substituted. Use image layers only for photographs, illustrations, logos, screenshots, and deliberate artwork that CarouselBot cannot represent as editable layers.

Choose a project's default canvas when creating it with the optional `aspectRatio`: `9:16` (default), `2:3`, `3:4`, `4:5`, `1:1`, `4:3`, or `16:9`. MCP callers may also use another validated positive `W:H` ratio when the reference requires it. Pass `aspectRatio` to `add_slide` when a new slide should differ from the project default, or to `update_slide` to change one existing slide while preserving its layers' proportions and relative centers. Mixed ratios should be a deliberate creative choice, not accidental inconsistency. For a flat slide, pass `backgroundColor` directly to `add_slide` or `update_slide`; never create or import a white or colored image just to fill the background. `backgroundColor` and `backgroundPath` are alternatives and must not be supplied together.

When `add_slide` uses `backgroundPath` without `aspectRatio`, CarouselBot derives the exact reduced ratio from the source image. Use that default for source-faithful image slides: the image scales to the 1080-pixel canvas width, any workspace space above or below is outside the slide, and export contains only the image-shaped slide canvas plus its editable layers. Supply `aspectRatio` with `backgroundPath` only when the user intentionally wants crop-to-format behavior. Native browser uploads follow the same source-ratio default, and the user can select another ratio afterward.

Dashboard folders are implicit and use exact canonical slash paths such as `/campaigns`. Set `folderPath` when calling `create_project` to create the project inside a folder. Call `move_project` with another slash path to move it between folders, or with `folderPath: null` to move it back to the dashboard root. Embedded slashes remain part of one virtual path rather than creating a nested UI hierarchy. Moving the final project out of a folder removes that empty folder automatically. Use `inspect_editor` to read each project's current `folderPath`.

Use readable role-based type ranges: title `92–124`, subtitle `68–84`, body `54–68`, caption `44–52`. Do not solve dense copy by dropping below the body range; shorten it or split it across slides. `add_text` and `update_text` automatically preserve width and fit height around every wrapped line with safe padding. For highlighted text, prefer `style: "boxed"` with `backgroundShape: "lines"`. Use `backgroundShape: "full"` only for a deliberate card. Call `fit_text_boxes` with `mode: "both"` only when you intentionally want the width to shrink too.

After each meaningful composition or after a short batch, call `render_slide` and inspect the returned image. Fix clipping, spacing, contrast, unsafe overlay placement, and weak hierarchy before claiming the slide is finished. Use `export_slide` or `export_project` only when local files are requested; do not overwrite existing files unless authorized.

Edits follow the latest changed slide only when their project is already visible. Creating or editing another project must not take over the user's current browser view. `open_project` and `set_view` intentionally navigate, so call them only when the user asks to see that project. Other tabs synchronize project cards and project state through local browser storage. Use `show_notification` only for short, useful status messages.
