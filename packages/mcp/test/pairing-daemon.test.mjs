import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs in its own file: config.mjs reads the port and state folder at import.
const posix = process.platform !== "win32";

test("the daemon requires browser pairing and enforces folder permissions", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-pair-daemon-"));
  const port = 46000 + Math.floor(Math.random() * 1000);
  if (posix) await chmod(stateDirectory, 0o755);
  process.env.CAROUSELBOT_STATE_DIR = stateDirectory;
  process.env.CAROUSELBOT_BRIDGE_PORT = String(port);
  delete process.env.CAROUSELBOT_ALLOWED_ORIGINS;
  delete process.env.CAROUSELBOT_DEV_ORIGINS;
  const { createCompanion } = await import(`../src/companion.mjs?pairing=${port}`);
  const companion = await createCompanion("Pairing test", "1");
  const base = `http://127.0.0.1:${port}`;
  const connect = (origin, body) => fetch(`${base}/connect`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 3, state: {}, ...body }),
  });
  try {
    if (posix) assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700, "daemon start tightens an existing state folder");

    assert.equal((await connect("http://127.0.0.1:4173", { editorId: "dev", pairingSupported: true })).status, 403, "Vite's default port is not trusted by default");
    assert.equal((await connect("http://localhost:4173", { editorId: "dev", pairingSupported: true })).status, 403);

    const legacyEditor = await connect("https://carousel.bot", { editorId: "old-tab" });
    assert.equal(legacyEditor.status, 426, "an editor without pairing support gets no session");
    assert.equal((await legacyEditor.json()).sessionToken, undefined);

    const waiting = await connect("https://carousel.bot", { editorId: "tab-1", pairingSupported: true });
    assert.equal(waiting.status, 202);
    const { pairingCode, sessionToken } = await waiting.json();
    assert.equal(sessionToken, undefined);
    assert.match(pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal((await companion.call("list_editors")).pendingBrowserPairings, 1);
    assert.equal(JSON.stringify(await companion.call("list_editors")).includes(pairingCode), false, "agents never see the code");
    await assert.rejects(companion.call("pair_editor", { code: "AAAA-AAAA" }), /PAIRING_CODE_INVALID|No browser is waiting/);

    const approval = await companion.call("pair_editor", { code: pairingCode });
    assert.deepEqual(approval, { approved: true, origin: "https://carousel.bot", editorId: "tab-1" });
    const paired = await connect("https://carousel.bot", { editorId: "tab-1", pairingSupported: true });
    assert.equal(paired.status, 200);
    const { pairingKey, sessionToken: token } = await paired.json();
    assert.ok(pairingKey && token);

    const secondTab = await connect("https://carousel.bot", { editorId: "tab-2", pairingSupported: true, pairingKey });
    assert.equal(secondTab.status, 200, "a paired browser reconnects new tabs without a new code");
    assert.equal((await secondTab.json()).pairingKey, undefined, "the key is not re-sent");

    const otherOrigin = await connect("https://slides-editor.pages.dev", { editorId: "tab-3", pairingSupported: true, pairingKey });
    assert.equal(otherOrigin.status, 202, "a key is bound to the origin that received it");

    if (posix) assert.equal((await stat(join(stateDirectory, "paired-browsers.json"))).mode & 0o777, 0o600);

    assert.deepEqual(await companion.call("forget_paired_browsers"), { forgotten: 1 });
    assert.equal((await connect("https://carousel.bot", { editorId: "tab-4", pairingSupported: true, pairingKey })).status, 202);
  } finally {
    await companion.close();
    const state = await readFile(join(stateDirectory, `daemon-${port}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (state?.pid) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    delete process.env.CAROUSELBOT_STATE_DIR;
    delete process.env.CAROUSELBOT_BRIDGE_PORT;
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
