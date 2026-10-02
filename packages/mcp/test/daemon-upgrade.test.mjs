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

test("setup-style upgrades keep an already-running MCP client usable", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-upgrade-"));
  const port = 47000 + Math.floor(Math.random() * 1000);
  const statePath = join(stateDirectory, `daemon-${port}.json`);
  process.env.CAROUSELBOT_STATE_DIR = stateDirectory;
  process.env.CAROUSELBOT_BRIDGE_PORT = String(port);
  const legacy = spawn(process.execPath, [fixture.pathname], {
    env: { ...process.env, CAROUSELBOT_TEST_LEGACY_CAPABILITIES: "compatible" },
    stdio: "ignore",
  });
  const legacyState = await waitForState(statePath);
  let companion = null;
  try {
    const module = await import(`../src/companion.mjs?upgrade=${port}`);
    companion = await module.createCompanion("Hermes", "test");
    assert.equal(companion.daemon.pid, legacyState.pid, "compatible daemons should not restart during ordinary calls");
    const upgraded = await module.companionUpgrade();
    assert.equal(upgraded.upgraded, true);
    assert.notEqual(upgraded.pid, legacyState.pid);
    assert.deepEqual((await companion.call("list_editors")).editors, [], "the existing MCP process should reconnect without a host reload");
    assert.equal(companion.daemon.pid, upgraded.pid);
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
