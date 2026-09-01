import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = new URL("./fixtures/legacy-daemon.mjs", import.meta.url);

async function waitForState(path) {
  for (let index = 0; index < 100; index += 1) {
    const state = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
    if (state?.secret) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Legacy daemon did not start.");
}

test("replaces a same-protocol daemon that lacks the current internal actions", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-compat-"));
  const port = 46000 + Math.floor(Math.random() * 1000);
  const statePath = join(stateDirectory, `daemon-${port}.json`);
  process.env.CAROUSELBOT_STATE_DIR = stateDirectory;
  process.env.CAROUSELBOT_BRIDGE_PORT = String(port);
  const legacy = spawn(process.execPath, [fixture.pathname], { env: process.env, stdio: "ignore" });
  const legacyState = await waitForState(statePath);
  let companion = null;
  try {
    const module = await import(`../src/companion.mjs?compat=${port}`);
    companion = await module.createCompanion("Hermes", "test");
    assert.notEqual(companion.daemon.pid, legacyState.pid);
    assert.notEqual(companion.daemon.version, "0.2.0");
    assert.ok(companion.daemon.capabilities.internalActions.includes("list_local_fonts"));
    assert.deepEqual((await companion.call("list_editors")).editors, []);
  } finally {
    await companion?.close();
    const current = await readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (current?.pid) try { process.kill(current.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    try { legacy.kill("SIGTERM"); } catch { /* Already stopped. */ }
    await rm(stateDirectory, { recursive: true, force: true });
    delete process.env.CAROUSELBOT_STATE_DIR;
    delete process.env.CAROUSELBOT_BRIDGE_PORT;
  }
});

