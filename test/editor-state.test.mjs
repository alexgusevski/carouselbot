import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null };

const {
  activeProject,
  activeSlide,
  constrainImagePosition,
  constrainOverlay,
  getOverlayMetrics,
  isLayerSelected,
  projectAsset,
  selectedLayers,
  selectedOverlay,
  selectedText,
  selectOnlyLayer,
  setLayerSelection,
  slideThumbnailKey,
  state,
  toggleLayerSelection,
} = await import("../src/editor-state.mjs");

function resetState() {
  state.projects = [];
  state.activeProjectId = null;
  state.activeSlideId = null;
  state.selectedTextId = null;
  state.selectedOverlayId = null;
  state.selectedLayerKeys = [];
  state.croppingOverlayId = null;
  state.stageWidth = 0;
  state.stageHeight = 0;
}

function installProject() {
  const project = {
    id: "project-1",
    assets: [{ id: "asset-1", width: 800, height: 600 }],
    slides: [{
      id: "slide-1",
      width: 1000,
      height: 1000,
      imageScale: 1,
      imageX: 0,
      imageY: 0,
      texts: [{ id: "text-1", z: 1 }],
      overlays: [{ id: "overlay-1", assetId: "asset-1", x: 0.1, y: 0.2, width: 0.4, z: 2 }],
    }],
  };
  state.projects = [project];
  state.activeProjectId = project.id;
  state.activeSlideId = project.slides[0].id;
  return project;
}

test.beforeEach(resetState);

test("scopes rendered slide thumbnails to their owning project", () => {
  assert.notEqual(slideThumbnailKey("project-1", "shared-slide"), slideThumbnailKey("project-2", "shared-slide"));
  assert.equal(slideThumbnailKey("project-1", "shared-slide"), slideThumbnailKey("project-1", "shared-slide"));
});

test("resolves the active project, slide, asset, and selected layers", () => {
  installProject();
  setLayerSelection(["text:text-1", "overlay:overlay-1"]);
  assert.equal(activeProject().id, "project-1");
  assert.equal(activeSlide().id, "slide-1");
  assert.equal(projectAsset("asset-1").width, 800);
  assert.equal(selectedText(), null);
  assert.equal(selectedOverlay().id, "overlay-1");
  assert.deepEqual(selectedLayers().map(({ kind, item }) => `${kind}:${item.id}`), ["text:text-1", "overlay:overlay-1"]);
});

test("filters duplicate, missing, and malformed selection keys", () => {
  installProject();
  setLayerSelection(["text:text-1", "text:text-1", "overlay:missing", "bad"], "text:text-1");
  assert.deepEqual(state.selectedLayerKeys, ["text:text-1"]);
  assert.equal(state.selectedTextId, "text-1");
  assert.equal(state.selectedOverlayId, null);
});

test("selects one layer and toggles additive selection", () => {
  installProject();
  selectOnlyLayer("text", "text-1");
  assert.equal(isLayerSelected("text", "text-1"), true);
  toggleLayerSelection("overlay", "overlay-1");
  assert.deepEqual(state.selectedLayerKeys, ["text:text-1", "overlay:overlay-1"]);
  assert.equal(state.selectedOverlayId, "overlay-1");
  toggleLayerSelection("overlay", "overlay-1");
  assert.deepEqual(state.selectedLayerKeys, ["text:text-1"]);
  assert.equal(state.selectedTextId, "text-1");
});

test("uses cropped aspect ratio outside crop mode", () => {
  installProject();
  const overlay = { id: "overlay-1", assetId: "asset-1", width: 0.4, cropX: 0, cropY: 0, cropW: 0.5, cropH: 1 };
  const asset = projectAsset("asset-1");
  const cropped = getOverlayMetrics(overlay, asset);
  state.croppingOverlayId = overlay.id;
  const full = getOverlayMetrics(overlay, asset);
  assert.equal(cropped.width, 0.4);
  assert.equal(cropped.height, 0.3375);
  assert.equal(full.height, 0.16875);
  assert.deepEqual(getOverlayMetrics(overlay, asset, { full: true }), full);
});

