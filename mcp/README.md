# Local MCP ↔ Cloudflare Pages proof

This branch proves that a local stdio MCP server can edit the browser-only Slide Studio app while the editor is loaded from a public Cloudflare Pages domain.

Test deployment: <https://slides-mcp-poc-0821.pages.dev>

The proof has no hosted API. The agent starts `mcp/server.mjs` over stdio, that process binds an HTTP bridge to `127.0.0.1:43117`, and the Pages tab long-polls the loopback bridge. Project and image state remain in the browser's IndexedDB.

## Run the proof

1. Configure the local MCP server in an MCP client. For example, with Claude Code:

   ```bash
   claude mcp add slide-studio-poc -- node /absolute/path/to/mcp/server.mjs
   ```

2. Open the test deployment and grant the browser's local/loopback network permission.
3. Ask the agent to call `create_demo_slide`, `add_text`, and `get_editor_state`.

Available proof tools:

- `list_editors`
- `get_editor_state`
- `create_demo_slide`
- `add_text`

## Automated checks

```bash
npm run test:mcp:poc
npm run test:mcp:browser
```

The browser test launches Chrome against the deployed Pages URL, grants the test profile's loopback permission, creates a real slide through MCP, adds a real text layer, and reads the resulting state back from the deployed tab.

## Proof-only limitations

- The browser tab must be open.
- The bridge uses one fixed local port and supports one owning MCP process. A publishable package should use a shared daemon or forward secondary stdio processes to the current port owner.
- Chrome presents a local-network permission. Safari and Firefox still need a manual compatibility matrix.
- Only an exact origin allowlist can connect, and the listener binds only to `127.0.0.1`.
- This is deliberately not deployed to the live `slides-editor` Pages project.
