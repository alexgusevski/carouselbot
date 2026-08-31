const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, normalizeConfig, validProject, migrationResult } = require("../domain-migration.js");

const config = {
  canonicalOrigin: "https://carousel.bot/path",
  legacyOrigins: ["https://slides-editor.pages.dev/", "not a URL"],
  migration: { projectTimeoutMs: 12_000 },
};

test("normalizes migration origins and rollout settings", () => {
  const normalized = normalizeConfig(config);
  assert.equal(normalized.canonicalOrigin, "https://carousel.bot");
  assert.deepEqual(normalized.legacyOrigins, ["https://slides-editor.pages.dev"]);
  assert.equal(normalized.projectTimeoutMs, 12_000);
  assert.equal(normalized.autoForwardEmptyLegacyStorage, false);
});

test("accepts project records and rejects malformed payloads", () => {
  assert.equal(validProject({ id: "project-1", name: "Launch", folderPath: "/launch", slides: [], assets: [] }), true);
  assert.equal(validProject({ id: "project-1", name: "Launch", slides: "nope" }), false);
  assert.equal(validProject({ id: "", name: "Launch", slides: [], assets: [] }), false);
});

test("never overwrites a newer project on the canonical origin", () => {
  const incoming = { id: "project-1", name: "Launch", slides: [], assets: [], updatedAt: 20, revision: 3 };
  assert.equal(migrationResult(null, incoming), "imported");
  assert.equal(migrationResult({ ...incoming, updatedAt: 10 }, incoming), "updated");
  assert.equal(migrationResult({ ...incoming, updatedAt: 30 }, incoming), "skipped");
  assert.equal(migrationResult({ ...incoming, revision: 4 }, incoming), "skipped");
  assert.equal(migrationResult({ ...incoming, revision: 2 }, incoming), "updated");
});

function linkedWindows() {
  const listeners = (origin) => new Map([["message", []], ["carouselbot:migration-complete", []]]);
  const storage = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  };
  const makeWindow = (origin) => ({
    location: { origin, href: `${origin}/`, replace() {} },
    localStorage: storage(),
    crypto: { randomUUID: () => "migration-token" },
    history: { replaceState() {} },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    closed: false,
    setTimeout,
    clearTimeout,
    focus() {},
    _listeners: listeners(origin),
    addEventListener(type, callback) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(callback); },
    dispatchEvent(event) { for (const callback of this._listeners.get(event.type) || []) callback(event); },
  });
  const legacy = makeWindow("https://slides-editor.pages.dev");
  const canonical = makeWindow("https://carousel.bot");
  legacy.open = (url) => { canonical.location.href = url; canonical.opener = legacy; return canonical; };
  canonical.postMessage = (data, targetOrigin) => {
    assert.equal(targetOrigin, canonical.location.origin);
    queueMicrotask(() => canonical.dispatchEvent({ type: "message", data, origin: legacy.location.origin, source: legacy }));
  };
  legacy.postMessage = (data, targetOrigin) => {
    assert.equal(targetOrigin, legacy.location.origin);
    queueMicrotask(() => legacy.dispatchEvent({ type: "message", data, origin: canonical.location.origin, source: canonical }));
  };
  return { legacy, canonical };
}

test("copies and acknowledges projects one at a time across configured origins", async () => {
  const { legacy, canonical } = linkedWindows();
  const rawConfig = { ...config, canonicalOrigin: "https://carousel.bot", migration: { projectTimeoutMs: 1_000 } };
  const legacyController = createController(legacy, rawConfig);
  const projects = [
    { id: "project-1", name: "One", folderPath: "/migration-folder", slides: [], assets: [], updatedAt: 1 },
    { id: "project-2", name: "Two", slides: [], assets: [], updatedAt: 2 },
  ];
  const progress = [];
  const transfer = legacyController.start(projects, { onProgress: (value) => progress.push(value.completed) });
  const canonicalController = createController(canonical, rawConfig);
  const received = [];
  canonicalController.registerImporter(async (project) => { received.push({ id: project.id, folderPath: project.folderPath || null }); return "imported"; });
  const summary = await transfer;
  assert.deepEqual(received, [
    { id: "project-1", folderPath: "/migration-folder" },
    { id: "project-2", folderPath: null },
  ]);
  assert.deepEqual(progress, [1, 2]);
  assert.equal(summary.projectCount, 2);
  assert.equal(legacyController.completedMigration().destination, "https://carousel.bot");
  assert.equal(legacyController.hasPendingProjects(projects), false);
  assert.equal(legacyController.hasPendingProjects([{ ...projects[0], updatedAt: 3 }, projects[1]]), true);
  assert.equal(legacyController.hasPendingProjects([...projects, { id: "project-3", name: "Three", slides: [], assets: [] }]), true);
});
