import test from "node:test";
import assert from "node:assert/strict";

import {
  ASPECT_RATIO_PRESETS,
  ASPECT_RATIO_INPUT_MAX_LENGTH,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_OUTLINE_WIDTH,
  OUTLINE_RATIO,
  SUPPORTED_ASPECT_RATIOS,
  aspectRatioFromDimensions,
  adjacentSlideId,
  applyCropValues,
  cloneProject,
  ensureBoxedTextContrast,
  escapeHtml,
  folderRoutePath,
  fontSizeFromSliderPosition,
  formatFontSize,
  formatRgb,
  getImageLayout,
  initialOverlayWidth,
  initialTextBoxHeight,
  isCopiedLayer,
  isImageFile,
  layerClipCss,
  clampLayerCoordinate,
  layerKey,
  layerStageInset,
  normalizePerLineBackgroundWidths,
  nextLayerZ,
  normalizeAspectRatio,
  normalizeFolderPath,
  normalizeHexColor,
  outlineColorFor,
  outlineWidthForFontSize,
  overlayCrop,
  parseCopiedLayer,
  parseLayerKey,
  projectCanvasDimensions,
  remapLayerGeometryBetweenCanvases,
  projectPath,
  rgbToHex,
  rotateDelta,
  perLineBackgroundSvgPath,
  routeFromPathname,
  safeFilename,
  scaleCanvasDimensions,
  slideCanvasDimensions,
  slideItems,
  sliderPositionFromFontSize,
  textAlignment,
  textColor,
  wrapText,
} from "../src/editor-model.mjs";

test("normalizes supported project formats and resolves their exact canvas dimensions", () => {
  assert.equal(DEFAULT_ASPECT_RATIO, "9:16");
  assert.deepEqual(SUPPORTED_ASPECT_RATIOS, ["9:16", "2:3", "3:4", "4:5", "1:1", "4:3", "16:9"]);
  assert.deepEqual(ASPECT_RATIO_PRESETS["9:16"], { width: 1080, height: 1920 });
  assert.deepEqual(ASPECT_RATIO_PRESETS["2:3"], { width: 1080, height: 1620 });
  assert.deepEqual(ASPECT_RATIO_PRESETS["3:4"], { width: 1080, height: 1440 });
  assert.deepEqual(ASPECT_RATIO_PRESETS["4:5"], { width: 1080, height: 1350 });
  assert.deepEqual(ASPECT_RATIO_PRESETS["1:1"], { width: 1080, height: 1080 });
  assert.deepEqual(ASPECT_RATIO_PRESETS["4:3"], { width: 1080, height: 810 });
  assert.deepEqual(ASPECT_RATIO_PRESETS["16:9"], { width: 1080, height: 608 });
  assert.equal(normalizeAspectRatio(" 4:5 "), "4:5");
  assert.equal(normalizeAspectRatio("08:012"), "2:3");
  assert.equal(normalizeAspectRatio("1:7"), "9:16");
  assert.equal(normalizeAspectRatio(`${"9".repeat(ASPECT_RATIO_INPUT_MAX_LENGTH + 1)}:9`), "9:16");
  assert.equal(normalizeAspectRatio(null, "1:1"), "1:1");
  assert.deepEqual(projectCanvasDimensions(), { aspectRatio: "9:16", width: 1080, height: 1920 });
  assert.deepEqual(projectCanvasDimensions({ aspectRatio: "3:4" }), { aspectRatio: "3:4", width: 1080, height: 1440 });
  assert.deepEqual(projectCanvasDimensions({ aspectRatio: "32:9" }), { aspectRatio: "32:9", width: 1080, height: 304 });
  assert.deepEqual(scaleCanvasDimensions({ aspectRatio: "2:3" }, 360), { aspectRatio: "2:3", width: 360, height: 540 });
  assert.equal(aspectRatioFromDimensions(600, 900), "2:3");
  assert.equal(aspectRatioFromDimensions(1600, 400), "4:1");
  assert.equal(aspectRatioFromDimensions(500, 1600), "5:16");
  assert.equal(aspectRatioFromDimensions(0, 900, "1:1"), "1:1");
});

