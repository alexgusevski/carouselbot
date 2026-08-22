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

If the native MCP tools are not registered in the current session, do not stop or ask for a restart. Use the same validated tools through the local CLI fallback:

```bash
npx -y slides-studio-mcp@beta call get_design_guidance
npx -y slides-studio-mcp@beta call list_editors
npx -y slides-studio-mcp@beta call list_tools --json '{"names":["add_slide","add_text"]}'
npx -y slides-studio-mcp@beta call create_project --json '{"name":"My presentation"}'
```

Every tool accepts the same JSON arguments as MCP. Use `list_tools` without arguments for compact discovery or pass `{"names":[...]}` to retrieve selected schemas. Prefer `apply_operations` for batches. `render_slide` writes its returned image to a temporary local `previewPath`; inspect that file and remove the temporary directory after the review. Hermes can load the native tools in place with `/reload-mcp` and refresh this skill with `/reload-skills`.

Before the first mutation in a task, call `get_design_guidance`. The server intentionally rejects mutations until this guidance has been read.

Inspect the editor before editing and keep the returned IDs. Work on the requested project and slide; do not infer targets when multiple editors or projects are ambiguous. Prefer `apply_operations` for compact related changes, while preserving logical edit order.

After each meaningful composition or after a short batch, call `render_slide` and inspect the returned image. Fix clipping, spacing, contrast, unsafe TikTok-overlay placement, and weak hierarchy before claiming the slide is finished. Use `export_slide` or `export_project` only when local files are requested; do not overwrite existing files unless authorized.

The browser automatically opens the latest slide changed by an agent. Use `show_notification` only for short, useful status messages.
