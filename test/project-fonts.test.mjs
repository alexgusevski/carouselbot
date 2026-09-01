import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_STYLE,
  DEFAULT_FONT_WEIGHT,
  applyProjectFontToText,
  createProjectFont,
  ensureProjectFontsLoaded,
  isTextFontAvailable,
  isTextFontLoaded,
  normalizeProjectFonts,
  projectFontForText,
  publicProjectFont,
  quoteCssFontFamily,
  textCanvasFont,
  textCssFontFamily,
  textFontFamily,
  textFontLabel,
  textFontStyle,
  textFontVariationCss,
  textFontVariationSettings,
  textFontVariationValues,
  textFontWeight,
} from "../src/project-fonts.mjs";

const FONT_DATA = "data:font/otf;base64,AAECA/8=";

function localFace(overrides = {}) {
  return {
    localFontId: "font_local_didot_regular",
    family: "Didot",
    fullName: "Didot Regular",
    postscriptName: "Didot",
    subfamily: "Regular",
    weight: 400,
    italic: false,
    fingerprint: "didot-fingerprint",
    variableAxes: [],
    ...overrides,
  };
}

function projectWithFont(font, text = {}) {
  return {
    id: "project-font-test",
    fonts: [font],
    slides: [{ id: "slide", texts: [{ id: "text", text: "speed limit", fontId: font.id, ...text }] }],
  };
}

function installFakeFontEnvironment({ loadFace = null } = {}) {
  const previousDocument = globalThis.document;
  const previousFontFace = globalThis.FontFace;
  const constructed = [];
  const added = [];
  const deleted = [];
  const defaultLoads = [];
  class FakeFontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
      this.status = "unloaded";
      constructed.push(this);
    }

    async load() {
      if (loadFace) return loadFace(this);
      this.status = "loaded";
      return this;
    }
  }
  globalThis.FontFace = FakeFontFace;
  globalThis.document = {
    fonts: {
      ready: Promise.resolve(),
      async load(value) {
        defaultLoads.push(value);
        return [];
      },
      add(face) { added.push(face); },
      delete(face) { deleted.push(face); },
    },
  };
  return {
    constructed,
    added,
    deleted,
    defaultLoads,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousFontFace === undefined) delete globalThis.FontFace;
      else globalThis.FontFace = previousFontFace;
    },
  };
}

test("normalizes legacy text to CarouselBot's actual bundled default", () => {
  const project = {
    id: "legacy",
    slides: [{
      id: "slide",
      texts: [
        { id: "plain", text: "Default" },
        { id: "italic", text: "Existing", fontFamily: "Existing family", fontWeight: 725, fontStyle: "italic" },
      ],
    }],
  };

  assert.equal(normalizeProjectFonts(project), project);
  assert.deepEqual(project.fonts, []);
  assert.deepEqual(project.slides[0].texts[0], {
    id: "plain",
    text: "Default",
    fontFamily: DEFAULT_FONT_FAMILY,
    fontWeight: DEFAULT_FONT_WEIGHT,
    fontStyle: DEFAULT_FONT_STYLE,
  });
  assert.equal(DEFAULT_FONT_FAMILY, "TikTok Sans");
  assert.equal(DEFAULT_FONT_WEIGHT, 500);
  assert.equal(project.slides[0].texts[1].fontFamily, DEFAULT_FONT_FAMILY);
  assert.equal(project.slides[0].texts[1].fontWeight, 725);
  assert.equal(project.slides[0].texts[1].fontStyle, "italic");
});

test("creates a deterministic, path-free project font record from companion metadata", () => {
  const font = createProjectFont(localFace({
    pathInternal: "/System/Library/Fonts/Supplemental/Didot.ttc",
    variableAxes: [
      { tag: "wght", name: "Weight", min: 100, max: 900, default: 400 },
      { tag: "wght", name: "Duplicate", min: 1, max: 2, default: 1 },
      { tag: "bad", name: "Bad", min: 0, max: 1, default: 0 },
    ],
  }), FONT_DATA, { id: "project face", addedAt: 123, dataRevision: "revision-1" });

  assert.deepEqual(font, {
    id: "project face",
    source: "local",
    localFontId: "font_local_didot_regular",
    family: "Didot",
    fullName: "Didot Regular",
    postscriptName: "Didot",
    subfamily: "Regular",
    weight: 400,
    italic: false,
    cssFamily: "carousel-font-project-face",
    variableAxes: [{ tag: "wght", name: "Weight", min: 100, max: 900, default: 400 }],
    fingerprint: "didot-fingerprint",
    dataRevision: "revision-1",
    addedAt: 123,
    fontData: FONT_DATA,
  });
  assert.equal("pathInternal" in font, false);
  assert.throws(() => createProjectFont({}, FONT_DATA), /localFontId/);
  assert.throws(() => createProjectFont(localFace(), "https://example.com/font.otf"), /base64 data URL/);
});