test("lets a slide override its project's default canvas format", () => {
  const project = { aspectRatio: "3:4" };
  assert.deepEqual(slideCanvasDimensions(project), { aspectRatio: "3:4", width: 1080, height: 1440 });
  assert.deepEqual(
    slideCanvasDimensions(project, { aspectRatio: "08:08" }),
    { aspectRatio: "1:1", width: 1080, height: 1080 },
  );
  assert.deepEqual(
    slideCanvasDimensions(project, { aspectRatio: "invalid" }),
    { aspectRatio: "3:4", width: 1080, height: 1440 },
  );
  assert.deepEqual(
    scaleCanvasDimensions(project, 360, { aspectRatio: "4:3" }),
    { aspectRatio: "4:3", width: 360, height: 270 },
  );
  assert.deepEqual(projectCanvasDimensions(project), { aspectRatio: "3:4", width: 1080, height: 1440 });
});

test("sizes native text boxes for readable one-line text on landscape canvases", () => {
  assert.equal(initialTextBoxHeight({ aspectRatio: "9:16" }, 64), 0.08);
  const landscapeHeight = initialTextBoxHeight({ aspectRatio: "16:9" }, 64);
  assert.ok(landscapeHeight > 0.15);
  assert.ok(landscapeHeight * 608 >= 64 * (1.12 + 0.28) + 4);
  assert.equal(
    initialTextBoxHeight({ aspectRatio: "9:16" }, 64, { aspectRatio: "16:9" }),
    landscapeHeight,
  );
});

test("remaps copied layer height between canvas formats while preserving its normalized center", () => {
  const original = { x: 0.2, y: 0.4, width: 0.5, height: 0.1 };
  const remapped = remapLayerGeometryBetweenCanvases(
    original,
    { aspectRatio: "9:16", width: 1080, height: 1920 },
    { aspectRatio: "16:9", width: 1080, height: 608 },
  );
  assert.equal(remapped.x, original.x);
  assert.equal(remapped.width, original.width);
  assert.ok(Math.abs(remapped.height - (0.1 * 1920 / 608)) < 1e-12);
  assert.ok(Math.abs((remapped.y + remapped.height / 2) - (original.y + original.height / 2)) < 1e-12);
  assert.equal(clampLayerCoordinate(-0.2, 0.5), 0);
  assert.equal(clampLayerCoordinate(0.2, 1.4), 0);
});

test("scales capped cross-format layers uniformly instead of distorting or clipping them", () => {
  const original = { x: 0.2, y: 0.1, width: 0.5, height: 1, size: 64, outlineWidth: 12 };
  const remapped = remapLayerGeometryBetweenCanvases(
    original,
    { aspectRatio: "9:16", width: 1080, height: 1920 },
    { aspectRatio: "16:9", width: 1080, height: 608 },
    { maxHeight: 2.4 },
  );
  const desiredHeight = 1920 / 608;
  const scale = 2.4 / desiredHeight;
  assert.ok(Math.abs(remapped.height - 2.4) < 1e-12);
  assert.ok(Math.abs(remapped.width - original.width * scale) < 1e-12);
  assert.ok(Math.abs(remapped.size - original.size * scale) < 1e-12);
  assert.equal(remapped.outlineWidth, original.outlineWidth);
  assert.ok(Math.abs((remapped.x + remapped.width / 2) - (original.x + original.width / 2)) < 1e-12);
  assert.ok(Math.abs((remapped.y + remapped.height / 2) - (original.y + original.height / 2)) < 1e-12);
});

test("keeps outline thickness proportional to font size", () => {
  assert.equal(OUTLINE_RATIO, 0.144);
  for (const size of [20, 64, 180]) {
    const width = outlineWidthForFontSize(size);
    assert.ok(Math.abs(width / size - OUTLINE_RATIO) < Number.EPSILON);
  }
  assert.equal(outlineWidthForFontSize(64, 0), 0);
  assert.ok(Math.abs(
    outlineWidthForFontSize(120, 40) / 120
      - OUTLINE_RATIO * (40 / DEFAULT_OUTLINE_WIDTH),
  ) < Number.EPSILON);
  assert.equal(outlineWidthForFontSize("invalid"), 0);
});

test("keeps extreme custom-format remaps within the layer height limit", () => {
  const original = { x: 0.1, y: 0, width: 0.8, height: 1, size: 64 };
  const remapped = remapLayerGeometryBetweenCanvases(
    original,
    { aspectRatio: "9:32", width: 1080, height: 3840 },
    { aspectRatio: "6:1", width: 1080, height: 180 },
    { maxHeight: 2.4 },
  );

  assert.equal(remapped.height, 2.4);
  assert.ok(remapped.size < 20, "the explicit geometry cap wins when both constraints cannot be satisfied");
  assert.ok(Math.abs((remapped.y + remapped.height / 2) - 0.5) < 1e-12);
});