test("preserves an explicit overlay height while normalizing dimensions and rotation", () => {
  installProject();
  const overlay = { assetId: "asset-1", width: 99, height: 0.5, rotation: -45 };
  constrainOverlay(overlay, projectAsset("asset-1"));
  assert.equal(overlay.width, 2.4);
  assert.equal(overlay.height, 0.5);
  assert.equal(overlay.rotation, 315);
});

test("derives and clamps a missing overlay height", () => {
  installProject();
  const overlay = { assetId: "asset-1", width: 0.4, height: 0, cropW: 1, cropH: 1 };
  constrainOverlay(overlay, projectAsset("asset-1"));
  assert.equal(overlay.height, 0.16875);
});

test("derives overlay geometry from the owning slide rather than the project default", () => {
  const project = installProject();
  project.aspectRatio = "9:16";
  const slide = project.slides[0];
  slide.aspectRatio = "1:1";
  const asset = projectAsset("asset-1");
  const measured = getOverlayMetrics(
    { id: "measured", assetId: asset.id, width: 0.4 },
    asset,
    { project, slide },
  );
  assert.ok(Math.abs(measured.height - 0.3) < Number.EPSILON);

  const constrained = { id: "constrained", assetId: asset.id, width: 0.4, height: 0 };
  constrainOverlay(constrained, asset, { project, slide });
  assert.ok(Math.abs(constrained.height - 0.3) < Number.EPSILON);
});

test("clamps photo pan to the visible cover-image range", () => {
  const project = installProject();
  const slide = project.slides[0];
  state.stageWidth = 540;
  state.stageHeight = 960;
  slide.imageX = 5;
  slide.imageY = -5;
  constrainImagePosition(slide);
  assert.equal(slide.imageX, 7 / 18);
  assert.equal(Math.abs(slide.imageY), 0);
});

test("constrains the active background image against its slide-specific format", () => {
  const project = installProject();
  project.aspectRatio = "9:16";
  const slide = project.slides[0];
  slide.aspectRatio = "1:1";
  state.stageWidth = 540;
  state.stageHeight = 540;
  slide.imageX = 5;
  slide.imageY = -5;

  constrainImagePosition(slide, project);

  assert.equal(Math.abs(slide.imageX), 0);
  assert.equal(Math.abs(slide.imageY), 0);
});

test("does not constrain a non-active project with the visible project's stage ratio", () => {
  installProject();
  state.stageWidth = 540;
  state.stageHeight = 960;
  const project = {
    id: "project-3x4",
    aspectRatio: "3:4",
  };
  const slide = {
    width: 1000,
    height: 1000,
    imageScale: 1,
    imageX: 5,
    imageY: -5,
  };

  constrainImagePosition(slide, project);

  assert.ok(Math.abs(slide.imageX - (1 / 6)) < Number.EPSILON);
  assert.equal(Math.abs(slide.imageY), 0);
});

test("ignores stale stage dimensions whose ratio does not match the active project", () => {
  const project = installProject();
  project.aspectRatio = "3:4";
  state.stageWidth = 540;
  state.stageHeight = 960;
  const slide = project.slides[0];
  slide.imageX = 5;
  slide.imageY = -5;

  constrainImagePosition(slide, project);

  assert.ok(Math.abs(slide.imageX - (1 / 6)) < Number.EPSILON);
  assert.equal(Math.abs(slide.imageY), 0);
});

test("returns null selectors when no project is active", () => {
  assert.equal(activeProject(), null);
  assert.equal(activeSlide(), null);
  assert.equal(selectedText(), null);
  assert.equal(selectedOverlay(), null);
  assert.deepEqual(selectedLayers(), []);
});
