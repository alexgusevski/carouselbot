import { TEXT_WEIGHT, clamp, uid } from "./editor-model.mjs";

export const DEFAULT_FONT_FAMILY = "TikTok Sans";

export const DEFAULT_FONT_WEIGHT = TEXT_WEIGHT;

export const DEFAULT_FONT_STYLE = "normal";

const FONT_ID_PREFIX = "font-";

const fontRegistrations = new Map();

function normalizedString(value, fallback = "", maxLength = 256) {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maxLength);
}

function normalizedFontWeight(value, fallback = DEFAULT_FONT_WEIGHT) {
  const numeric = Number(value);
  return Math.round(clamp(Number.isFinite(numeric) ? numeric : fallback, 1, 1000));
}

function normalizedFontStyle(value, fallback = DEFAULT_FONT_STYLE) {
  if (value === "normal" || value === "italic") return value;
  return fallback === "italic" ? "italic" : DEFAULT_FONT_STYLE;
}

function normalizedAxis(axis) {
  const tag = normalizedString(axis?.tag, "", 4);
  if (!/^[\x20-\x7e]{4}$/.test(tag)) return null;
  const minimum = Number(axis?.min);
  const maximum = Number(axis?.max);
  const defaultValue = Number(axis?.default);
  if (![minimum, maximum, defaultValue].every(Number.isFinite) || minimum > maximum) return null;
  return {
    tag,
    name: normalizedString(axis?.name, tag, 120),
    min: minimum,
    max: maximum,
    default: clamp(defaultValue, minimum, maximum),
  };
}

function normalizedVariableAxes(value) {
  if (!Array.isArray(value)) return [];
  const axes = [];
  const seen = new Set();
  for (const candidate of value) {
    const axis = normalizedAxis(candidate);
    if (!axis || seen.has(axis.tag)) continue;
    axes.push(axis);
    seen.add(axis.tag);
  }
  return axes;
}

function normalizedVariationSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const settings = {};
  for (const [rawTag, rawValue] of Object.entries(value)) {
    const tag = normalizedString(rawTag, "", 4);
    const numeric = Number(rawValue);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || !Number.isFinite(numeric)) continue;
    settings[tag] = numeric;
  }
  return settings;
}

function isFontDataUrl(value) {
  if (typeof value !== "string") return false;
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const header = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  return /^data:[^,;]*(?:;[^,;=]+=[^,;]*)*;base64$/i.test(header) && payload.trim().length > 0;
}

function normalizedFontId(value, { generate = false } = {}) {
  const id = normalizedString(value, "", 180);
  if (id) return id;
  return generate ? `${FONT_ID_PREFIX}${uid()}` : "";
}

function cssIdentifierPart(value) {
  const normalized = normalizedString(value, "font", 180)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "font";
}

function cssFamilyForId(id) {
  return `carousel-font-${cssIdentifierPart(id)}`;
}

function normalizedProjectFont(rawFont, { requireLocalId = false } = {}) {
  if (!rawFont || typeof rawFont !== "object") return null;
  const id = normalizedFontId(rawFont.id);
  const localFontId = normalizedString(rawFont.localFontId, "", 512);
  if (!id || (requireLocalId && !localFontId)) return null;
  const family = normalizedString(rawFont.family, rawFont.fullName || "Local font", 256);
  const subfamily = normalizedString(rawFont.subfamily, "Regular", 160);
  const fullName = normalizedString(
    rawFont.fullName,
    subfamily.toLowerCase() === "regular" ? family : `${family} ${subfamily}`,
    320,
  );
  const postscriptName = normalizedString(rawFont.postscriptName, fullName, 256);
  const font = {
    id,
    source: "local",
    localFontId,
    family,
    fullName,
    postscriptName,
    subfamily,
    weight: normalizedFontWeight(rawFont.weight, 400),
    italic: Boolean(rawFont.italic),
    cssFamily: cssFamilyForId(id),
    variableAxes: normalizedVariableAxes(rawFont.variableAxes),
    fingerprint: normalizedString(rawFont.fingerprint, localFontId || id, 512),
    dataRevision: normalizedString(rawFont.dataRevision, rawFont.fingerprint || localFontId || id, 512),
    addedAt: Number.isFinite(Number(rawFont.addedAt)) ? Number(rawFont.addedAt) : Date.now(),
  };
  if (isFontDataUrl(rawFont.fontData)) font.fontData = rawFont.fontData;
  return font;
}

