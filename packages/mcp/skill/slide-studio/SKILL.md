---
name: slide-studio
description: Create, edit, visually inspect, and export Slide Studio carousel slides through the local Slide Studio MCP companion.
---

# Slide Studio

Use the Slide Studio MCP tools for all presentation changes. The hosted browser editor is the live visual surface; local files and rendered images pass only through the local companion.

Before the first mutation in a task, call `get_design_guidance`. The server intentionally rejects mutations until this guidance has been read.

Inspect the editor before editing and keep the returned IDs. Work on the requested project and slide; do not infer targets when multiple editors or projects are ambiguous. Prefer `apply_operations` for compact related changes, while preserving logical edit order.

After each meaningful composition or after a short batch, call `render_slide` and inspect the returned image. Fix clipping, spacing, contrast, unsafe TikTok-overlay placement, and weak hierarchy before claiming the slide is finished. Use `export_slide` or `export_project` only when local files are requested; do not overwrite existing files unless authorized.

The browser automatically opens the latest slide changed by an agent. Use `show_notification` only for short, useful status messages.
