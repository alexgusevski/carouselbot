import test from "node:test";
import assert from "node:assert/strict";
import { isVideoFile, slideVideoDuration } from "../src/editor-model.mjs";

test("video imports accept MIME and common file extensions", () => {
  assert.equal(isVideoFile({ type: "video/mp4" }), true);
  assert.equal(isVideoFile({ type: "", name: "walkthrough.MOV" }), true);
  assert.equal(isVideoFile({ type: "image/png", name: "photo.png" }), false);
  assert.equal(isVideoFile(null), false);
});

test("video slide duration follows the longest placed clip and falls back to photo mode", () => {
  const project = { assets: [{ id: "a", videoData: "data:a", duration: 10 }, { id: "b", videoData: "data:b", duration: 4 }, { id: "unused", videoData: "data:c", duration: 90 }] };
  const slide = { overlays: [{ assetId: "a" }, { assetId: "b" }] };
  assert.equal(slideVideoDuration(slide, project), 10);
  slide.overlays.shift();
  assert.equal(slideVideoDuration(slide, project), 4);
  slide.overlays = [];
  assert.equal(slideVideoDuration(slide, project), 0);
  assert.equal(slideVideoDuration({ videoData: "data:v", duration: 12 }, project), 12);
  assert.equal(slideVideoDuration({ videoData: "data:v", duration: Infinity }, project), 0);
  assert.equal(slideVideoDuration(null, project), 0);
});