test("normalizes and deduplicates stored project fonts without discarding dangling text refs", () => {
  const first = createProjectFont(localFace(), FONT_DATA, { id: "first", addedAt: 1 });
  const duplicateFace = { ...first, id: "duplicate", cssFamily: "unsafe family" };
  const project = {
    id: "stored",
    fonts: [first, duplicateFace, null, { id: "", localFontId: "bad" }],
    slides: [{ id: "slide", texts: [{ id: "text", fontId: "missing", fontFamily: "Gone font" }] }],
  };

  normalizeProjectFonts(project);

  assert.equal(project.fonts.length, 1);
  assert.equal(project.fonts[0].id, "first");
  assert.equal(project.fonts[0].cssFamily, "carousel-font-first");
  assert.equal(project.slides[0].texts[0].fontId, "missing");
  assert.equal(project.slides[0].texts[0].fontFamily, "Gone font");
  assert.equal(project.slides[0].texts[0].fontWeight, DEFAULT_FONT_WEIGHT);
  assert.equal(textFontLabel(project, project.slides[0].texts[0]), "Gone font");
});

test("resolves one shared descriptor for DOM, canvas, labels, and variable settings", () => {
  const font = createProjectFont(localFace({
    fullName: "Didot Variable",
    weight: 450,
    italic: true,
    variableAxes: [{ tag: "wght", name: "Weight", min: 300, max: 700, default: 450 }],
  }), FONT_DATA, { id: "didot-variable" });
  const text = {
    id: "text",
    fontId: font.id,
    fontWeight: 625,
    fontStyle: "normal",
    fontVariationSettings: { wght: 900, nope: 20, bad: "x" },
  };
  const project = { id: "project", fonts: [font], slides: [] };

  assert.equal(projectFontForText(project, text), font);
  assert.equal(textFontFamily(project, text), "carousel-font-didot-variable");
  assert.equal(textFontWeight(project, text), 700);
  assert.equal(textFontStyle(project, text), "italic");
  assert.deepEqual(textFontVariationValues(project, text), { wght: 700 });
  assert.deepEqual(textFontVariationSettings(project, text), { wght: 700 });
  assert.equal(textFontVariationCss(project, text), '"wght" 700');
  assert.equal(textFontVariationCss(text), '"wght" 900, "nope" 20');
  assert.equal(textFontLabel(project, text), "Didot Variable");
  assert.equal(textCssFontFamily(project, text), '"carousel-font-didot-variable", "TikTok Sans", sans-serif');
  assert.equal(textCanvasFont(project, text, 64), 'italic 700 64px "carousel-font-didot-variable"');
  assert.equal(quoteCssFontFamily('Face "One"\nTwo'), '"Face \\"One\\" Two"');
});

test("applies a project face by ID and resets cleanly to the built-in face", () => {
  const font = createProjectFont(localFace({ weight: 700, italic: true }), FONT_DATA, { id: "didot-bold-italic" });
  const project = { id: "project", fonts: [font], slides: [] };
  const text = { id: "text", fontVariationSettings: { wght: 600 } };

  assert.equal(applyProjectFontToText(project, text, font.id), text);
  assert.deepEqual(text, {
    id: "text",
    fontId: font.id,
    fontFamily: "Didot",
    fontWeight: 700,
    fontStyle: "italic",
  });

  applyProjectFontToText(project, text, null);
  assert.deepEqual(text, {
    id: "text",
    fontFamily: DEFAULT_FONT_FAMILY,
    fontWeight: DEFAULT_FONT_WEIGHT,
    fontStyle: DEFAULT_FONT_STYLE,
  });
  assert.throws(
    () => applyProjectFontToText(project, text, "guessed-font-id"),
    (error) => error.code === "FONT_NOT_FOUND" && error.fontId === "guessed-font-id",
  );
});

test("redacts private bytes and fingerprints from public project font records", () => {
  const font = createProjectFont(localFace(), FONT_DATA, { id: "public-font" });
  const project = { id: "project", fonts: [font], slides: [] };
  const value = publicProjectFont(project, font);

  assert.equal(value.id, font.id);
  assert.equal(value.localFontId, font.localFontId);
  assert.equal(value.available, true);
  assert.equal("fontData" in value, false);
  assert.equal("fingerprint" in value, false);
  assert.equal("dataRevision" in value, false);
  assert.equal(JSON.stringify(value).includes("AAECA"), false);
});

