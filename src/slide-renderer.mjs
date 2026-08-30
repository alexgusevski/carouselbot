import {
  DESIGN_WIDTH,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  OUTLINE_RATIO,
  TEXT_WEIGHT,
  TEXT_LINE_HEIGHT,
  BOX_TEXT_LINE_HEIGHT,
  BOX_LINE_HEIGHT,
  BOX_HORIZONTAL_PADDING,
  BOX_BACKGROUND_VERTICAL_OFFSET,
  TEXT_BOX_EDGE_PADDING,
  BOX_CORNER_RADIUS,
  textColor,
  outlineColorFor,
  overlayCrop,
  textAlignment,
  slideItems,
  getImageLayout,
  perLineBackgroundSvgPath,
  wrapText,
} from "./editor-model.mjs";
import { activeProject, getOverlayMetrics } from "./editor-state.mjs";

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render thumbnail")), "image/png", 1);
  });
}

export function getImageDimensions(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error("Image has no dimensions"));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = reject;
    image.src = src;
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

export async function renderSlideCanvas(slide, width = OUTPUT_WIDTH, height = OUTPUT_HEIGHT, project = activeProject()) {
  await document.fonts.load(`${TEXT_WEIGHT} 64px "TikTok Sans"`);
  const image = await loadImage(slide.imageData);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const imageLayout = getImageLayout(slide, width, height);
  context.drawImage(image, imageLayout.left, imageLayout.top, imageLayout.width, imageLayout.height);
  await drawSlideLayers(context, slide, width, height, project);
  return canvas;
}

export async function drawSlideLayers(context, slide, canvasWidth, canvasHeight, project = activeProject()) {
  for (const { kind, item } of slideItems(slide)) {
    if (kind === "overlay") await drawOneOverlay(context, item, canvasWidth, canvasHeight, project);
    else drawTextLayer(context, item, canvasWidth, canvasHeight);
  }
}

export async function drawOneOverlay(context, overlay, canvasWidth, canvasHeight, project = activeProject()) {
  const asset = project?.assets?.find((item) => item.id === overlay.assetId);
  if (!asset) return;
  const image = await loadImage(asset.imageData);
  const metrics = getOverlayMetrics(overlay, asset);
  const width = metrics.width * canvasWidth;
  const height = metrics.height * canvasHeight;
  const x = overlay.x * canvasWidth;
  const y = overlay.y * canvasHeight;
  const crop = overlayCrop(overlay);
  const sx = crop.x * image.naturalWidth;
  const sy = crop.y * image.naturalHeight;
  const sw = Math.max(1, crop.w * image.naturalWidth);
  const sh = Math.max(1, crop.h * image.naturalHeight);
  context.save();
  context.translate(x + width / 2, y + height / 2);
  context.rotate(((overlay.rotation || 0) * Math.PI) / 180);
  context.drawImage(image, sx, sy, sw, sh, -width / 2, -height / 2, width, height);
  context.restore();
}

export function drawTextLayer(context, text, imageWidth, imageHeight) {
  const width = text.width * imageWidth;
  const height = text.height * imageHeight;
  const centerX = (text.x + text.width / 2) * imageWidth;
  const centerY = (text.y + text.height / 2) * imageHeight;
  const x = -width / 2;
  const y = -height / 2;
  const exportScale = imageWidth / DESIGN_WIDTH;
  const fontSize = text.size * exportScale;
  const align = textAlignment(text);
  const perLineBox = text.style === "boxed" && text.backgroundShape !== "full";
  const lineHeight = fontSize * (perLineBox ? BOX_TEXT_LINE_HEIGHT : TEXT_LINE_HEIGHT);
  const horizontalPadding = fontSize * BOX_HORIZONTAL_PADDING;
  const edgePadding = perLineBox ? fontSize * TEXT_BOX_EDGE_PADDING : 0;
  const verticalPadding = fontSize * 0.1;
  const color = textColor(text);
  context.save();
  context.translate(centerX, centerY);
  context.rotate(((text.rotation || 0) * Math.PI) / 180);
  context.font = `${TEXT_WEIGHT} ${fontSize}px "TikTok Sans"`;
  context.textAlign = align;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineCap = "round";
  const wrapInset = perLineBox ? (edgePadding + horizontalPadding) * 2 : fontSize * 0.32;
  const lines = wrapText(context, text.text, Math.max(1, width - wrapInset));
  const visibleLineCount = Math.max(1, Math.floor((height - verticalPadding * 2) / lineHeight));
  const visibleLines = lines.slice(0, visibleLineCount);
  const blockHeight = visibleLines.length * lineHeight;
  const startY = y + (height - blockHeight) / 2 + lineHeight / 2;
  const innerWidth = width - edgePadding * 2;
  const pillWidths = visibleLines.map((line) => Math.min(innerWidth, context.measureText(line || " ").width + horizontalPadding * 2));
  const alignedTextInset = perLineBox ? horizontalPadding : fontSize * 0.16;
  const contentLeft = x + edgePadding;
  const contentRight = x + width - edgePadding;
  const textX = align === "left" ? contentLeft + alignedTextInset : align === "right" ? contentRight - alignedTextInset : x + width / 2;

  if (text.style === "boxed" && text.backgroundShape === "full") {
    context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
    roundedRect(context, x, y, width, height, Math.min(fontSize * 0.18, width / 2, height / 2));
    context.fill();
  }

  if (perLineBox) {
    const backgroundHeight = fontSize * BOX_LINE_HEIGHT;
    const radius = Math.min(fontSize * BOX_CORNER_RADIUS, backgroundHeight / 2);
    context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
    const backgroundPath = perLineBackgroundSvgPath(
      pillWidths,
      lineHeight,
      backgroundHeight,
      contentLeft,
      innerWidth,
      align,
      radius,
      startY - backgroundHeight / 2 + fontSize * BOX_BACKGROUND_VERTICAL_OFFSET,
    );
    context.fill(new Path2D(backgroundPath));
  }

  visibleLines.forEach((line, index) => {
    const lineY = startY + index * lineHeight;
    if (text.style === "outline") {
      context.strokeStyle = outlineColorFor(color);
      context.lineWidth = fontSize * OUTLINE_RATIO;
      context.strokeText(line, textX, lineY);
      context.fillStyle = color;
      context.fillText(line, textX, lineY);
    } else {
      context.fillStyle = color;
      context.fillText(line, textX, lineY);
    }
  });
  context.restore();
}

export function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

export async function fingerprintData(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
