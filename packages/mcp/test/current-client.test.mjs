import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const root = dirname(dirname(dirname(dirname(cli))));

test("negotiates the current protocol through the official MCP v2 client", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "slide-studio-current-"));
  const port = 46000 + Math.floor(Math.random() * 1000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "serve"],
    cwd: root,
    env: Object.fromEntries(Object.entries({ ...process.env, SLIDE_STUDIO_STATE_DIR: stateDirectory, SLIDE_STUDIO_BRIDGE_PORT: String(port) }).filter(([, value]) => typeof value === "string")),
    stderr: "pipe",
  });
  const client = new Client({ name: "official-v2-test", version: "1" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "@alexgusevski/slide-studio-mcp");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "render_slide"));
    const guidance = await client.callTool({ name: "get_design_guidance", arguments: {} });
    assert.match(guidance.content[0].text, /Text-box clipping checklist/);
    const editors = await client.callTool({ name: "list_editors", arguments: {} });
    assert.deepEqual(editors.structuredContent.editors, []);
  } finally {
    await client.close().catch(() => {});
    const state = await readFile(join(stateDirectory, `daemon-${port}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (state?.pid) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
