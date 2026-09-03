import { normalizeHexColor, slideCanvasDimensions } from "./editor-model.mjs";

export function solidBackgroundDataUrl(color = "#EEEDE7", project = null, slide = null) {
  const fill = normalizeHexColor(color, "#EEEDE7");
  const canvas = slideCanvasDimensions(project, slide);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><rect width="100%" height="100%" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function canonicalSolidBackgroundColor(slide, project = null) {
  const color = normalizeHexColor(slide?.backgroundColor);
  return color && slide?.imageData === solidBackgroundDataUrl(color, project, slide) ? color : null;
}