test("registers exact stored bytes once and waits for the bundled default font", async () => {
  const environment = installFakeFontEnvironment();
  try {
    const font = createProjectFont(localFace({ localFontId: "register-once" }), FONT_DATA, { id: "register-once" });
    const project = projectWithFont(font);
    const customText = project.slides[0].texts[0];
    const defaultText = { id: "default", text: "Default" };
    assert.equal(isTextFontLoaded(project, customText), false);

    const [first, second] = await Promise.all([
      ensureProjectFontsLoaded(project, [customText, defaultText]),
      ensureProjectFontsLoaded(project, [customText, defaultText]),
    ]);

    assert.deepEqual(first.loadedFontIds, [font.id]);
    assert.deepEqual(second.loadedFontIds, [font.id]);
    assert.equal(environment.constructed.length, 1);
    assert.equal(environment.added.length, 1);
    assert.equal(environment.constructed[0].family, font.cssFamily);
    assert.deepEqual(environment.constructed[0].descriptors, { weight: "400", style: "normal" });
    assert.deepEqual([...new Uint8Array(environment.constructed[0].source)], [0, 1, 2, 3, 255]);
    assert.ok(environment.defaultLoads.every((value) => value === '500 64px "TikTok Sans"'));
    assert.equal(isTextFontAvailable(project, customText), true);
    assert.equal(isTextFontLoaded(project, customText), true);
  } finally {
    environment.restore();
  }
});

test("registers a variable weight face across its supported range", async () => {
  const environment = installFakeFontEnvironment();
  try {
    const font = createProjectFont(localFace({
      localFontId: "variable-weight-face",
      variableAxes: [{ tag: "wght", name: "Weight", min: 300, max: 725, default: 450 }],
    }), FONT_DATA, { id: "variable-weight-face" });
    const project = projectWithFont(font);

    await ensureProjectFontsLoaded(project);

    assert.equal(environment.constructed[0].descriptors.weight, "300 725");
  } finally {
    environment.restore();
  }
});

test("reports unavailable and dangling fonts honestly with stable error codes", async () => {
  const environment = installFakeFontEnvironment({
    loadFace: async () => { throw new Error("invalid OpenType data"); },
  });
  try {
    const corrupt = createProjectFont(
      localFace({ localFontId: "corrupt-face", fullName: "Corrupt Face", fingerprint: "corrupt" }),
      FONT_DATA,
      { id: "corrupt-face" },
    );
    const corruptProject = projectWithFont(corrupt);
    await assert.rejects(
      ensureProjectFontsLoaded(corruptProject),
      (error) => error.code === "FONT_UNAVAILABLE"
        && error.fontId === corrupt.id
        && error.message.includes("Corrupt Face")
        && error.missingFonts.length === 1,
    );
    assert.equal(isTextFontAvailable(corruptProject, corruptProject.slides[0].texts[0]), false);
    assert.equal(publicProjectFont(corruptProject, corrupt).available, false);

    const dangling = {
      id: "dangling-project",
      fonts: [],
      slides: [{ id: "slide", texts: [{ id: "text", fontId: "removed-font", fontFamily: "Removed Face" }] }],
    };
    await assert.rejects(
      ensureProjectFontsLoaded(dangling),
      (error) => error.code === "FONT_UNAVAILABLE"
        && error.fontId === "removed-font"
        && error.message.includes("Removed Face"),
    );
    assert.equal(isTextFontAvailable(dangling, dangling.slides[0].texts[0]), false);
  } finally {
    environment.restore();
  }
});

test("re-registers a repaired face with the same project font ID", async () => {
  let shouldFail = true;
  const environment = installFakeFontEnvironment({
    loadFace: async (face) => {
      if (shouldFail) throw new Error("corrupt stored bytes");
      face.status = "loaded";
      return face;
    },
  });
  try {
    const broken = createProjectFont(
      localFace({ localFontId: "repair-face", fingerprint: "same-source" }),
      FONT_DATA,
      { id: "stable-project-font", dataRevision: "broken-revision" },
    );
    const project = projectWithFont(broken);
    await assert.rejects(ensureProjectFontsLoaded(project), (error) => error.code === "FONT_UNAVAILABLE");

    shouldFail = false;
    const repaired = createProjectFont(
      localFace({ localFontId: "repair-face", fingerprint: "same-source" }),
      FONT_DATA,
      { id: broken.id, addedAt: broken.addedAt, dataRevision: "repaired-revision" },
    );
    project.fonts = [repaired];
    await ensureProjectFontsLoaded(project);

    assert.equal(project.slides[0].texts[0].fontId, broken.id);
    assert.equal(isTextFontLoaded(project, project.slides[0].texts[0]), true);
    assert.equal(environment.constructed.length, 2);
    assert.equal(environment.added.length, 1);
  } finally {
    environment.restore();
  }
});
