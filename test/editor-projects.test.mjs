import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({}),
};

const { normalizeLoadedProjects } = await import("../src/editor-projects.mjs");
const { projectChannel } = await import("../src/project-store.mjs");

test.after(() => projectChannel?.close());

test("normalizes legacy projects in place without replacing existing records", () => {
  const text = { id: "text-1", text: "Legacy text", style: "plain" };
  const slide = {
    id: "slide-1",
    width: 1080,
    height: 1920,
    imageScale: null,
    imageX: undefined,
    imageY: null,
    texts: [text],
  };
  const project = { id: "project-1", revision: "invalid", slides: [slide] };
  const projects = [project];

  const result = normalizeLoadedProjects(projects);

  assert.equal(result, projects);
  assert.equal(result[0], project);
  assert.equal(result[0].slides[0], slide);
  assert.equal(result[0].slides[0].texts[0], text);
  assert.equal(project.revision, 0);
  assert.deepEqual(project.assets, []);
  assert.equal(slide.imageScale, 1);
  assert.equal(slide.imageX, 0);
  assert.equal(slide.imageY, 0);
  assert.deepEqual(slide.overlays, []);
});

test("derives cropped overlay height and missing layer order from legacy assets", () => {
  const firstOverlay = {
    id: "overlay-1",
    assetId: "asset-1",
    width: 0.4,
    cropX: 0.1,
    cropY: 0.2,
    cropW: 0.5,
    cropH: 0.25,
  };
  const secondOverlay = {
    id: "overlay-2",
    assetId: "asset-1",
    width: 0.7,
    height: 0.6,
    z: 12,
  };
  const missingAssetOverlay = { id: "overlay-3", assetId: "missing", width: 0.2 };
  const projects = [{
    id: "project-1",
    revision: 2,
    assets: [{ id: "asset-1", width: 800, height: 400 }],
    slides: [{
      id: "slide-1",
      imageScale: 1,
      imageX: 0,
      imageY: 0,
      overlays: [firstOverlay, secondOverlay, missingAssetOverlay],
      texts: [],
    }],
  }];

  normalizeLoadedProjects(projects);

  assert.ok(Math.abs(firstOverlay.height - 0.05625) < Number.EPSILON);
  assert.equal(firstOverlay.z, 1);
  assert.equal(secondOverlay.height, 0.6);
  assert.equal(secondOverlay.z, 12);
  assert.equal(missingAssetOverlay.height, undefined);
  assert.equal(missingAssetOverlay.z, 3);
});

test("restores every legacy text default while preserving valid values", () => {
  const legacyPlain = {
    id: "text-1",
    text: "Plain",
    style: "plain",
    color: "not-a-color",
  };
  const legacyBoxed = {
    id: "text-2",
    text: "Boxed",
    style: "boxed",
    background: "black",
    color: null,
  };
  const current = {
    id: "text-3",
    text: "Current",
    style: "plain",
    outlineWidth: 4,
    color: "#AABBCC",
    background: "black",
    backgroundShape: "lines",
    align: "right",
    rotation: 25,
    z: 40,
  };
  const projects = [{
    id: "project-1",
    revision: "7",
    assets: [],
    slides: [{
      id: "slide-1",
      imageScale: 0,
      imageX: 0,
      imageY: 0,
      overlays: [{ id: "overlay-1", z: 8 }],
      texts: [legacyPlain, legacyBoxed, current],
    }],
  }];

  normalizeLoadedProjects(projects);

  assert.equal(projects[0].revision, "7");
  assert.deepEqual(legacyPlain, {
    id: "text-1",
    text: "Plain",
    style: "plain",
    color: "#FFFFFF",
    outlineWidth: 12,
    background: "white",
    backgroundShape: "full",
    align: "center",
    rotation: 0,
    z: 2,
  });
  assert.equal(legacyBoxed.color, "#FFFFFF");
  assert.equal(legacyBoxed.outlineWidth, 12);
  assert.equal(legacyBoxed.background, "black");
  assert.equal(legacyBoxed.backgroundShape, "full");
  assert.equal(legacyBoxed.align, "center");
  assert.equal(legacyBoxed.rotation, 0);
  assert.equal(legacyBoxed.z, 3);
  assert.deepEqual(current, {
    id: "text-3",
    text: "Current",
    style: "plain",
    outlineWidth: 4,
    color: "#AABBCC",
    background: "black",
    backgroundShape: "lines",
    align: "right",
    rotation: 25,
    z: 40,
  });
  assert.equal(projects[0].slides[0].imageScale, 0);
});

test("adds empty overlay and text collections without changing current photo fields", () => {
  const slide = {
    id: "slide-1",
    imageScale: 2.25,
    imageX: -0.2,
    imageY: 0.3,
  };
  const projects = [{ id: "project-1", revision: null, assets: [], slides: [slide] }];

  normalizeLoadedProjects(projects);

  assert.equal(projects[0].revision, null);
  assert.equal(slide.imageScale, 2.25);
  assert.equal(slide.imageX, -0.2);
  assert.equal(slide.imageY, 0.3);
  assert.deepEqual(slide.overlays, []);
  assert.deepEqual(slide.texts, []);
});
