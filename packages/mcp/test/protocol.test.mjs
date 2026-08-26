import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = new URL("../../..", import.meta.url);
const cli = new URL("../src/cli.mjs", import.meta.url);

function createRpc(child) {
  let input = "";
  let id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    input += chunk;
    let newline;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return {
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
    request(method, params = {}, timeout = 10_000) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
        pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
  };
}

async function withServer(callback) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-test-"));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, CAROUSELBOT_BRIDGE_PORT: String(port), CAROUSELBOT_STATE_DIR: stateDirectory };
  const child = spawn(process.execPath, [cli.pathname, "serve"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const rpc = createRpc(child);
  try {
    await callback({ rpc, port, stateDirectory, errors: () => errors });
  } finally {
    child.stdin.end();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    const state = await readFile(join(stateDirectory, `daemon-${port}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (state?.pid) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

test("serves a complete legacy-compatible stdio MCP surface", async () => {
  await withServer(async ({ rpc, errors }) => {
    const initialized = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "protocol-test", version: "1" } });
    assert.equal(initialized.result.serverInfo.name, "carouselbot");
    rpc.notify("notifications/initialized");

    const listed = await rpc.request("tools/list");
    const names = listed.result.tools.map((tool) => tool.name);
    for (const name of ["get_design_guidance", "list_editors", "begin_edit_session", "end_edit_session", "list_edit_sessions", "list_recent_operations", "inspect_editor", "create_project", "add_slide", "add_text", "fit_text_boxes", "import_asset", "add_image", "render_slide", "export_project", "apply_operations"]) assert.ok(names.includes(name), `missing ${name}`);
    assert.ok(names.length >= 30, `expected complete surface, received ${names.length}`);
    assert.ok(listed.result.tools.every((tool) => tool.annotations.openWorldHint === false), "every tool should declare its closed local domain");
    const annotations = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool.annotations]));
    assert.equal(annotations.inspect_editor.readOnlyHint, true);
    assert.equal(annotations.add_text.destructiveHint, false);
    assert.equal(annotations.update_text.destructiveHint, true);
    assert.equal(annotations.delete_project.destructiveHint, true);

    const blocked = await rpc.request("tools/call", { name: "create_project", arguments: { name: "Blocked until guidance" } });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /get_design_guidance/);

    const guidance = await rpc.request("tools/call", { name: "get_design_guidance", arguments: {} });
    assert.match(guidance.result.content[0].text, /Treat per-line boxes as the default/);
    assert.match(guidance.result.content[0].text, /fit_text_boxes/);
    assert.match(guidance.result.content[0].text, /automatically preserve width and fit height/);
    assert.match(guidance.result.content[0].text, /body copy `54–68`/);

    const editors = await rpc.request("tools/call", { name: "list_editors", arguments: {} });
    assert.deepEqual(editors.result.structuredContent.editors, []);

    const noBrowser = await rpc.request("tools/call", { name: "create_project", arguments: { name: "No browser" } });
    assert.equal(noBrowser.result.isError, true);
    assert.match(noBrowser.result.content[0].text, /No CarouselBot editor is connected/);
    assert.doesNotMatch(errors(), /Invalid JSON-RPC|stdout/i);
  });
});

test("protects internal routes, origins, and protocol versions", async () => {
  await withServer(async ({ rpc, port, stateDirectory }) => {
    await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "security-test", version: "1" } });
    rpc.notify("notifications/initialized");
    const statePath = join(stateDirectory, `daemon-${port}.json`);
    let state = null;
    for (let index = 0; index < 40 && !state; index += 1) {
      state = await readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
      if (!state) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(state?.secret);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/internal/health`)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: "https://attacker.example" } })).status, 403);
    const preflight = await fetch(`${base}/health`, { method: "OPTIONS", headers: { Origin: "https://carousel.bot", "Access-Control-Request-Private-Network": "true" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    const mismatch = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { Origin: "https://carousel.bot", "Content-Type": "application/json" },
      body: JSON.stringify({ editorId: "test-editor", protocolVersion: 999 }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await fetch(`${base}/health`, { headers: { Origin: "https://slides-editor.pages.dev" } })).status, 200);
  });
});
