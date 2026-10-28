import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPairingStore, normalizePairingCode, createPairingCode, PAIRING_TTL_MS } from "../src/pairing.mjs";
import { secureStateDirectory } from "../src/state-directory.mjs";
import { allowedOrigins } from "../src/config.mjs";

const posix = process.platform !== "win32";

test("trusts only the production editor origins unless dev origins are opted in", () => {
  assert.deepEqual([...allowedOrigins({})], ["https://carousel.bot", "https://slides-editor.pages.dev"]);
  assert.deepEqual([...allowedOrigins({ CAROUSELBOT_DEV_ORIGINS: "1" })], [
    "https://carousel.bot", "https://slides-editor.pages.dev", "http://127.0.0.1:4173", "http://localhost:4173",
  ]);
  assert.deepEqual([...allowedOrigins({ CAROUSELBOT_DEV_ORIGINS: "true" })], ["https://carousel.bot", "https://slides-editor.pages.dev"]);
  assert.deepEqual([...allowedOrigins({ CAROUSELBOT_ALLOWED_ORIGINS: " http://127.0.0.1:5000 ,," })], ["http://127.0.0.1:5000"]);
});

test("pairing codes are short, unambiguous, and normalized", () => {
  for (let index = 0; index < 50; index++) assert.match(createPairingCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizePairingCode(" abcd efgh "), "ABCD-EFGH");
  assert.equal(normalizePairingCode("ABCD-EFG"), null);
  assert.equal(normalizePairingCode(null), null);
});

test("a browser is trusted only after approval, and only on its own origin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "carouselbot-pairing-"));
  let time = 1_000_000;
  try {
    const path = join(directory, "paired-browsers.json");
    const store = createPairingStore(path, { now: () => time });
    assert.equal(await store.isPaired("https://carousel.bot", null), false);
    const pending = store.request("editor-a", "https://carousel.bot");
    assert.equal(store.request("editor-a", "https://carousel.bot").code, pending.code, "polling keeps the same code");
    assert.equal(await store.complete("editor-a", "https://carousel.bot"), null, "no key before approval");
    assert.equal(store.approve("WRNG-CODE"), null);
    assert.equal(store.pendingCount(), 1);
    assert.deepEqual(store.approve(pending.code.toLowerCase()), { editorId: "editor-a", origin: "https://carousel.bot" });
    assert.equal(await store.complete("editor-a", "https://slides-editor.pages.dev"), null, "another origin cannot collect the key");
    const key = await store.complete("editor-a", "https://carousel.bot");
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await store.complete("editor-a", "https://carousel.bot"), null, "the key is handed out once");

    const saved = await readFile(path, "utf8");
    assert.doesNotMatch(saved, new RegExp(key), "only a hash of the key is stored");
    if (posix) assert.equal((await stat(path)).mode & 0o777, 0o600);

    const reloaded = createPairingStore(path, { now: () => time });
    assert.equal(await reloaded.isPaired("https://carousel.bot", key), true);
    assert.equal(await reloaded.isPaired("https://slides-editor.pages.dev", key), false);
    assert.equal(await reloaded.isPaired("https://carousel.bot", `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`), false);

    const expiring = reloaded.request("editor-b", "https://carousel.bot");
    time += PAIRING_TTL_MS + 1;
    assert.equal(reloaded.approve(expiring.code), null, "expired codes cannot be approved");

    assert.equal(await reloaded.forgetAll(), 1);
    assert.equal(await reloaded.isPaired("https://carousel.bot", key), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the state folder is owner-only on every start, even when it already exists", { skip: !posix }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "carouselbot-state-"));
  try {
    const legacy = join(parent, "SlideStudioMCP");
    await mkdir(legacy, { mode: 0o755 });
    await chmod(legacy, 0o755);
    await secureStateDirectory(legacy);
    assert.equal((await stat(legacy)).mode & 0o777, 0o700);
    const fresh = join(parent, "nested", "CarouselBot");
    await secureStateDirectory(fresh);
    assert.equal((await stat(fresh)).mode & 0o777, 0o700);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
