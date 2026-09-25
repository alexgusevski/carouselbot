// Shares are untrusted documents. Copy only the editor's data fields, never
// arbitrary properties supplied by the sender. Rendering still escapes local data.
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const string = (max) => (value) => typeof value === "string" && value.length <= max;
const number = (min, max) => (value) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const choice = (...values) => (value) => values.includes(value);
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const color = (value) => typeof value === "string" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value);
const ratio = (value) => typeof value === "string" && /^\d{1,6}(?:\.\d{1,6})?:\d{1,6}(?:\.\d{1,6})?$/.test(value)
  && value.split(":").every((part) => Number(part) > 0);
const axisTag = (value) => /^[a-zA-Z0-9 ]{4}$/.test(value);

export function isEmbeddedMedia(value, kind) {
  if (typeof value !== "string") return false;
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const header = value.slice(0, comma).toLowerCase();
  const payload = value.slice(comma + 1);
  if (kind === "image" && /^data:image\/svg\+xml(?:;charset=utf-8)?$/.test(header)) {
    // The editor's solid backgrounds use percent-encoded SVG, not base64.
    if (!payload || /[<>"\s]/.test(payload)) return false;
    try { decodeURIComponent(payload); return true; } catch { return false; }
  }
  const types = {
    image: /^data:image\/(?:png|jpeg|jpg|webp|gif|avif|svg\+xml);base64$/,
    video: /^data:video\/(?:mp4|webm|quicktime|ogg);base64$/,
    font: /^data:(?:font\/(?:ttf|otf|woff2?)|application\/(?:octet-stream|x-font-ttf|x-font-opentype|font-woff));base64$/,
  };
  return types[kind]?.test(header) && payload.length > 0 && payload.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(payload);
}

const media = {
  id, name: string(512), imageData: (v) => v === "" || isEmbeddedMedia(v, "image"),
  videoData: (v) => v === "" || isEmbeddedMedia(v, "video"),
  width: number(1, 32768), height: number(1, 32768), duration: number(0, 3600),
};
const geometry = {
  id, x: number(-100, 100), y: number(-100, 100), width: number(0.000001, 100),
  height: number(0.000001, 100), rotation: number(-360000, 360000), z: number(-100000, 100000),
};
const textFields = {
  ...geometry, text: string(10000), size: number(1, 1000), role: string(80),
  style: choice("plain", "outline", "boxed"), color, outlineWidth: number(0, 100),
  background: choice("white", "black"), backgroundShape: choice("lines", "full"),
  align: choice("left", "center", "right"), fontId: id, fontFamily: string(256),
  fontWeight: number(1, 1000), fontStyle: choice("normal", "italic"),
};
const overlayFields = {
  ...geometry, assetId: id, cropX: number(0, 1), cropY: number(0, 1),
  cropW: number(0.000001, 1), cropH: number(0.000001, 1),
};
const fontFields = {
  id, source: choice("local"), localFontId: string(512), family: string(256), fullName: string(320),
  postscriptName: string(256), subfamily: string(160), weight: number(1, 1000),
  italic: choice(true, false), cssFamily: string(256), fingerprint: string(512), dataRevision: string(512),
  addedAt: number(0, Number.MAX_SAFE_INTEGER), fontData: (v) => isEmbeddedMedia(v, "font"),
};
function copy(value, fields, required = ["id"]) {
  if (!object(value) || required.some((key) => !Object.hasOwn(value, key))) throw new Error("Invalid project field.");
  const result = {};
  for (const [key, validate] of Object.entries(fields)) {
    if (value[key] == null) continue;
    if (!validate(value[key])) throw new Error(`Invalid project field: ${key}.`);
    result[key] = value[key];
  }
  if (required.some((key) => !Object.hasOwn(result, key))) throw new Error("Missing project field.");
  return result;
}
function list(values, max, convert) {
  if (!Array.isArray(values) || values.length > max) throw new Error("Too many project items.");
  const items = values.map(convert);
  if (items.some((item) => item.id) && new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Duplicate project IDs.");
  return items;
}
export function validateSharedProject(value) {
  const project = copy(value, { id, name: (v) => string(160)(v) && v.trim().length > 0,
    aspectRatio: ratio, folderPath: string(512), createdAt: number(0, Number.MAX_SAFE_INTEGER),
    updatedAt: number(0, Number.MAX_SAFE_INTEGER), revision: number(0, Number.MAX_SAFE_INTEGER),
  }, ["id", "name"]);
  project.assets = list(value.assets, 300, (asset) => copy(asset, media));
  project.fonts = list(value.fonts || [], 50, (font) => {
    const result = copy(font, fontFields);
    result.variableAxes = list(font.variableAxes || [], 32, (axis) => {
      const item = copy(axis, { tag: axisTag, name: string(120), min: number(-1e6, 1e6), max: number(-1e6, 1e6), default: number(-1e6, 1e6) }, ["tag", "min", "max", "default"]);
      if (item.min > item.max || item.default < item.min || item.default > item.max) throw new Error("Invalid font axis.");
      return item;
    });
    return result;
  });
  let layers = 0;
  let characters = 0;
  project.slides = list(value.slides, 100, (slide) => {
    const result = copy(slide, { ...media, aspectRatio: ratio, backgroundColor: color,
      imageScale: number(0.000001, 100), imageX: number(-100, 100), imageY: number(-100, 100),
    });
    result.texts = list(slide.texts || [], 100, (text) => {
      const item = copy(text, textFields);
      characters += item.text?.length || 0;
      if (text.fontVariationSettings != null) {
        if (!object(text.fontVariationSettings) || Object.keys(text.fontVariationSettings).length > 32) throw new Error("Invalid font variations.");
        item.fontVariationSettings = {};
        for (const [tag, setting] of Object.entries(text.fontVariationSettings)) {
          if (!axisTag(tag) || !number(-1e6, 1e6)(setting)) throw new Error("Invalid font variation.");
          item.fontVariationSettings[tag] = setting;
        }
      }
      return item;
    });
    result.overlays = list(slide.overlays || [], 100, (overlay) => copy(overlay, overlayFields, ["id", "assetId"]));
    if (result.overlays.some((overlay) => !project.assets.some((asset) => asset.id === overlay.assetId))) throw new Error("Missing overlay asset.");
    layers += result.texts.length + result.overlays.length;
    if (layers > 1000 || characters > 100000) throw new Error("This project has too many layers or text.");
    return result;
  });
  // Preserve omission of optional fonts for existing share documents.
  if (!Object.hasOwn(value, "fonts")) delete project.fonts;
  return project;
}