test("finds adjacent slides without wrapping past either end", () => {
  const slides = [{ id: "first" }, { id: "middle" }, { id: "final" }];
  assert.equal(adjacentSlideId(slides, "middle", -1), "first");
  assert.equal(adjacentSlideId(slides, "middle", 1), "final");
  assert.equal(adjacentSlideId(slides, "first", -1), "first");
  assert.equal(adjacentSlideId(slides, "final", 1), "final");
  assert.equal(adjacentSlideId(slides, "middle", 0), "middle");
  assert.equal(adjacentSlideId(slides, "missing", 1), null);
  assert.equal(adjacentSlideId([], "first", 1), null);
});

test("routes dashboard and encoded project URLs", () => {
  assert.deepEqual(routeFromPathname("/"), { view: "dashboard" });
  assert.deepEqual(routeFromPathname("/index.html"), { view: "dashboard" });
  assert.deepEqual(routeFromPathname("/projects/a%20b/"), { view: "project", projectId: "a b" });
  assert.deepEqual(routeFromPathname("/projects/%E0%A4%A"), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/unknown"), { view: "not-found" });
  assert.equal(projectPath("a b/c"), "/projects/a%20b%2Fc");
});

test("normalizes virtual folder paths with one leading slash and a bounded length", () => {
  assert.equal(normalizeFolderPath(null), null);
  assert.equal(normalizeFolderPath(undefined), null);
  assert.equal(normalizeFolderPath(""), null);
  assert.equal(normalizeFolderPath("   "), null);
  assert.equal(normalizeFolderPath("/"), null);
  assert.equal(normalizeFolderPath(" /// "), null);
  assert.equal(normalizeFolderPath("/."), null);
  assert.equal(normalizeFolderPath("/.."), null);
  assert.equal(normalizeFolderPath("my-folder"), "/my-folder");
  assert.equal(normalizeFolderPath(" /my-folder "), "/my-folder");
  assert.equal(normalizeFolderPath(" ///   my-folder   "), "/my-folder");
  assert.equal(normalizeFolderPath(" /Campaign 2026/Q4 "), "/Campaign 2026/Q4");
  const bounded = normalizeFolderPath(`/${"x".repeat(200)}`);
  assert.equal(bounded, `/${"x".repeat(159)}`);
  assert.equal(bounded.length, 160);
  const emojiBoundary = normalizeFolderPath(`${"x".repeat(158)}😀`);
  assert.equal(emojiBoundary, `/${"x".repeat(158)}`);
  assert.doesNotThrow(() => folderRoutePath(emojiBoundary));
  assert.equal(normalizeFolderPath(`safe\uD800path`), "/safe�path");
});

test("builds and parses encoded virtual folder routes", () => {
  assert.equal(folderRoutePath(null), "/");
  assert.equal(folderRoutePath("/my folder"), "/folders/my%20folder");
  assert.equal(folderRoutePath(" /Campaign 2026/Q4 "), "/folders/Campaign%202026%2FQ4");
  assert.deepEqual(routeFromPathname("/folders/my%20folder"), { view: "folder", folderPath: "/my folder" });
  assert.deepEqual(routeFromPathname("/folders/Campaign%202026%2FQ4/"), { view: "folder", folderPath: "/Campaign 2026/Q4" });
  assert.deepEqual(routeFromPathname("/folders/%2Fmy-folder"), { view: "folder", folderPath: "/my-folder" });
  assert.deepEqual(routeFromPathname("/folders/%20"), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/folders/%2F"), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/folders/."), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/folders/.."), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/folders/%E0%A4%A"), { view: "not-found" });
  assert.deepEqual(routeFromPathname("/folders/unencoded/nested"), { view: "not-found" });
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
  assert.equal(outlineColorFor("#FFFFFF"), "#000000");
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
    fonts: [{ id: "font", fontData: "data:font/ttf;base64,AA==", variableAxes: [{ tag: "wght", default: 400 }] }],
    slides: [{
      id: "slide",
      texts: [{ id: "text", text: "One", fontVariationSettings: { wght: 500 } }],
      overlays: [{ id: "image", x: 0.1 }],
    }],
  };
  const copy = cloneProject(original);
  copy.assets[0].name = "Changed";
  copy.fonts[0].variableAxes[0].default = 700;
  copy.slides[0].texts[0].text = "Two";
  copy.slides[0].texts[0].fontVariationSettings.wght = 700;
  copy.slides[0].overlays[0].x = 0.5;
  assert.equal(original.assets[0].name, "Original");
  assert.equal(original.fonts[0].variableAxes[0].default, 400);
  assert.equal(original.slides[0].texts[0].text, "One");
  assert.equal(original.slides[0].texts[0].fontVariationSettings.wght, 500);
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
  assert.ok(Math.abs(initialOverlayWidth({ width: 1080, height: 1920 }, { aspectRatio: "1:1" }) - 0.46125) < Number.EPSILON);
  assert.ok(Math.abs(initialOverlayWidth(
    { width: 1080, height: 1920 },
    { aspectRatio: "9:16" },
    { aspectRatio: "1:1" },
  ) - 0.46125) < Number.EPSILON);
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

