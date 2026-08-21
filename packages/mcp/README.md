# Slide Studio MCP

Local-first MCP companion for the hosted [Slide Studio test editor](https://slides-mcp-poc-0821.pages.dev). It exposes complete project, slide, text, image, layer, history, rendering, and export controls to any stdio MCP client while the editor remains in the browser.

```bash
npx @alexgusevski/slide-studio-mcp@latest setup
```

The companion binds only to `127.0.0.1`. There is no hosted relay: projects remain in browser IndexedDB and local images remain on the user's computer.

Any MCP client can launch it with:

```bash
npx -y @alexgusevski/slide-studio-mcp@latest serve
```

Useful commands:

```bash
npx @alexgusevski/slide-studio-mcp@latest setup --dry-run
npx @alexgusevski/slide-studio-mcp@latest doctor
```

Open the test editor, click **Connect AI**, and call `get_design_guidance` before editing. The server enforces that one-time read and provides `render_slide` so agents can inspect actual pixels without permanently storing previews.
