import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  createElement: () => {
    const context = {
      fillStyle: null,
      fillRects: [],
      fillRect(...values) {
        this.fillRects.push(values);
      },
    };
    return {
      width: 0,
      height: 0,
      context,
      getContext: () => context,
    };
  },
};

const { renderSlideCanvas } = await import("../src/slide-renderer.mjs");
const { canonicalSolidBackgroundColor, solidBackgroundDataUrl } = await import("../src/slide-background.mjs");

test("renders each slide at its own format and scales an omitted height from that format", async () => {
  const project = { id: "project", aspectRatio: "9:16", assets: [], fonts: [], slides: [] };
  const slide = {
    id: "slide",
    aspectRatio: "4:3",
    backgroundColor: "#ABC",
    imageData: "",
    texts: [],
    overlays: [],
  };
  slide.imageData = solidBackgroundDataUrl(slide.backgroundColor, project, slide);
  project.slides.push(slide);

  assert.equal(canonicalSolidBackgroundColor(slide, project), "#AABBCC");
  const fullCanvas = await renderSlideCanvas(slide, undefined, undefined, project);
  assert.equal(fullCanvas.width, 1080);
  assert.equal(fullCanvas.height, 810);
  assert.equal(fullCanvas.context.fillStyle, "#AABBCC");
  assert.deepEqual(fullCanvas.context.fillRects, [[0, 0, 1080, 810]]);

  const previewCanvas = await renderSlideCanvas(slide, 270, undefined, project);
  assert.equal(previewCanvas.width, 270);
  assert.equal(previewCanvas.height, 203);
  assert.deepEqual(previewCanvas.context.fillRects, [[0, 0, 270, 203]]);
});

test("does not accept a project-sized solid payload for a differently sized slide", () => {
  const project = { aspectRatio: "9:16" };
  const slide = {
    aspectRatio: "1:1",
    backgroundColor: "#123456",
    imageData: solidBackgroundDataUrl("#123456", project),
  };

  assert.equal(canonicalSolidBackgroundColor(slide, project), null);
});