test("fits a source-ratio image exactly to the canvas width without export padding", () => {
  const layout = getImageLayout({ width: 1600, height: 400, imageScale: 1, imageX: 0, imageY: 0 }, 1080, 270);
  assert.deepEqual(layout, {
    width: 1080,
    height: 270,
    left: 0,
    top: 0,
    maxOffsetX: 0,
    maxOffsetY: 0,
  });
});

test("merges only text-row steps that cannot hold uniform corners", () => {
  assert.deepEqual(normalizePerLineBackgroundWidths([100, 130], "center", 10), [130, 130]);
  assert.deepEqual(normalizePerLineBackgroundWidths([100, 150], "center", 10), [100, 150]);
  assert.deepEqual(normalizePerLineBackgroundWidths([100, 130, 160], "center", 10), [160, 160, 160]);
  assert.deepEqual(normalizePerLineBackgroundWidths([100, 115], "left", 10), [115, 115]);
  assert.deepEqual(normalizePerLineBackgroundWidths([100, 130], "right", 10), [100, 130]);
});

test("produces one deterministic circular-arc path for per-line text backgrounds", () => {
  assert.equal(
    perLineBackgroundSvgPath([100], 30, 40, 0, 100, "center", 10),
    "M 10 0 H 90 A 10 10 0 0 1 100 10 V 30 A 10 10 0 0 1 90 40 H 10 A 10 10 0 0 1 0 30 V 10 A 10 10 0 0 1 10 0 Z",
  );
  const stepped = perLineBackgroundSvgPath([80, 140], 30, 40, 0, 140, "center", 10);
  assert.equal((stepped.match(/A 10 10/g) || []).length, 8);
  assert.equal(stepped.includes(" Q "), false);
});

test("keeps a wider upper row behind descenders before narrowing", () => {
  const narrowing = perLineBackgroundSvgPath([140, 80], 30, 40, 0, 140, "center", 5);
  const widening = perLineBackgroundSvgPath([80, 140], 30, 40, 0, 140, "center", 5);

  assert.match(narrowing, /V 35 A 5 5 0 0 1 135 40 H 115 A 5 5 0 0 0 110 45/);
  assert.match(widening, /V 30 A 5 5 0 0 0 115 35 H 135 A 5 5 0 0 1 140 40/);
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
  const copied = { token: "token", sourceCanvas: { aspectRatio: "3:4", width: 1080, height: 1440 }, layers: [{ kind: "text", item: { id: "text" } }] };
  assert.equal(isCopiedLayer(copied), true);
  assert.deepEqual(parseCopiedLayer(JSON.stringify(copied)), copied);
  assert.equal(parseCopiedLayer("not json"), null);
  assert.equal(isCopiedLayer({ token: "token", layers: [{ kind: "video", item: {} }] }), false);
  assert.equal(isCopiedLayer({ ...copied, sourceCanvas: { aspectRatio: "3:4", width: 1080, height: 0 } }), false);
});

test("recognizes image MIME types and supported filename extensions", () => {
  assert.equal(isImageFile({ type: "image/png", name: "no-extension" }), true);
  assert.equal(isImageFile({ type: "", name: "photo.AVIF" }), true);
  assert.equal(isImageFile({ type: "text/plain", name: "notes.txt" }), false);
  assert.equal(isImageFile(null), false);
});
