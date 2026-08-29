import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCropValues,
  cloneProject,
  concaveCornerSvgPath,
  ensureBoxedTextContrast,
  escapeHtml,
  fontSizeFromSliderPosition,
  formatFontSize,
  formatRgb,
  getImageLayout,
  initialOverlayWidth,
  isCopiedLayer,
  isImageFile,
  layerClipCss,
  layerKey,
  layerStageInset,
  lineCornerRadii,
  lineJunctionCorners,
  nextLayerZ,
  normalizeHexColor,
  outlineColorFor,
  overlayCrop,
  parseCopiedLayer,
  parseLayerKey,
  projectPath,
  rgbToHex,
  rotateDelta,
  roundedRectSvgPath,
  routeFromPathname,
  safeFilename,
  slideItems,
  sliderPositionFromFontSize,
  textAlignment,
  textColor,
  wrapText,
} from "../src/editor-model.mjs";

test("routes dashboard and encoded project URLs", () => {
  assert.deepEqual(routeFromPathname("/"), { view: "dashboard" });
  assert.deepEqual(routeFromPathname("/index.html"), { view: "dashboard" });
  assert.deepEqual(routeFromPathname("/projects/a%20b/"), { view: "project", projectId: "a b" });
  assert.deepEqual(routeFromPathname("/projects/%E0%A4%A"), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/unknown"), { view: "not-found" });
  assert.equal(projectPath("a b/c"), "/projects/a%20b%2Fc");
});

test("escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a title="'">&`), "&lt;a title=&quot;&#039;&quot;&gt;&amp;");
});

test("normalizes short and long hex colors without accepting malformed input", () => {
  assert.equal(normalizeHexColor(" #aBc "), "#AABBCC");
  assert.equal(normalizeHexColor("00ff7f"), "#00FF7F");
  assert.equal(normalizeHexColor("#12"), null);
  assert.equal(normalizeHexColor("nope", "#ABCDEF"), "#ABCDEF");
});

test("rounds and clamps RGB input", () => {
  assert.equal(rgbToHex("rgb(254.6, -2, 300)"), "#FF00FF");
  assert.equal(rgbToHex("1, 2"), null);
  assert.equal(formatRgb("#0A80FF"), "rgb(10, 128, 255)");
});

test("preserves legacy text defaults and boxed contrast", () => {
  assert.equal(textColor({ style: "boxed", background: "white" }), "#111111");
  assert.equal(textColor({ style: "plain" }), "#FFFFFF");
  assert.equal(outlineColorFor("#111111"), "#FFFFFF");
  assert.equal(outlineColorFor("#FFFFFF"), "#111111");
  const lightBox = { style: "boxed", background: "white", color: "#FFFFFF" };
  const darkBox = { style: "boxed", background: "black", color: "#111111" };
  ensureBoxedTextContrast(lightBox);
  ensureBoxedTextContrast(darkBox);
  assert.equal(lightBox.color, "#111111");
  assert.equal(darkBox.color, "#FFFFFF");
});

test("clones nested project data without retaining aliases", () => {
  const original = {
    id: "project",
    assets: [{ id: "asset", name: "Original" }],
    slides: [{ id: "slide", texts: [{ id: "text", text: "One" }], overlays: [{ id: "image", x: 0.1 }] }],
  };
  const copy = cloneProject(original);
  copy.assets[0].name = "Changed";
  copy.slides[0].texts[0].text = "Two";
  copy.slides[0].overlays[0].x = 0.5;
  assert.equal(original.assets[0].name, "Original");
  assert.equal(original.slides[0].texts[0].text, "One");
  assert.equal(original.slides[0].overlays[0].x, 0.1);
});

test("builds and parses stable layer keys", () => {
  assert.equal(layerKey("overlay", "abc:def"), "overlay:abc:def");
  assert.deepEqual(parseLayerKey("overlay:abc:def"), { kind: "overlay", id: "abc:def" });
});

test("orders mixed layers by z-index and finds the next z-index", () => {
  const slide = {
    overlays: [{ id: "image", z: 2 }],
    texts: [{ id: "back", z: 1 }, { id: "front", z: 8 }],
  };
  assert.deepEqual(slideItems(slide).map(({ kind, item }) => `${kind}:${item.id}`), ["text:back", "overlay:image", "text:front"]);
  assert.equal(nextLayerZ(slide), 9);
  assert.equal(nextLayerZ({ texts: [], overlays: [] }), 1);
});

test("normalizes crop rectangles into the source image", () => {
  const normalized = overlayCrop({ cropX: 0.9, cropY: -2, cropW: 0.5, cropH: 0 });
  assert.equal(normalized.x, 0.9);
  assert.equal(normalized.y, 0);
  assert.ok(Math.abs(normalized.w - 0.1) < Number.EPSILON);
  assert.equal(normalized.h, 1);
  const overlay = {};
  applyCropValues(overlay, { x: -0.1, y: 0.95, w: 0.4, h: 0.01, anchorY: 1 });
  assert.equal(overlay.cropX, 0);
  assert.equal(overlay.cropY, 0.95);
  assert.ok(Math.abs(overlay.cropW - 0.3) < Number.EPSILON);
  assert.equal(overlay.cropH, 0.05);
});