export function normalizeTextFont(text, project = null) {
  if (!text || typeof text !== "object") return text;
  if (text.fontId != null) {
    const id = normalizedString(text.fontId, "", 180);
    if (id) text.fontId = id;
    else delete text.fontId;
  }
  const projectFont = projectFontForText(project, text);
  text.fontFamily = projectFont
    ? normalizedString(projectFont.family, DEFAULT_FONT_FAMILY, 256)
    : text.fontId
      ? normalizedString(text.fontFamily, DEFAULT_FONT_FAMILY, 256)
      : DEFAULT_FONT_FAMILY;
  const weightAxis = projectFont?.variableAxes?.find((axis) => axis.tag === "wght");
  text.fontWeight = projectFont
    ? weightAxis
      ? clamp(normalizedFontWeight(text.fontWeight, projectFont.weight), weightAxis.min, weightAxis.max)
      : normalizedFontWeight(projectFont.weight, 400)
    : normalizedFontWeight(text.fontWeight, DEFAULT_FONT_WEIGHT);
  text.fontStyle = projectFont
    ? projectFont.italic ? "italic" : DEFAULT_FONT_STYLE
    : normalizedFontStyle(text.fontStyle, DEFAULT_FONT_STYLE);
  const rawVariationSettings = normalizedVariationSettings(text.fontVariationSettings);
  const variationSettings = projectFont
    ? Object.fromEntries(Object.entries(rawVariationSettings).flatMap(([tag, value]) => {
      const axis = projectFont.variableAxes.find((candidate) => candidate.tag === tag);
      return axis ? [[tag, clamp(value, axis.min, axis.max)]] : [];
    }))
    : rawVariationSettings;
  if (weightAxis && variationSettings.wght != null) text.fontWeight = variationSettings.wght;
  if (Object.keys(variationSettings).length) text.fontVariationSettings = variationSettings;
  else delete text.fontVariationSettings;
  return text;
}

export function normalizeProjectFonts(project) {
  if (!project || typeof project !== "object") return project;
  const fonts = [];
  const seenIds = new Set();
  const seenLocalFaces = new Set();
  for (const rawFont of Array.isArray(project.fonts) ? project.fonts : []) {
    const font = normalizedProjectFont(rawFont);
    if (!font || seenIds.has(font.id)) continue;
    const localFaceKey = font.localFontId || null;
    if (localFaceKey && seenLocalFaces.has(localFaceKey)) continue;
    fonts.push(font);
    seenIds.add(font.id);
    if (localFaceKey) seenLocalFaces.add(localFaceKey);
  }
  project.fonts = fonts;
  for (const slide of Array.isArray(project.slides) ? project.slides : []) {
    for (const text of Array.isArray(slide?.texts) ? slide.texts : []) normalizeTextFont(text, project);
  }
  return project;
}

export function createProjectFont(face, dataUrl, { id = null, addedAt = Date.now(), dataRevision = uid() } = {}) {
  const localFontId = normalizedString(face?.localFontId, "", 512);
  if (!localFontId) throw new TypeError("A localFontId returned by the local companion is required.");
  if (!isFontDataUrl(dataUrl)) throw new TypeError("Local font data must be a base64 data URL.");
  const projectFont = normalizedProjectFont({
    ...face,
    id: normalizedFontId(id, { generate: true }),
    localFontId,
    fontData: dataUrl,
    dataRevision,
    addedAt,
  }, { requireLocalId: true });
  if (!projectFont) throw new TypeError("The selected local font metadata is invalid.");
  return projectFont;
}

export function publicProjectFont(project, font) {
  const normalized = normalizedProjectFont(font);
  if (!normalized) return null;
  const {
    fontData: _fontData,
    fingerprint: _fingerprint,
    dataRevision: _dataRevision,
    ...publicFont
  } = normalized;
  return {
    ...publicFont,
    available: isProjectFontAvailable(project, font),
  };
}

export function projectFontForText(project, text) {
  const fontId = normalizedString(text?.fontId, "", 180);
  if (!fontId || !Array.isArray(project?.fonts)) return null;
  return project.fonts.find((font) => font?.id === fontId) || null;
}

export function textFontFamily(project, text) {
  const font = projectFontForText(project, text);
  return normalizedString(font?.cssFamily || text?.fontFamily, DEFAULT_FONT_FAMILY, 256);
}

export function textFontWeight(project, text) {
  const font = projectFontForText(project, text);
  if (!font) return normalizedFontWeight(text?.fontWeight, DEFAULT_FONT_WEIGHT);
  const weightAxis = font.variableAxes?.find((axis) => axis.tag === "wght");
  return weightAxis
    ? clamp(normalizedFontWeight(text?.fontVariationSettings?.wght ?? text?.fontWeight, font.weight), weightAxis.min, weightAxis.max)
    : normalizedFontWeight(font.weight, 400);
}

export function textFontStyle(project, text) {
  const font = projectFontForText(project, text);
  return font
    ? font.italic ? "italic" : DEFAULT_FONT_STYLE
    : normalizedFontStyle(text?.fontStyle, DEFAULT_FONT_STYLE);
}

