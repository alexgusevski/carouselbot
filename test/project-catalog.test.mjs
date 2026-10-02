import test from "node:test";
import assert from "node:assert/strict";
import { projectCatalogEntry, slideVideoDuration } from "../src/editor-model.mjs";

test("catalog retains navigation and inspection metadata without original media", () => {
  const project = { id: "p", revision: 9, name: "Photos", folderPath: "/Client/Account", shareSourceId: "shared",
    slides: [{ id: "s", imageData: "large-photo", videoData: "large-video", aspectRatio: "4:5", texts: [{ id: "t", text: "Keep me" }], overlays: [{ assetId: "a" }] }],
    assets: [{ id: "a", imageData: "large-overlay", videoData: "large-clip", width: 6000, height: 4000, duration: 12 }],
    fonts: [{ id: "f", fontData: "large-font", fingerprint: "exact-face" }] };
  const before = structuredClone(project);
  const catalog = projectCatalogEntry(project);
  assert.equal(catalog.__catalog, true);
  assert.equal(catalog.folderPath, "/Client/Account");
  assert.equal(catalog.shareSourceId, "shared");
  assert.equal(catalog.slides[0].texts[0].text, "Keep me");
  assert.equal(catalog.assets[0].width, 6000);
  assert.equal(catalog.assets[0].duration, 12);
  assert.equal(slideVideoDuration(catalog.slides[0], catalog), 12);
  assert.equal(catalog.fonts[0].__hasFontData, true);
  assert.equal(catalog.fonts[0].fingerprint, "exact-face");
  assert.doesNotMatch(JSON.stringify(catalog), /large-/);
  assert.deepEqual(project, before);
  assert.deepEqual(projectCatalogEntry(catalog), catalog);
});

test("legacy catalog entries have safe empty collections and canonical folders", () => {
  assert.deepEqual(projectCatalogEntry({ id: "legacy" }), {
    id: "legacy", __catalog: true, folderPath: null, slides: [], assets: [], fonts: [],
  });
});

test("catalog backfill tolerates malformed optional legacy collections without touching originals", () => {
  const legacy = { id: "old", slides: [{ id: "s", texts: {}, overlays: null }], assets: {}, fonts: [null, "invalid"] };
  const before = structuredClone(legacy);
  const catalog = projectCatalogEntry(legacy);
  assert.deepEqual(catalog.assets, []);
  assert.deepEqual(catalog.fonts, []);
  assert.deepEqual(catalog.slides[0].texts, []);
  assert.deepEqual(catalog.slides[0].overlays, []);
  assert.deepEqual(legacy, before);
});
