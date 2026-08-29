import {
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  layerKey,
  parseLayerKey,
  overlayCrop,
  layerStageInset,
  slideItems,
  getImageLayout,
  clamp,
} from "./editor-model.mjs";

export const state = {
  projects: [],
  activeProjectId: null,
  activeSlideId: null,
  selectedTextId: null,
  selectedOverlayId: null,
  selectedLayerKeys: [],
  db: null,
  stageWidth: 0,
  stageHeight: 0,
  canvasZoom: 1,
  saveTimer: null,
  toastTimer: null,
  mobileInspectorOpen: false,
  photoAdjustMode: false,
  showTikTokOverlay: false,
  draggingAssetId: null,
  draggingSlideId: null,
  slideDragGhost: null,
  thumbnailRefreshTimer: null,
  thumbnailUrls: new Map(),
  thumbnailSignatures: new Map(),
  thumbnailVersions: new Map(),
  projectCoverUrls: new Map(),
  projectCoverSignatures: new Map(),
  projectCoverVersions: new Map(),
  slideRailScrollPositions: new Map(),
  pendingSlideBackgroundTarget: null,
  croppingOverlayId: null,
  pasteBusy: false,
  fileDropBusy: false,
  copiedLayer: null,
  shareAllCache: null,
};

export const history = {
  past: [],
  future: [],
  applying: false,
};

export const app = document.querySelector("#app");

export function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

export function activeSlide() {
  return activeProject()?.slides.find((slide) => slide.id === state.activeSlideId) || null;
}

export function selectedText() {
  return activeSlide()?.texts.find((text) => text.id === state.selectedTextId) || null;
}

export function selectedOverlay() {
  return activeSlide()?.overlays?.find((overlay) => overlay.id === state.selectedOverlayId) || null;
}

export function selectedLayerKeys() {
  return Array.isArray(state.selectedLayerKeys) ? state.selectedLayerKeys : [];
}

export function isLayerSelected(kind, id) {
  return selectedLayerKeys().includes(layerKey(kind, id));
}

export function selectedLayers() {
  const slide = activeSlide();
  if (!slide) return [];
  return selectedLayerKeys().flatMap((key) => {
    const { kind, id } = parseLayerKey(key);
    const item = kind === "text"
      ? slide.texts.find((text) => text.id === id)
      : (slide.overlays || []).find((overlay) => overlay.id === id);
    return item ? [{ kind, item, key }] : [];
  });
}

export function setLayerSelection(keys, primaryKey = keys.at(-1) || null) {
  const validKeys = new Set(slideItems(activeSlide() || { texts: [], overlays: [] })
    .map(({ kind, item }) => layerKey(kind, item.id)));
  state.selectedLayerKeys = [...new Set(keys)].filter((key) => validKeys.has(key));
  const primary = state.selectedLayerKeys.includes(primaryKey)
    ? parseLayerKey(primaryKey)
    : state.selectedLayerKeys.length
      ? parseLayerKey(state.selectedLayerKeys.at(-1))
      : null;
  state.selectedTextId = primary?.kind === "text" ? primary.id : null;
  state.selectedOverlayId = primary?.kind === "overlay" ? primary.id : null;
}

export function selectOnlyLayer(kind, id) {
  const key = layerKey(kind, id);
  setLayerSelection([key], key);
}

export function toggleLayerSelection(kind, id) {
  const key = layerKey(kind, id);
  const keys = selectedLayerKeys();
  if (keys.includes(key)) setLayerSelection(keys.filter((item) => item !== key));
  else setLayerSelection([...keys, key], key);
}

export function projectAsset(assetId) {
  return activeProject()?.assets?.find((asset) => asset.id === assetId) || null;
}

export function getOverlayMetrics(overlay, asset = projectAsset(overlay.assetId), { full = false } = {}) {
  const cropping = !full && state.croppingOverlayId === overlay.id;
  const crop = full || cropping ? { w: 1, h: 1 } : overlayCrop(overlay);
  const srcW = (asset?.width || 1) * crop.w;
  const srcH = (asset?.height || 1) * crop.h;
  const aspect = srcW ? srcH / srcW : 1;
  const width = overlay.width;
  const naturalHeight = width * (OUTPUT_WIDTH / OUTPUT_HEIGHT) * aspect;
  const height = Number.isFinite(Number(overlay.height)) ? Number(overlay.height) : naturalHeight;
  return { width, height };
}

export function overlayStageInset(overlay, asset = projectAsset(overlay.assetId)) {
  const metrics = getOverlayMetrics(overlay, asset);
  return layerStageInset(overlay.x, overlay.y, metrics.width, metrics.height);
}

export function overlayClipCss(overlay, asset) {
  const inset = overlayStageInset(overlay, asset);
  return `inset(${inset.top * 100}% ${inset.right * 100}% ${inset.bottom * 100}% ${inset.left * 100}%)`;
}

export function constrainOverlay(overlay, asset = projectAsset(overlay.assetId)) {
  if (!asset) return overlay;
  overlay.width = clamp(Number(overlay.width) || 0.34, 0.04, 2.4);
  const crop = overlayCrop(overlay);
  const naturalHeight = overlay.width * (OUTPUT_WIDTH / OUTPUT_HEIGHT) * (((asset.height || 1) * crop.h) / ((asset.width || 1) * crop.w));
  overlay.height = clamp(Number(overlay.height) || naturalHeight, 0.025, 2.4);
  overlay.rotation = ((Number(overlay.rotation) || 0) % 360 + 360) % 360;
  return overlay;
}

export function constrainImagePosition(slide) {
  const canvasWidth = state.stageWidth || OUTPUT_WIDTH;
  const canvasHeight = state.stageHeight || OUTPUT_HEIGHT;
  const layout = getImageLayout(slide, canvasWidth, canvasHeight);
  slide.imageX = clamp(slide.imageX || 0, -layout.maxOffsetX, layout.maxOffsetX);
  slide.imageY = clamp(slide.imageY || 0, -layout.maxOffsetY, layout.maxOffsetY);
}
