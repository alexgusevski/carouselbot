export const DESIGN_WIDTH = 1080;

export const OUTPUT_WIDTH = 1080;

export const OUTPUT_HEIGHT = 1920;

export const INITIAL_OVERLAY_MAX_SIZE = 0.82;

export const DEFAULT_OUTLINE_WIDTH = 12;

export const OUTLINE_RATIO = 0.17;

export const TEXT_WEIGHT = 500;

export const TEXT_LINE_HEIGHT = 1.12;

export const CLIPBOARD_LAYER_TYPE = "application/x-carouselbot-layer";

export const LEGACY_CLIPBOARD_LAYER_TYPE = "application/x-slide-studio-layer";

export const CLIPBOARD_STORAGE_KEY = "carouselbot-layer-clipboard";

export const LEGACY_CLIPBOARD_STORAGE_KEY = "slide-studio-layer-clipboard";

export const HISTORY_LIMIT = 200;

export const BOX_TEXT_LINE_HEIGHT = 1.24;

export const BOX_LINE_HEIGHT = 1.5;

export const BOX_HORIZONTAL_PADDING = 0.45;

export const BOX_BACKGROUND_VERTICAL_OFFSET = 0.03;

export const TEXT_BOX_EDGE_PADDING = 0.3;

export const BOX_CORNER_RADIUS = 0.225;

export const FONT_SIZE_MIN = 20;

export const FONT_SIZE_MAX = 180;

export const FONT_SIZE_SLIDER_MAX = 1000;

export const FONT_SIZE_SLIDER_STEP = 10;

export const CANVAS_ZOOM_MIN = 0.2;

export const CANVAS_ZOOM_MAX = 3;

export const FONT_SIZE_SLIDER_STOPS = [
  { position: 0, size: FONT_SIZE_MIN },
  { position: 220, size: 40 },
  { position: 780, size: 70 },
  { position: FONT_SIZE_SLIDER_MAX, size: FONT_SIZE_MAX },
];

export const TEXT_COLOR_PRESETS = [
  { name: "White", value: "#FFFFFF" },
  { name: "Black", value: "#111111" },
  { name: "Yellow", value: "#FFE45E" },
  { name: "Pink", value: "#FE2C55" },
  { name: "Cyan", value: "#25F4EE" },
  { name: "Blue", value: "#4D7CFE" },
  { name: "Green", value: "#35D07F" },
  { name: "Purple", value: "#A855F7" },
];

export function cloneProject(project) {
  return {
    ...project,
    assets: (project.assets || []).map((asset) => ({ ...asset })),
    fonts: (project.fonts || []).map((font) => ({
      ...font,
      variableAxes: (font.variableAxes || []).map((axis) => ({ ...axis })),
    })),
    slides: (project.slides || []).map((slide) => ({
      ...slide,
      texts: (slide.texts || []).map((text) => ({
        ...text,
        ...(text.fontVariationSettings ? { fontVariationSettings: { ...text.fontVariationSettings } } : {}),
      })),
      overlays: (slide.overlays || []).map((overlay) => ({ ...overlay })),
    })),
  };
}

export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export function projectPath(projectId) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function routeFromPathname(pathname = window.location.pathname) {
  if (pathname === "/" || pathname === "/index.html") return { view: "dashboard" };
  const match = pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (!match) return { view: "not-found" };
  try {
    return { view: "project", projectId: decodeURIComponent(match[1]) };
  } catch {
    return { view: "not-found" };
  }
}

