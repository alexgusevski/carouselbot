---
name: slide-studio
description: Create, edit, visually inspect, and export Slide Studio carousel slides through the local Slide Studio MCP companion.
---

# Slide Studio

Use the Slide Studio MCP tools for all presentation changes. The hosted browser editor is the live visual surface; local files and rendered images pass only through the local companion.

Before using any browser or making edits, call `list_editors`. A registered editor is the user's real browser tab and is the only browser surface the agent should use.

- If an editor is listed, use the MCP tools against it. Do not open Slide Studio or click **Connect AI** with browser automation.
- Sandboxed, remote, and agent-controlled browser sessions are separate from the user's local browser and usually cannot reach the local companion. Never use one to test or establish the connection.
- If no editor is listed, ask the user to open the editor in their normal browser on the same computer, click **Connect AI**, and accept the browser permission. Then retry `list_editors`.
- A loaded MCP server and a connected browser editor are different states. Determine browser connectivity only from `list_editors`, not from a sandbox browser or the agent's tool catalog.

If the MCP reports an outdated companion protocol, run `npx -y slides-studio-mcp@beta restart` once, ask the user to reload their real editor tab, and retry `list_editors`.

If the native MCP tools are not registered in the current session, do not stop or ask for a restart. Use the same validated tools through the local CLI fallback:

```bash
npx -y slides-studio-mcp@beta call get_design_guidance
npx -y slides-studio-mcp@beta call list_editors
npx -y slides-studio-mcp@beta call list_tools --json '{"names":["add_slide","add_text"]}'
npx -y slides-studio-mcp@beta call create_project --json '{"name":"My presentation"}'
```

Every tool accepts the same JSON arguments as MCP. Use `list_tools` without arguments for compact discovery or pass `{"names":[...]}` to retrieve selected schemas. Prefer `apply_operations` for batches. `render_slide` writes its returned image to a temporary local `previewPath`; inspect that file and remove the temporary directory after the review. Hermes can load the native tools in place with `/reload-mcp` and refresh this skill with `/reload-skills`.

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

After each meaningful composition or after a short batch, call `render_slide` and inspect the returned image. Fix clipping, spacing, contrast, unsafe TikTok-overlay placement, and weak hierarchy before claiming the slide is finished. Use `export_slide` or `export_project` only when local files are requested; do not overwrite existing files unless authorized.

Each assigned browser tab automatically opens the latest slide changed through its session. Other tabs synchronize project cards and project state through local browser storage. Use `show_notification` only for short, useful status messages.