export function textFontVariationValues(projectOrText, maybeText = undefined) {
  const project = maybeText === undefined ? null : projectOrText;
  const text = maybeText === undefined ? projectOrText : maybeText;
  const font = projectFontForText(project, text);
  const settings = normalizedVariationSettings(text?.fontVariationSettings);
  if (!font) return settings;
  if (!font.variableAxes?.length) return {};
  const axes = new Map(font.variableAxes.map((axis) => [axis.tag, axis]));
  return Object.fromEntries(Object.entries(settings).flatMap(([tag, value]) => {
    const axis = axes.get(tag);
    return axis ? [[tag, clamp(value, axis.min, axis.max)]] : [];
  }));
}

export function textFontVariationSettings(projectOrText, maybeText = undefined) {
  return textFontVariationValues(projectOrText, maybeText);
}

export function textFontVariationCss(projectOrText, maybeText = undefined) {
  const settings = textFontVariationValues(projectOrText, maybeText);
  const entries = Object.entries(settings);
  return entries.length
    ? entries.map(([tag, value]) => `${quoteCssFontFamily(tag)} ${value}`).join(", ")
    : "normal";
}

export function quoteCssFontFamily(value) {
  const escaped = String(value || DEFAULT_FONT_FAMILY)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\n\r\f]/g, " ");
  return `"${escaped}"`;
}

export function textCssFontFamily(project, text) {
  const family = textFontFamily(project, text);
  return family === DEFAULT_FONT_FAMILY
    ? `${quoteCssFontFamily(DEFAULT_FONT_FAMILY)}, sans-serif`
    : `${quoteCssFontFamily(family)}, ${quoteCssFontFamily(DEFAULT_FONT_FAMILY)}, sans-serif`;
}

export function textCanvasFont(project, text, size) {
  const numericSize = Number(size);
  const fontSize = Number.isFinite(numericSize) && numericSize > 0 ? numericSize : 1;
  return `${textFontStyle(project, text)} ${textFontWeight(project, text)} ${fontSize}px ${quoteCssFontFamily(textFontFamily(project, text))}`;
}

export function textFontLabel(project, text) {
  const font = projectFontForText(project, text);
  return font
    ? normalizedString(font.fullName, font.family || "Local font", 320)
    : normalizedString(text?.fontFamily, DEFAULT_FONT_FAMILY, 320);
}

export function applyProjectFontToText(project, text, fontIdOrNull) {
  if (!text || typeof text !== "object") throw new TypeError("A text layer is required.");
  if (fontIdOrNull == null || fontIdOrNull === "") {
    delete text.fontId;
    delete text.fontVariationSettings;
    text.fontFamily = DEFAULT_FONT_FAMILY;
    text.fontWeight = DEFAULT_FONT_WEIGHT;
    text.fontStyle = DEFAULT_FONT_STYLE;
    return text;
  }
  const fontId = normalizedString(fontIdOrNull, "", 180);
  const font = (project?.fonts || []).find((candidate) => candidate?.id === fontId);
  if (!font) {
    const error = new Error(`[FONT_NOT_FOUND] Project font not found: ${fontId}`);
    error.code = "FONT_NOT_FOUND";
    error.fontId = fontId;
    throw error;
  }
  text.fontId = font.id;
  text.fontFamily = normalizedString(font.family, DEFAULT_FONT_FAMILY, 256);
  text.fontWeight = normalizedFontWeight(font.weight, 400);
  text.fontStyle = font.italic ? "italic" : DEFAULT_FONT_STYLE;
  delete text.fontVariationSettings;
  return text;
}

function registrationKey(font) {
  return font.cssFamily || cssFamilyForId(font.id);
}

function registrationSignature(font) {
  return [
    font.id,
    font.fingerprint,
    font.dataRevision,
    font.weight,
    font.italic ? "italic" : "normal",
    font.fontData?.length || 0,
  ].join(":");
}

function fontFaceWeightDescriptor(font) {
  const weightAxis = font.variableAxes?.find((axis) => axis.tag === "wght");
  if (!weightAxis) return String(normalizedFontWeight(font.weight, 400));
  return `${clamp(weightAxis.min, 1, 1000)} ${clamp(weightAxis.max, 1, 1000)}`;
}

function fontUnavailableError(font, text = null, cause = null) {
  const label = normalizedString(font?.fullName || text?.fontFamily, font?.family || text?.fontId || "This font", 320);
  const error = new Error(`[FONT_UNAVAILABLE] ${label} is not available on this device.`);
  error.code = "FONT_UNAVAILABLE";
  error.fontId = font?.id || text?.fontId || null;
  error.fontLabel = label;
  if (cause) error.cause = cause;
  return error;
}

