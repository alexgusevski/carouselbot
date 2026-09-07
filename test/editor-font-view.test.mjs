import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ getContext: () => ({}) }),
};

const { state } = await import("../src/editor-state.mjs");
const { renderTextBox } = await import("../src/editor-view.mjs");
const { createProjectFont } = await import("../src/project-fonts.mjs");

function textLayer(fontId) {
  return {
    id: "text-font-view",
    text: "speed limit",
    fontId,
    fontFamily: "Didot",
    fontWeight: 400,
    fontStyle: "normal",
    x: 0.1,
    y: 0.2,
    width: 0.8,
    height: 0.12,
    size: 72,
    style: "plain",
    color: "#FFFFFF",
    align: "center",
  };
}

test("marks unavailable project fonts visibly instead of claiming exact rendering", () => {
  const font = {
    id: "missing-didot",
    source: "local",
    localFontId: "font_missing_didot",
    family: "Didot",
    fullName: "Didot Regular",
    postscriptName: "Didot",
    subfamily: "Regular",
    weight: 400,
    italic: false,
    cssFamily: "carousel-font-missing-didot",
    variableAxes: [],
  };
  const text = textLayer(font.id);
  state.projects = [{ id: "project", fonts: [font], slides: [{ id: "slide", texts: [text], overlays: [] }] }];
  state.activeProjectId = "project";
  state.activeSlideId = "slide";
  state.selectedLayerKeys = [];

  const html = renderTextBox(text);

  assert.match(html, /is-font-missing/);
  assert.match(html, /missing-font-badge/);
  assert.match(html, /Didot Regular is unavailable/);
  assert.doesNotMatch(html, /is-font-loading/);
});

test("hides a stored project face until its exact bytes finish loading", () => {
  const font = createProjectFont({
    localFontId: "font_loading_didot",
    family: "Didot",
    fullName: "Didot Regular",
    postscriptName: "Didot",
    subfamily: "Regular",
    weight: 400,
    italic: false,
    variableAxes: [],
  }, "data:font/ttf;base64,AAECAw==", { id: "loading-didot" });
  const text = textLayer(font.id);
  state.projects = [{ id: "project", fonts: [font], slides: [{ id: "slide", texts: [text], overlays: [] }] }];

  const html = renderTextBox(text);

  assert.match(html, /is-font-loading/);
  assert.doesNotMatch(html, /is-font-missing/);
  assert.doesNotMatch(html, /missing-font-badge/);
});

test("shared inspector distinguishes mixed fonts, sizes, and formatting", async () => {
  const { renderInspector } = await import("../src/editor-view.mjs");
  const { setLayerSelection } = await import("../src/editor-state.mjs");
  const first = { ...textLayer(undefined), id: "first", size: 50, align: "left" };
  const second = { ...textLayer("other-font"), id: "second", size: 60, color: "#000000", align: "right" };
  state.projects = [{ id: "shared-project", fonts: [{ id: "other-font", family: "Other", fullName: "Other Regular" }], slides: [{ id: "shared-slide", texts: [first, second], overlays: [] }] }];
  state.activeProjectId = "shared-project";
  state.activeSlideId = "shared-slide";
  setLayerSelection(["text:first", "text:second"]);
  const mixed = renderInspector();
  assert.match(mixed, /value="__mixed__" selected disabled/);
  assert.match(mixed, /id="font-size-number"[^>]*value=""/);
  assert.match(mixed, /id="font-size" data-mixed="true"/);
  assert.match(mixed, /id="text-color-hex"[^>]*value=""/);
  assert.doesNotMatch(mixed, /alignment-option is-active/);
  assert.doesNotMatch(mixed, /id="text-value"/);
  second.fontId = first.fontId;
  second.size = first.size = 56;
  const same = renderInspector();
  assert.doesNotMatch(same, /value="__mixed__"/);
  assert.match(same, /id="font-size-number"[^>]*value="56"/);
  assert.match(same, /value="" selected>TikTok Sans/);
});
