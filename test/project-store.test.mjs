import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null };

const {
  DB_VERSION,
  PROJECT_CHANNEL_NAME,
  PROJECT_SYNC_STORAGE_KEY,
  STORE_NAME,
  projectChannel,
  staleProjectError,
} = await import("../src/project-store.mjs");

test.after(() => projectChannel?.close());

test("keeps stable browser-storage protocol identifiers", () => {
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, "projects");
  assert.equal(PROJECT_CHANNEL_NAME, "carouselbot-projects-v1");
  assert.equal(PROJECT_SYNC_STORAGE_KEY, "carouselbot:project-change");
});

test("describes stale writes with machine-readable revision details", () => {
  const error = staleProjectError("project-1", 4, 7);
  assert.equal(error.name, "Error");
  assert.equal(error.code, "STALE_PROJECT");
  assert.equal(error.expectedRevision, 4);
  assert.equal(error.actualRevision, 7);
  assert.match(error.message, /expected revision 4, current 7/);
});