function fontDataArrayBuffer(dataUrl) {
  if (!isFontDataUrl(dataUrl)) throw new TypeError("Stored font data is missing or invalid.");
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1).replace(/\s+/g, "");
  let decoded;
  try {
    decoded = globalThis.atob(payload);
  } catch (error) {
    throw new TypeError(`Stored font data could not be decoded: ${error.message}`);
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

async function registerProjectFont(font) {
  const key = registrationKey(font);
  const signature = registrationSignature(font);
  const existing = fontRegistrations.get(key);
  if (existing?.signature === signature) {
    if (existing.status === "loaded") return existing.face;
    if (existing.status === "loading") return existing.promise;
    throw existing.error;
  }

  const fontSet = globalThis.document?.fonts;
  const FontFaceConstructor = globalThis.FontFace;
  if (!fontSet?.add || typeof FontFaceConstructor !== "function") {
    const error = fontUnavailableError(font, null, new Error("The browser FontFace API is unavailable."));
    fontRegistrations.set(key, { signature, status: "missing", error });
    throw error;
  }

  if (existing?.face && typeof fontSet.delete === "function") fontSet.delete(existing.face);
  const registration = { signature, status: "loading", face: null, error: null, promise: null };
  registration.promise = (async () => {
    try {
      const face = new FontFaceConstructor(font.cssFamily, fontDataArrayBuffer(font.fontData), {
        weight: fontFaceWeightDescriptor(font),
        style: font.italic ? "italic" : DEFAULT_FONT_STYLE,
      });
      const loadedFace = await face.load();
      if (loadedFace?.status !== "loaded" && face.status !== "loaded") {
        throw new Error(`FontFace finished with status ${loadedFace?.status || face.status || "unknown"}.`);
      }
      fontSet.add(loadedFace || face);
      registration.face = loadedFace || face;
      registration.status = "loaded";
      return registration.face;
    } catch (cause) {
      registration.status = "missing";
      registration.error = fontUnavailableError(font, null, cause);
      throw registration.error;
    }
  })();
  fontRegistrations.set(key, registration);
  return registration.promise;
}

export function isTextFontAvailable(project, text) {
  if (!text?.fontId) return true;
  const font = projectFontForText(project, text);
  return isProjectFontAvailable(project, font);
}

export function isTextFontLoaded(project, text) {
  if (!text?.fontId) return true;
  const font = projectFontForText(project, text);
  if (!font) return false;
  const registration = fontRegistrations.get(registrationKey(font));
  return registration?.signature === registrationSignature(font) && registration.status === "loaded";
}

export function isProjectFontAvailable(project, font) {
  if (!font || !project?.fonts?.some((candidate) => candidate?.id === font.id)) return false;
  const registration = fontRegistrations.get(registrationKey(font));
  if (registration?.signature !== registrationSignature(font)) return isFontDataUrl(font.fontData);
  if (registration?.status === "missing") return false;
  return registration?.status === "loaded" || isFontDataUrl(font.fontData);
}

function allProjectTextLayers(project) {
  return (project?.slides || []).flatMap((slide) => Array.isArray(slide?.texts) ? slide.texts : []);
}

async function ensureDefaultFontLoaded(textLayers) {
  if (!textLayers.some((text) => !text?.fontId)) return;
  const fontSet = globalThis.document?.fonts;
  if (!fontSet?.load) return;
  await fontSet.load(`${DEFAULT_FONT_WEIGHT} 64px ${quoteCssFontFamily(DEFAULT_FONT_FAMILY)}`);
  if (fontSet.ready) await fontSet.ready;
}

export async function ensureProjectFontsLoaded(project, textLayers = undefined) {
  normalizeProjectFonts(project);
  const layers = Array.isArray(textLayers) ? textLayers : allProjectTextLayers(project);
  await ensureDefaultFontLoaded(layers);

  const fonts = new Map();
  const missing = [];
  for (const text of layers) {
    if (!text?.fontId || fonts.has(text.fontId)) continue;
    const font = projectFontForText(project, text);
    if (!font) {
      missing.push(fontUnavailableError(null, text));
      continue;
    }
    fonts.set(text.fontId, font);
  }

  const results = await Promise.allSettled([...fonts.values()].map(registerProjectFont));
  results.forEach((result) => {
    if (result.status === "rejected") missing.push(result.reason);
  });
  if (missing.length) {
    const error = missing[0];
    error.missingFonts = missing.map((item) => ({
      fontId: item.fontId || null,
      label: item.fontLabel,
    }));
    throw error;
  }
  return {
    loadedFontIds: [...fonts.keys()],
    missingFonts: [],
  };
}
