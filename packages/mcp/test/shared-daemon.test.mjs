import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shares one daemon while preserving per-agent editor selection", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "slide-studio-shared-"));
  const port = 45000 + Math.floor(Math.random() * 1000);
  process.env.SLIDE_STUDIO_STATE_DIR = stateDirectory;
  process.env.SLIDE_STUDIO_BRIDGE_PORT = String(port);
  const { createCompanion } = await import(`../src/companion.mjs?shared=${port}`);
  const first = await createCompanion("Claude Code", "test");
  const second = await createCompanion("Codex", "test");
  const origin = "https://slides-mcp-poc-0821.pages.dev";
  const base = `http://127.0.0.1:${port}`;

  async function connect(editorId) {
    const response = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ editorId, protocolVersion: 1, pageUrl: `${origin}/#${editorId}`, state: { activeProjectId: null } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const editorA = await connect("editor-a");
  const editorB = await connect("editor-b");
  try {
    assert.equal(first.daemon.pid, second.daemon.pid);
    assert.equal((await first.call("list_editors")).editors.length, 2);
    await first.call("select_editor", { editorId: "editor-a" });
    await second.call("select_editor", { editorId: "editor-b" });
    const firstEditors = await first.call("list_editors");
    const secondEditors = await second.call("list_editors");
    assert.equal(firstEditors.selectedEditorId, "editor-a");
    assert.equal(firstEditors.editors.find((editor) => editor.id === "editor-a").selected, true);
    assert.equal(secondEditors.selectedEditorId, "editor-b");
    assert.equal(secondEditors.editors.find((editor) => editor.id === "editor-b").selected, true);

    await first.call("notify", { message: "From Claude", tone: "success" });
    await second.call("notify", { message: "From Codex", tone: "info" });
    const eventA = await fetch(`${base}/events?editorId=editor-a`, { headers: { Origin: origin, Authorization: `Bearer ${editorA.sessionToken}` } }).then((response) => response.json());
    const eventB = await fetch(`${base}/events?editorId=editor-b`, { headers: { Origin: origin, Authorization: `Bearer ${editorB.sessionToken}` } }).then((response) => response.json());
    assert.equal(eventA.message, "From Claude");
    assert.equal(eventA.agent.name, "Claude Code");
    assert.equal(eventB.message, "From Codex");
    assert.equal(eventB.agent.name, "Codex");
  } finally {
    await first.close();
    await second.close();
    const state = await readFile(join(stateDirectory, `daemon-${port}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (state?.pid) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await rm(stateDirectory, { recursive: true, force: true });
    delete process.env.SLIDE_STUDIO_STATE_DIR;
    delete process.env.SLIDE_STUDIO_BRIDGE_PORT;
  }
});
