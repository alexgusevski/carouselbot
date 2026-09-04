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

const { drawTextLayer, renderSlideCanvas } = await import("../src/slide-renderer.mjs");
const { OUTLINE_RATIO, outlineWidthForFontSize } = await import("../src/editor-model.mjs");
const { canonicalSolidBackgroundColor, solidBackgroundDataUrl } = await import("../src/slide-background.mjs");

function recordedOutlines(size, outlineWidth = undefined, canvasWidth = 1080) {
  const outlines = [];
  const context = {
    save() {},
    translate() {},
    rotate() {},
    restore() {},
    measureText(value) {
      return { width: String(value).length * 10 };
    },
    strokeText() {
      outlines.push({ color: this.strokeStyle, width: this.lineWidth });
    },
    fillText() {},
  };
  drawTextLayer(context, {
    id: "outline",
    text: "Outline",
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.4,
    size,
    style: "outline",
    outlineWidth,
    color: "#FFFFFF",
    align: "center",
  }, canvasWidth, canvasWidth * 16 / 9, { fonts: [] });
  return outlines;
}

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

test("renders canvas outlines as a stable percentage of the font size", () => {
  const [small] = recordedOutlines(40);
  const [large] = recordedOutlines(160);
  const [scaledExport] = recordedOutlines(160, undefined, 270);
  const [custom] = recordedOutlines(160, 24);

  assert.deepEqual(small, { color: "#000000", width: outlineWidthForFontSize(40) });
  assert.deepEqual(large, { color: "#000000", width: outlineWidthForFontSize(160) });
  assert.ok(Math.abs(small.width / 40 - OUTLINE_RATIO) < Number.EPSILON);
  assert.ok(Math.abs(large.width / 160 - OUTLINE_RATIO) < Number.EPSILON);
  assert.ok(Math.abs(scaledExport.width - large.width / 4) < Number.EPSILON);
  assert.ok(Math.abs(custom.width - large.width * 2) < Number.EPSILON);
  assert.deepEqual(recordedOutlines(160, 0), []);
});