export function adjacentSlideId(slides, activeSlideId, offset) {
  if (!Array.isArray(slides) || !slides.length) return null;
  const activeIndex = slides.findIndex((slide) => slide.id === activeSlideId);
  if (activeIndex < 0) return null;
  const direction = Math.sign(Number(offset) || 0);
  const nextIndex = clamp(activeIndex + direction, 0, slides.length - 1);
  return slides[nextIndex]?.id || null;
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeHexColor(value, fallback = null) {
  let hex = String(value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split("").map((character) => character + character).join("");
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : fallback;
}

export function textColor(text) {
  const legacyDefault = text?.style === "boxed" && text?.background !== "black" ? "#111111" : "#FFFFFF";
  return normalizeHexColor(text?.color, legacyDefault);
}

export function hexToRgb(hex) {
  const value = normalizeHexColor(hex, "#FFFFFF").slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHex(value) {
  const channels = String(value || "").match(/-?\d+(?:\.\d+)?/g);
  if (!channels || channels.length !== 3) return null;
  const hex = channels
    .map((channel) => Math.round(clamp(Number(channel), 0, 255)).toString(16).padStart(2, "0"))
    .join("");
  return normalizeHexColor(hex);
}

export function formatRgb(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

export function outlineColorFor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#FFFFFF";
}

export function ensureBoxedTextContrast(text) {
  if (text?.style !== "boxed") return;
  const backgroundColor = text.background === "black" ? "#111111" : "#FFFFFF";
  if (textColor(text) === backgroundColor) text.color = outlineColorFor(backgroundColor);
}

export function layerKey(kind, id) {
  return `${kind}:${id}`;
}

export function parseLayerKey(key) {
  const separator = key.indexOf(":");
  return { kind: key.slice(0, separator), id: key.slice(separator + 1) };
}

export function overlayCrop(overlay) {
  const x = clamp(Number(overlay.cropX) || 0, 0, 0.95);
  const y = clamp(Number(overlay.cropY) || 0, 0, 0.95);
  const w = clamp(Number(overlay.cropW) || 1, 0.05, 1 - x);
  const h = clamp(Number(overlay.cropH) || 1, 0.05, 1 - y);
  return { x, y, w, h };
}

export function textAlignment(text) {
  return ["left", "center", "right"].includes(text?.align) ? text.align : "center";
}

export function layerStageInset(x, y, width, height) {
  if (!width || !height) return { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    top: Math.max(0, -y / height),
    right: Math.max(0, (x + width - 1) / width),
    bottom: Math.max(0, (y + height - 1) / height),
    left: Math.max(0, -x / width),
  };
}

export function layerClipCss(x, y, width, height) {
  const inset = layerStageInset(x, y, width, height);
  return `inset(${inset.top * 100}% ${inset.right * 100}% ${inset.bottom * 100}% ${inset.left * 100}%)`;
}

export function initialOverlayWidth(asset) {
  const sourceWidth = Number(asset?.width);
  const sourceHeight = Number(asset?.height);
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    return 0.34;
  }
  const naturalWidth = sourceWidth / OUTPUT_WIDTH;
  const naturalHeight = sourceHeight / OUTPUT_HEIGHT;
  const fitScale = Math.min(
    1,
    INITIAL_OVERLAY_MAX_SIZE / naturalWidth,
    INITIAL_OVERLAY_MAX_SIZE / naturalHeight,
  );
  return clamp(naturalWidth * fitScale, 0.04, INITIAL_OVERLAY_MAX_SIZE);
}

export function slideItems(slide) {
  const overlays = (slide.overlays || []).map((item) => ({ kind: "overlay", item }));
  const texts = (slide.texts || []).map((item) => ({ kind: "text", item }));
  return [...overlays, ...texts].sort((a, b) => (Number(a.item.z) || 0) - (Number(b.item.z) || 0));
}

export function nextLayerZ(slide) {
  const items = slideItems(slide);
  if (!items.length) return 1;
  return Math.max(...items.map(({ item }) => Number(item.z) || 0)) + 1;
}

export function interpolateFontSizeControl(value, inputKey, outputKey) {
  const first = FONT_SIZE_SLIDER_STOPS[0];
  const last = FONT_SIZE_SLIDER_STOPS.at(-1);
  const numericValue = Number(value);
  const boundedValue = clamp(
    Number.isFinite(numericValue) ? numericValue : first[inputKey],
    first[inputKey],
    last[inputKey],
  );
  const upperIndex = FONT_SIZE_SLIDER_STOPS.findIndex((stop) => boundedValue <= stop[inputKey]);
  if (upperIndex <= 0) return first[outputKey];
  const lower = FONT_SIZE_SLIDER_STOPS[upperIndex - 1];
  const upper = FONT_SIZE_SLIDER_STOPS[upperIndex];
  const progress = (boundedValue - lower[inputKey]) / (upper[inputKey] - lower[inputKey]);
  return lower[outputKey] + (upper[outputKey] - lower[outputKey]) * progress;
}

export function fontSizeFromSliderPosition(position) {
  return Math.round(interpolateFontSizeControl(position, "position", "size") * 2) / 2;
}

export function sliderPositionFromFontSize(size) {
  const position = interpolateFontSizeControl(size, "size", "position");
  return Math.round(position / FONT_SIZE_SLIDER_STEP) * FONT_SIZE_SLIDER_STEP;
}

export function formatFontSize(size) {
  const value = Math.round(clamp(Number(size) || FONT_SIZE_MIN, FONT_SIZE_MIN, FONT_SIZE_MAX) * 2) / 2;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function getImageLayout(slide, canvasWidth, canvasHeight) {
  const zoom = slide.imageScale || 1;
  const coverScale = Math.max(canvasWidth / slide.width, canvasHeight / slide.height);
  const scale = coverScale * zoom;
  const width = slide.width * scale;
  const height = slide.height * scale;
  const maxOffsetX = Math.max(0, (width - canvasWidth) / (2 * canvasWidth));
  const maxOffsetY = Math.max(0, (height - canvasHeight) / (2 * canvasHeight));
  const offsetX = clamp(slide.imageX || 0, -maxOffsetX, maxOffsetX);
  const offsetY = clamp(slide.imageY || 0, -maxOffsetY, maxOffsetY);
  return {
    width,
    height,
    left: (canvasWidth - width) / 2 + offsetX * canvasWidth,
    top: (canvasHeight - height) / 2 + offsetY * canvasHeight,
    maxOffsetX,
    maxOffsetY,
  };
}

export function normalizePerLineBackgroundWidths(widths, align, radius) {
  const normalized = [...widths];
  const boundaryScale = align === "center" ? 0.5 : 1;
  let changed = true;

  // TikTok merges near-equal neighboring rows when the step cannot hold two
  // full-radius corners. This preserves one radius instead of pinching it.
  while (changed) {
    changed = false;
    for (let index = 0; index < normalized.length - 1; index += 1) {
      const boundaryGap = Math.abs(normalized[index] - normalized[index + 1]) * boundaryScale;
      if (boundaryGap <= 0.01 || boundaryGap > radius * 2 + 0.01) continue;
      const mergedWidth = Math.max(normalized[index], normalized[index + 1]);
      if (normalized[index] !== mergedWidth || normalized[index + 1] !== mergedWidth) changed = true;
      normalized[index] = mergedWidth;
      normalized[index + 1] = mergedWidth;
    }
  }
  return normalized;
}

function appendRightLineBackgroundTransition(path, current, next, middleY, radius) {
  const difference = next - current;
  if (Math.abs(difference) <= 0.01) return;
  const horizontalDirection = Math.sign(difference);
  path.push(
    `V ${middleY - radius}`,
    `A ${radius} ${radius} 0 0 ${horizontalDirection < 0 ? 1 : 0} ${current + horizontalDirection * radius} ${middleY}`,
    `H ${next - horizontalDirection * radius}`,
    `A ${radius} ${radius} 0 0 ${horizontalDirection > 0 ? 1 : 0} ${next} ${middleY + radius}`,
  );
}

function appendLeftLineBackgroundTransition(path, current, next, middleY, radius) {
  const difference = next - current;
  if (Math.abs(difference) <= 0.01) return;
  const horizontalDirection = Math.sign(difference);
  path.push(
    `V ${middleY + radius}`,
    `A ${radius} ${radius} 0 0 ${horizontalDirection > 0 ? 1 : 0} ${current + horizontalDirection * radius} ${middleY}`,
    `H ${next - horizontalDirection * radius}`,
    `A ${radius} ${radius} 0 0 ${horizontalDirection < 0 ? 1 : 0} ${next} ${middleY - radius}`,
  );
}

function lineBackgroundTransitionY(widths, index, lineHeight, boxHeight, top) {
  const upperLineTop = top + index * lineHeight;

  // TikTok lets a wider upper row keep its full background depth before the
  // contour turns inward. That protects descenders (for example the final
  // "g" in "long") while preserving the existing placement when the next
  // row expands outward.
  return widths[index] > widths[index + 1]
    ? upperLineTop + boxHeight
    : upperLineTop + (boxHeight + lineHeight) / 2;
}

export function perLineBackgroundSvgPath(widths, lineHeight, boxHeight, contentLeft, contentWidth, align, radius, top = 0) {
  if (!widths.length) return "";
  const normalizedWidths = normalizePerLineBackgroundWidths(widths, align, radius);
  const bounds = normalizedWidths.map((width) => {
    const left = align === "left"
      ? contentLeft
      : align === "right"
        ? contentLeft + contentWidth - width
        : contentLeft + (contentWidth - width) / 2;
    return { left, right: left + width };
  });
  const first = bounds[0];
  const last = bounds.at(-1);
  const bottom = top + (widths.length - 1) * lineHeight + boxHeight;
  const cornerRadius = Math.min(radius, lineHeight / 2, boxHeight / 2, normalizedWidths[0] / 2, normalizedWidths.at(-1) / 2);
  const path = [
    `M ${first.left + cornerRadius} ${top}`,
    `H ${first.right - cornerRadius}`,
    `A ${cornerRadius} ${cornerRadius} 0 0 1 ${first.right} ${top + cornerRadius}`,
  ];

  for (let index = 0; index < bounds.length - 1; index += 1) {
    const middleY = lineBackgroundTransitionY(normalizedWidths, index, lineHeight, boxHeight, top);
    appendRightLineBackgroundTransition(path, bounds[index].right, bounds[index + 1].right, middleY, cornerRadius);
  }

  path.push(
    `V ${bottom - cornerRadius}`,
    `A ${cornerRadius} ${cornerRadius} 0 0 1 ${last.right - cornerRadius} ${bottom}`,
    `H ${last.left + cornerRadius}`,
    `A ${cornerRadius} ${cornerRadius} 0 0 1 ${last.left} ${bottom - cornerRadius}`,
  );

  for (let index = bounds.length - 2; index >= 0; index -= 1) {
    const middleY = lineBackgroundTransitionY(normalizedWidths, index, lineHeight, boxHeight, top);
    appendLeftLineBackgroundTransition(path, bounds[index + 1].left, bounds[index].left, middleY, cornerRadius);
  }

  path.push(
    `V ${top + cornerRadius}`,
    `A ${cornerRadius} ${cornerRadius} 0 0 1 ${first.left + cornerRadius} ${top}`,
    "Z",
  );
  return path.join(" ");
}

export function rotateDelta(dx, dy, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

export function applyCropValues(overlay, next) {
  const min = 0.05;
  let x = next.x;
  let y = next.y;
  let w = next.w;
  let h = next.h;
  if (w < min) {
    if (next.anchorX != null) x = next.anchorX - min;
    w = min;
  }
  if (h < min) {
    if (next.anchorY != null) y = next.anchorY - min;
    h = min;
  }
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  overlay.cropX = clamp(x, 0, 1 - min);
  overlay.cropY = clamp(y, 0, 1 - min);
  overlay.cropW = clamp(w, min, 1 - overlay.cropX);
  overlay.cropH = clamp(h, min, 1 - overlay.cropY);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function wrapText(context, value, maxWidth) {
  const paragraphs = String(value || " ").split("\n");
  const lines = [];
  paragraphs.forEach((paragraph) => {
    if (paragraph === "") {
      lines.push("");
      return;
    }
    const words = paragraph.split(/\s+/);
    let line = "";
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (context.measureText(test).width <= maxWidth) {
        line = test;
      } else if (line) {
        lines.push(line);
        line = word;
      } else {
        const characters = [...word];
        let chunk = "";
        characters.forEach((character) => {
          if (context.measureText(chunk + character).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = character;
          } else {
            chunk += character;
          }
        });
        line = chunk;
      }
    });
    lines.push(line);
  });
  return lines;
}

export function safeFilename(value) {
  return String(value || "slide")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "slide";
}

export function isEditingTextTarget(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable]"));
}

export function isCopiedLayer(value) {
  return Boolean(
    value
    && typeof value.token === "string"
    && value.token
    && Array.isArray(value.layers)
    && value.layers.length
    && value.layers.every((layer) => (
      layer
      && (layer.kind === "text" || layer.kind === "overlay")
      && layer.item
      && typeof layer.item === "object"
    )),
  );
}

export function parseCopiedLayer(value) {
  if (!value || !String(value).trim().startsWith("{")) return null;
  try {
    const copied = JSON.parse(value);
    return isCopiedLayer(copied) ? copied : null;
  } catch {
    return null;
  }
}

export function isImageFile(file) {
  if (!file) return false;
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name || "");
}
