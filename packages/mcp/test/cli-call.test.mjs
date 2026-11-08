import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("calls the validated MCP tool surface from the CLI without a client restart", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-call-"));
  const port = 47000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, CAROUSELBOT_STATE_DIR: stateDirectory, CAROUSELBOT_BRIDGE_PORT: String(port) };
  try {
    const { stdout } = await execute(process.execPath, [cli, "call", "list_editors"], { env, timeout: 15_000 });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.editors, []);
    assert.equal(result.selectedEditorId, null);
    const guidance = JSON.parse((await execute(process.execPath, [cli, "call", "get_design_guidance"], { env, timeout: 15_000 })).stdout);
    assert.match(guidance.guidance, /Text-box clipping checklist/);
    const tools = JSON.parse((await execute(process.execPath, [cli, "call", "list_tools", "--json", '{"names":["add_slide"]}'], { env, timeout: 15_000 })).stdout);
    assert.equal(tools.tools[0].name, "add_slide");
    assert.ok(tools.tools[0].inputSchema.properties.projectId);
  } finally {
    const state = await readFile(join(stateDirectory, `daemon-${port}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (state?.pid) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("caps --stdin input before buffering an oversized tool call", async () => {
  const { Readable } = await import("node:stream");
  const { readStdinText, MAX_STDIN_BYTES } = await import("../src/call.mjs");
  assert.equal(MAX_STDIN_BYTES, 144 * 1024 * 1024);
  assert.equal(await readStdinText(Readable.from([Buffer.from(' {"a":'), Buffer.from('"é"} ')]), 64), '{"a":"é"}');
  await assert.rejects(readStdinText(Readable.from([Buffer.alloc(40), Buffer.alloc(40)]), 64), /exceeds 64 bytes/);
});