test("computes clipping for layers that cross stage edges", () => {
  assert.deepEqual(layerStageInset(-0.1, 0.2, 0.5, 0.5), { top: 0, right: 0, bottom: 0, left: 0.2 });
  assert.equal(layerClipCss(-0.1, 0.2, 0.5, 0.5), "inset(0% 0% 0% 20%)");
});

test("fits initial overlays without upscaling large or small assets incorrectly", () => {
  assert.equal(initialOverlayWidth(null), 0.34);
  assert.equal(initialOverlayWidth({ width: 108, height: 192 }), 0.1);
  assert.equal(initialOverlayWidth({ width: 2160, height: 3840 }), 0.82);
});

test("maps the nonlinear font-size slider at its defined stops", () => {
  assert.equal(fontSizeFromSliderPosition(0), 20);
  assert.equal(fontSizeFromSliderPosition(220), 40);
  assert.equal(fontSizeFromSliderPosition(780), 70);
  assert.equal(fontSizeFromSliderPosition(1000), 180);
  assert.equal(sliderPositionFromFontSize(40), 220);
  assert.equal(sliderPositionFromFontSize(70), 780);
  assert.equal(formatFontSize(44.49), "44.5");
  assert.equal(formatFontSize(999), "180");
});

test("calculates cover-image layout and clamps pan offsets", () => {
  const layout = getImageLayout({ width: 1000, height: 1000, imageScale: 1, imageX: 2, imageY: -2 }, 1000, 2000);
  assert.equal(layout.width, 2000);
  assert.equal(layout.height, 2000);
  assert.equal(layout.left, 0);
  assert.equal(layout.top, 0);
  assert.equal(layout.maxOffsetX, 0.5);
  assert.equal(layout.maxOffsetY, 0);
});

test("identifies exposed and joined corners for per-line text boxes", () => {
  assert.deepEqual(lineCornerRadii([100, 80], 0, 10), [10, 10, 10, 10]);
  assert.deepEqual(lineCornerRadii([80, 100], 1, 10), [10, 10, 10, 10]);
  assert.deepEqual(lineJunctionCorners([80, 120], [20, 60], 100, 40, 8), [
    { cx: 60, cy: 40, radius: 8, quadrant: "upper-left" },
    { cx: 140, cy: 40, radius: 8, quadrant: "upper-right" },
  ]);
});

test("produces deterministic convex and concave SVG paths", () => {
  assert.equal(roundedRectSvgPath(0, 0, 100, 50, [10, 10, 10, 10]), "M 10 0 H 90 Q 100 0 100 10 V 40 Q 100 50 90 50 H 10 Q 0 50 0 40 V 10 Q 0 0 10 0 Z");
  assert.equal(concaveCornerSvgPath({ cx: 10, cy: 20, radius: 4, quadrant: "upper-left" }), "M 10 16 L 10 20 L 6 20 A 4 4 0 0 0 10 16 Z");
});

test("rotates pointer deltas into layer-local axes", () => {
  const result = rotateDelta(10, 0, 90);
  assert.ok(Math.abs(result.x) < 1e-10);
  assert.equal(result.y, -10);
});

test("wraps paragraphs, explicit blank lines, and overlong words", () => {
  const context = { measureText: (value) => ({ width: [...value].length * 10 }) };
  assert.deepEqual(wrapText(context, "one two\n\nabcdef", 35), ["one", "two", "", "abc", "def"]);
});

test("normalizes filenames and text alignment", () => {
  assert.equal(safeFilename("  Launch / Summer 2026!  "), "launch-summer-2026");
  assert.equal(safeFilename("💫"), "slide");
  assert.equal(textAlignment({ align: "right" }), "right");
  assert.equal(textAlignment({ align: "justify" }), "center");
});

test("validates canonical and legacy copied-layer payloads", () => {
  const copied = { token: "token", layers: [{ kind: "text", item: { id: "text" } }] };
  assert.equal(isCopiedLayer(copied), true);
  assert.deepEqual(parseCopiedLayer(JSON.stringify(copied)), copied);
  assert.equal(parseCopiedLayer("not json"), null);
  assert.equal(isCopiedLayer({ token: "token", layers: [{ kind: "video", item: {} }] }), false);
});

test("recognizes image MIME types and supported filename extensions", () => {
  assert.equal(isImageFile({ type: "image/png", name: "no-extension" }), true);
  assert.equal(isImageFile({ type: "", name: "photo.AVIF" }), true);
  assert.equal(isImageFile({ type: "text/plain", name: "notes.txt" }), false);
  assert.equal(isImageFile(null), false);
});
