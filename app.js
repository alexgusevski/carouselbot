const DB_NAME = "slide-studio-db";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const DESIGN_WIDTH = 1080;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const INITIAL_OVERLAY_MAX_SIZE = 0.82;
const DEFAULT_OUTLINE_WIDTH = 12;
const OUTLINE_RATIO = 0.17;
const TEXT_WEIGHT = 500;
const TEXT_LINE_HEIGHT = 1.12;
const CLIPBOARD_LAYER_TYPE = "application/x-slide-studio-layer";
const CLIPBOARD_STORAGE_KEY = "slide-studio-layer-clipboard";
const HISTORY_LIMIT = 200;
const BOX_TEXT_LINE_HEIGHT = 1.12;
const BOX_LINE_HEIGHT = 1.42;
const BOX_HORIZONTAL_PADDING = 0.52;
const BOX_CORNER_RADIUS = 0.27;
const BOX_JUNCTION_RADIUS = 0.18;
const FONT_SIZE_MIN = 20;
const FONT_SIZE_MAX = 180;
const FONT_SIZE_SLIDER_MAX = 1000;
const FONT_SIZE_SLIDER_STEP = 10;
const CANVAS_ZOOM_MIN = 0.2;
const CANVAS_ZOOM_MAX = 3;
const FONT_SIZE_SLIDER_STOPS = [
  { position: 0, size: FONT_SIZE_MIN },
  { position: 220, size: 40 },
  { position: 780, size: 70 },
  { position: FONT_SIZE_SLIDER_MAX, size: FONT_SIZE_MAX },
];
const TEXT_COLOR_PRESETS = [
  { name: "White", value: "#FFFFFF" },
  { name: "Black", value: "#111111" },
  { name: "Yellow", value: "#FFE45E" },
  { name: "Pink", value: "#FE2C55" },
  { name: "Cyan", value: "#25F4EE" },
  { name: "Blue", value: "#4D7CFE" },
  { name: "Green", value: "#35D07F" },
  { name: "Purple", value: "#A855F7" },
];

const state = {
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
  slideRailScrollPositions: new Map(),
  pendingSlideBackgroundTarget: null,
  croppingOverlayId: null,
  pasteBusy: false,
  fileDropBusy: false,
  copiedLayer: null,
  shareAllCache: null,
};

const history = {
  past: [],
  future: [],
  applying: false,
};

function cloneProject(project) {
  return {
    ...project,
    assets: (project.assets || []).map((asset) => ({ ...asset })),
    slides: (project.slides || []).map((slide) => ({
      ...slide,
      texts: (slide.texts || []).map((text) => ({ ...text })),
      overlays: (slide.overlays || []).map((overlay) => ({ ...overlay })),
    })),
  };
}

function recordHistory() {
  const project = activeProject();
  if (!project || history.applying) return;
  history.past.push(cloneProject(project));
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future = [];
}

function applyHistorySnapshot(snapshot) {
  const index = state.projects.findIndex((project) => project.id === snapshot.id);
  if (index < 0) return;
  history.applying = true;
  state.projects[index] = cloneProject(snapshot);
  state.activeProjectId = snapshot.id;
  if (!state.projects[index].slides.some((slide) => slide.id === state.activeSlideId)) {
    state.activeSlideId = state.projects[index].slides[0]?.id || null;
  }
  setLayerSelection(selectedLayerKeys());
  state.croppingOverlayId = null;
  renderEditor();
  putProject(state.projects[index]).catch((error) => console.error(error));
  history.applying = false;
}

function undo() {
  if (!history.past.length || isEditingTextTarget(document.activeElement)) return;
  const project = activeProject();
  if (!project) return;
  history.future.push(cloneProject(project));
  applyHistorySnapshot(history.past.pop());
}

function redo() {
  if (!history.future.length || isEditingTextTarget(document.activeElement)) return;
  const project = activeProject();
  if (!project) return;
  history.past.push(cloneProject(project));
  applyHistorySnapshot(history.future.pop());
}

const app = document.querySelector("#app");

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeHexColor(value, fallback = null) {
  let hex = String(value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split("").map((character) => character + character).join("");
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : fallback;
}

function textColor(text) {
  const legacyDefault = text?.style === "boxed" && text?.background !== "black" ? "#111111" : "#FFFFFF";
  return normalizeHexColor(text?.color, legacyDefault);
}

function hexToRgb(hex) {
  const value = normalizeHexColor(hex, "#FFFFFF").slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex(value) {
  const channels = String(value || "").match(/-?\d+(?:\.\d+)?/g);
  if (!channels || channels.length !== 3) return null;
  const hex = channels
    .map((channel) => Math.round(clamp(Number(channel), 0, 255)).toString(16).padStart(2, "0"))
    .join("");
  return normalizeHexColor(hex);
}

function formatRgb(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

function outlineColorFor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#FFFFFF";
}

function ensureBoxedTextContrast(text) {
  if (text?.style !== "boxed") return;
  const backgroundColor = text.background === "black" ? "#111111" : "#FFFFFF";
  if (textColor(text) === backgroundColor) text.color = outlineColorFor(backgroundColor);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  toast(`Copied ${value}`);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllProjects() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putProject(project) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(project);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteProjectFromDb(projectId) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(projectId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function activeProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function activeSlide() {
  return activeProject()?.slides.find((slide) => slide.id === state.activeSlideId) || null;
}

function selectedText() {
  return activeSlide()?.texts.find((text) => text.id === state.selectedTextId) || null;
}

function selectedOverlay() {
  return activeSlide()?.overlays?.find((overlay) => overlay.id === state.selectedOverlayId) || null;
}

function layerKey(kind, id) {
  return `${kind}:${id}`;
}

function parseLayerKey(key) {
  const separator = key.indexOf(":");
  return { kind: key.slice(0, separator), id: key.slice(separator + 1) };
}

function selectedLayerKeys() {
  return Array.isArray(state.selectedLayerKeys) ? state.selectedLayerKeys : [];
}

function isLayerSelected(kind, id) {
  return selectedLayerKeys().includes(layerKey(kind, id));
}

function selectedLayers() {
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

function setLayerSelection(keys, primaryKey = keys.at(-1) || null) {
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

function selectOnlyLayer(kind, id) {
  const key = layerKey(kind, id);
  setLayerSelection([key], key);
}

function toggleLayerSelection(kind, id) {
  const key = layerKey(kind, id);
  const keys = selectedLayerKeys();
  if (keys.includes(key)) setLayerSelection(keys.filter((item) => item !== key));
  else setLayerSelection([...keys, key], key);
}

function projectAsset(assetId) {
  return activeProject()?.assets?.find((asset) => asset.id === assetId) || null;
}

function overlayCrop(overlay) {
  const x = clamp(Number(overlay.cropX) || 0, 0, 0.95);
  const y = clamp(Number(overlay.cropY) || 0, 0, 0.95);
  const w = clamp(Number(overlay.cropW) || 1, 0.05, 1 - x);
  const h = clamp(Number(overlay.cropH) || 1, 0.05, 1 - y);
  return { x, y, w, h };
}

function getOverlayMetrics(overlay, asset = projectAsset(overlay.assetId), { full = false } = {}) {
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

function textAlignment(text) {
  return ["left", "center", "right"].includes(text?.align) ? text.align : "center";
}

function overlayStageInset(overlay, asset = projectAsset(overlay.assetId)) {
  const metrics = getOverlayMetrics(overlay, asset);
  return layerStageInset(overlay.x, overlay.y, metrics.width, metrics.height);
}

function layerStageInset(x, y, width, height) {
  if (!width || !height) return { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    top: Math.max(0, -y / height),
    right: Math.max(0, (x + width - 1) / width),
    bottom: Math.max(0, (y + height - 1) / height),
    left: Math.max(0, -x / width),
  };
}

function layerClipCss(x, y, width, height) {
  const inset = layerStageInset(x, y, width, height);
  return `inset(${inset.top * 100}% ${inset.right * 100}% ${inset.bottom * 100}% ${inset.left * 100}%)`;
}

function overlayClipCss(overlay, asset) {
  const inset = overlayStageInset(overlay, asset);
  return `inset(${inset.top * 100}% ${inset.right * 100}% ${inset.bottom * 100}% ${inset.left * 100}%)`;
}

function constrainOverlay(overlay, asset = projectAsset(overlay.assetId)) {
  if (!asset) return overlay;
  overlay.width = clamp(Number(overlay.width) || 0.34, 0.04, 2.4);
  const crop = overlayCrop(overlay);
  const naturalHeight = overlay.width * (OUTPUT_WIDTH / OUTPUT_HEIGHT) * (((asset.height || 1) * crop.h) / ((asset.width || 1) * crop.w));
  overlay.height = clamp(Number(overlay.height) || naturalHeight, 0.025, 2.4);
  overlay.rotation = ((Number(overlay.rotation) || 0) % 360 + 360) % 360;
  return overlay;
}

function initialOverlayWidth(asset) {
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

function clearLayerSelection() {
  exitCropMode();
  setLayerSelection([]);
}

function slideItems(slide) {
  const overlays = (slide.overlays || []).map((item) => ({ kind: "overlay", item }));
  const texts = (slide.texts || []).map((item) => ({ kind: "text", item }));
  return [...overlays, ...texts].sort((a, b) => (Number(a.item.z) || 0) - (Number(b.item.z) || 0));
}

function nextLayerZ(slide) {
  const items = slideItems(slide);
  if (!items.length) return 1;
  return Math.max(...items.map(({ item }) => Number(item.z) || 0)) + 1;
}

function moveLayer(kind, id, action) {
  recordHistory();
  const slide = activeSlide();
  if (!slide) return;
  const items = slideItems(slide);
  const selected = new Set(isLayerSelected(kind, id) ? selectedLayerKeys() : [layerKey(kind, id)]);
  if (selected.size > 1) {
    if (action === "front" || action === "back") {
      const chosen = items.filter((entry) => selected.has(layerKey(entry.kind, entry.item.id)));
      const remaining = items.filter((entry) => !selected.has(layerKey(entry.kind, entry.item.id)));
      items.splice(0, items.length, ...(action === "front" ? [...remaining, ...chosen] : [...chosen, ...remaining]));
    } else if (action === "up") {
      for (let index = items.length - 2; index >= 0; index -= 1) {
        const currentSelected = selected.has(layerKey(items[index].kind, items[index].item.id));
        const nextSelected = selected.has(layerKey(items[index + 1].kind, items[index + 1].item.id));
        if (currentSelected && !nextSelected) [items[index], items[index + 1]] = [items[index + 1], items[index]];
      }
    } else if (action === "down") {
      for (let index = 1; index < items.length; index += 1) {
        const currentSelected = selected.has(layerKey(items[index].kind, items[index].item.id));
        const previousSelected = selected.has(layerKey(items[index - 1].kind, items[index - 1].item.id));
        if (currentSelected && !previousSelected) [items[index], items[index - 1]] = [items[index - 1], items[index]];
      }
    }
    items.forEach((layer, order) => {
      layer.item.z = order + 1;
    });
    scheduleSave();
    renderEditor();
    return;
  }
  const index = items.findIndex((entry) => entry.kind === kind && entry.item.id === id);
  if (index < 0) return;
  const [entry] = items.splice(index, 1);
  if (action === "front") items.push(entry);
  else if (action === "back") items.unshift(entry);
  else if (action === "up") items.splice(Math.min(index + 1, items.length), 0, entry);
  else if (action === "down") items.splice(Math.max(index - 1, 0), 0, entry);
  else items.splice(index, 0, entry);
  items.forEach((layer, order) => {
    layer.item.z = order + 1;
  });
  scheduleSave();
  renderEditor();
}

function closeLayerMenu() {
  document.querySelector(".layer-menu")?.remove();
}

function positionLayerMenu(menu, clientX, clientY) {
  const pad = 8;
  const { width, height } = menu.getBoundingClientRect();
  const left = clamp(clientX, pad, window.innerWidth - width - pad);
  const top = clamp(clientY, pad, window.innerHeight - height - pad);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showLayerMenu(event, kind, id) {
  event.preventDefault();
  event.stopPropagation();
  closeLayerMenu();
  if (state.photoAdjustMode) return;
  if (!isLayerSelected(kind, id)) selectOnlyLayer(kind, id);
  refreshSelection();

  const menu = document.createElement("div");
  menu.className = "layer-menu";
  menu.setAttribute("role", "menu");
  const actions = [
    ...(kind === "overlay" && selectedLayers().length === 1 ? [["crop", "crop", "Crop"]] : []),
    ["front", "front", "Bring to front"],
    ["up", "up", "Bring up a level"],
    ["down", "down", "Bring down a level"],
    ["back", "send-back", "Bring to back"],
    ["remove", "trash", "Remove"],
  ];
  actions.forEach(([action, iconName, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `layer-menu-item${action === "remove" ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.innerHTML = `${icon(iconName)}<span></span>`;
    button.querySelector("span").textContent = label;
    button.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      closeLayerMenu();
      if (action === "remove") {
        deleteSelectedLayers();
      } else if (action === "crop") {
        beginCrop(id);
      } else {
        moveLayer(kind, id, action);
      }
    });
    menu.appendChild(button);
  });
  document.body.appendChild(menu);
  positionLayerMenu(menu, event.clientX, event.clientY);
}

function showAssetDeleteMenu(event, assetId) {
  event.preventDefault();
  event.stopPropagation();
  closeLayerMenu();
  hideAssetPreview();

  const asset = projectAsset(assetId);
  if (!asset) return;

  const menu = document.createElement("div");
  menu.className = "layer-menu layer-menu--confirm";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Delete ${asset.name}?`);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "layer-menu-item is-danger";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", `Delete ${asset.name}`);
  button.innerHTML = `${icon("trash")}<span>Delete?</span>`;
  button.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    closeLayerMenu();
    deleteProjectAsset(assetId);
  });
  menu.appendChild(button);
  document.body.appendChild(menu);

  const triggerRect = event.currentTarget.getBoundingClientRect();
  const clientX = event.clientX || triggerRect.right;
  const clientY = event.clientY || triggerRect.bottom;
  positionLayerMenu(menu, clientX, clientY);
}

function showSlideMenu(event, slideId) {
  event.preventDefault();
  event.stopPropagation();
  closeLayerMenu();

  const slide = activeProject()?.slides.find((item) => item.id === slideId);
  if (!slide) return;

  const menu = document.createElement("div");
  menu.className = "layer-menu layer-menu--confirm";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${slide.name}`);

  [
    ["change", "image", "Change"],
    ["remove", "trash", "Remove"],
  ].forEach(([action, iconName, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `layer-menu-item${action === "remove" ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", `${label} ${slide.name}`);
    button.innerHTML = `${icon(iconName)}<span></span>`;
    button.querySelector("span").textContent = label;
    button.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      closeLayerMenu();
      if (action === "change") beginSlideBackgroundChange(slideId);
      else removeSlide(slideId);
    });
    menu.appendChild(button);
  });
  document.body.appendChild(menu);

  const triggerRect = event.currentTarget.getBoundingClientRect();
  const clientX = event.clientX || triggerRect.left + triggerRect.width / 2;
  const clientY = event.clientY || triggerRect.top + triggerRect.height / 2;
  positionLayerMenu(menu, clientX, clientY);
}

function beginCrop(overlayId) {
  recordHistory();
  const overlay = (activeSlide()?.overlays || []).find((item) => item.id === overlayId);
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  state.photoAdjustMode = false;
  selectOnlyLayer("overlay", overlay.id);
  const crop = overlayCrop(overlay);
  if (crop.w < 0.999 || crop.h < 0.999 || crop.x > 0.001 || crop.y > 0.001) {
    overlay.width /= crop.w;
    overlay.height = getOverlayMetrics(overlay, asset).height / crop.h;
    overlay.x -= crop.x * overlay.width;
    overlay.y -= crop.y * overlay.height;
  }
  state.croppingOverlayId = overlay.id;
  renderEditor();
}

function exitCropMode({ apply = true } = {}) {
  const overlayId = state.croppingOverlayId;
  if (!overlayId) return false;
  const overlay = apply ? (activeSlide()?.overlays || []).find((item) => item.id === overlayId) : null;
  state.croppingOverlayId = null;
  if (!overlay) return true;
  const asset = projectAsset(overlay.assetId);
  const crop = overlayCrop(overlay);
  const full = getOverlayMetrics(overlay, asset, { full: true });
  overlay.x += crop.x * full.width;
  overlay.y += crop.y * full.height;
  overlay.width *= crop.w;
  overlay.height = full.height * crop.h;
  if (asset) constrainOverlay(overlay, asset);
  return true;
}

function finishCrop() {
  if (!state.croppingOverlayId) return;
  exitCropMode();
  scheduleSave();
  renderEditor();
}

function scheduleSave() {
  const project = activeProject();
  if (!project) return;
  project.updatedAt = Date.now();
  scheduleThumbnailRefresh();
  state.shareAllCache = null;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      await putProject(project);
    } catch (error) {
      console.error(error);
      toast("Couldn’t save this project in your browser.");
    }
  }, 180);
}

function toast(message) {
  document.querySelector(".toast")?.remove();
  clearTimeout(state.toastTimer);
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  document.body.appendChild(element);
  state.toastTimer = setTimeout(() => element.remove(), 2600);
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function icon(name) {
  const icons = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    airdrop: '<img class="airdrop-icon" src="assets/airdrop.svg" alt="" />',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m7 7 1 14h8l1-14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 4v6h-6"/></svg>',
    "align-left": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 10h11M4 14h16M4 18h9"/></svg>',
    "align-center": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M6.5 10h11M4 14h16M7.5 18h9"/></svg>',
    "align-right": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M9 10h11M4 14h16M11 18h9"/></svg>',
    front: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    "send-back": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 13 5 5 5-5"/><path d="m7 6 5 5 5-5"/></svg>',
    crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14"/><path d="M12 5v14"/><path d="M8 19h8"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 4.5-4 3.5 3 3-2.5 5 4.5"/></svg>',
    adjust: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h7"/><path d="M15 7h5"/><circle cx="13" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/></svg>',
    preview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 6h4"/><path d="M10 17.5h4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  };
  return icons[name] || "";
}

function renderHeader({ editor = false } = {}) {
  const project = activeProject();
  return `
    <header class="app-header${editor ? " app-header--editor" : ""}">
      <button class="brand" type="button" data-action="home" aria-label="Go to projects">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-copy"><strong>Slide Studio</strong><small>TikTok image maker</small></span>
      </button>
      ${editor && project ? `
        <div class="project-identity">
          <input class="project-title-input" value="${escapeHtml(project.name)}" aria-label="Project name" maxlength="64" />
        </div>
      ` : ""}
      <div class="header-actions">
        ${editor ? `
          <button class="icon-button mobile-edit-button" type="button" data-action="toggle-inspector" aria-label="Toggle text controls">${icon("edit")}</button>
          <button class="button button--quiet share-button" type="button" data-action="share" aria-label="AirDrop current slide" title="AirDrop current slide" ${activeSlide() ? "" : "disabled"}>
            ${icon("airdrop")} <span>AirDrop</span>
          </button>
          <button class="button button--quiet share-button" type="button" data-action="share-all" aria-label="AirDrop all slides" title="AirDrop all slides" ${project.slides.length ? "" : "disabled"}>
            ${icon("airdrop")} <span>AirDrop all</span>
          </button>
          <button class="button button--quiet" type="button" data-action="export" aria-label="Download current slide as PNG" title="Download PNG" ${activeSlide() ? "" : "disabled"}>
            ${icon("download")} <span>PNG</span>
          </button>
        ` : `<button class="button button--primary" type="button" data-action="new-project">New project</button>`}
        <a class="icon-button github-link" href="https://github.com/alexgusevski/tiktokslideeditor" target="_blank" rel="noopener noreferrer" aria-label="Open Slide Studio on GitHub" title="Open GitHub repository"><img class="github-mark" src="assets/Octicons-mark-github.svg" alt="" /></a>
      </div>
    </header>
  `;
}

function renderDashboard() {
  hideAssetPreview();
  state.activeProjectId = null;
  state.activeSlideId = null;
  clearLayerSelection();
  const sortedProjects = [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  app.innerHTML = `
    ${renderHeader()}
    <main class="dashboard">
      <section class="dashboard-hero">
        <div>
          <p class="eyebrow">Made for your camera roll</p>
          <h1>Turn photos into<br><em>scroll-stoppers.</em></h1>
        </div>
        <p class="dashboard-intro">Upload your photos, place TikTok-style text, and export crisp slideshow images. Nothing else in the way.</p>
      </section>
      <section>
        <div class="section-heading">
          <h2>Your projects</h2>
          <span>${sortedProjects.length} ${sortedProjects.length === 1 ? "project" : "projects"}</span>
        </div>
        <div class="project-grid">
          <button class="new-project-card" type="button" data-action="new-project">
            <span>+</span>
            <span><strong>Start a project</strong><small>Add photos when you’re ready</small></span>
          </button>
          ${sortedProjects.map((project) => {
            const cover = project.slides[0]?.imageData;
            return `
              <button class="project-card" type="button" data-project-id="${project.id}">
                <span class="project-preview">
                  ${cover ? `<img src="${cover}" alt="" />` : `<span class="project-preview-empty">No photos yet</span>`}
                </span>
                <span class="project-meta">
                  <strong>${escapeHtml(project.name)}</strong>
                  <span>${project.slides.length} ${project.slides.length === 1 ? "slide" : "slides"} · ${formatDate(project.updatedAt)}</span>
                </span>
              </button>
            `;
          }).join("")}
        </div>
      </section>
    </main>
  `;
  bindDashboardEvents();
}

function renderEditor() {
  const project = activeProject();
  if (!project) return renderDashboard();
  if (!activeSlide() && project.slides[0]) state.activeSlideId = project.slides[0].id;
  const previousSlideList = app.querySelector(".slide-list");
  if (previousSlideList) {
    state.slideRailScrollPositions.set(project.id, previousSlideList.scrollTop);
  }
  hideAssetPreview();

  app.innerHTML = `
    ${renderHeader({ editor: true })}
    <main class="editor-shell">
      ${renderSlideRail(project)}
      ${renderAssetRail(project)}
      <section class="workspace" aria-label="Image editor">
        <div class="workspace-inner">
          ${activeSlide() ? renderStage(activeSlide()) : renderEmptyStage()}
        </div>
      </section>
      ${renderInspector()}
    </main>
    <input id="photo-upload" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" multiple />
    <input id="slide-background-upload" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" />
    <input id="asset-upload" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" multiple />
  `;
  bindEditorEvents();
  const slideList = app.querySelector(".slide-list");
  if (slideList) {
    slideList.scrollTop = state.slideRailScrollPositions.get(project.id) || 0;
    slideList.addEventListener("scroll", () => {
      state.slideRailScrollPositions.set(project.id, slideList.scrollTop);
    }, { passive: true });
  }
  requestAnimationFrame(() => {
    if (activeSlide()) sizeStage();
    refreshAllSlideThumbnails(project.slides);
  });
}

function renderSlideRail(project) {
  return `
    <aside class="slide-rail">
      <div class="rail-heading"><h2>Slides</h2><span>${project.slides.length}</span></div>
      <div class="slide-list">
        ${project.slides.map((slide, index) => `
          <button class="slide-thumb ${slide.id === state.activeSlideId ? "is-active" : ""}" type="button" data-slide-id="${slide.id}" draggable="true" aria-haspopup="menu" aria-label="Open slide ${index + 1}. Drag to reorder. Right-click for actions." title="Drag to reorder · Right-click for actions">
            <span class="slide-number">${String(index + 1).padStart(2, "0")}</span>
            <span class="thumb-image" data-thumbnail-slide-id="${slide.id}">${renderSlideThumbnail(slide)}</span>
          </button>
        `).join("")}
      </div>
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload">${icon("plus")}<span>New slide</span></button></div>
    </aside>
  `;
}

function renderSlideThumbnail(slide) {
  const source = state.thumbnailUrls.get(slide.id);
  return source
    ? `<img class="thumb-rendered" src="${source}" alt="" draggable="false" aria-hidden="true" />`
    : `<span class="thumb-rendering-placeholder" aria-hidden="true"><span></span></span>`;
}

function scheduleThumbnailRefresh() {
  clearTimeout(state.thumbnailRefreshTimer);
  state.thumbnailRefreshTimer = setTimeout(() => {
    state.thumbnailRefreshTimer = null;
    const slide = activeSlide();
    if (slide) refreshSlideThumbnail(slide);
  }, 80);
}

function thumbnailSignature(slide) {
  return JSON.stringify([
    slide.backgroundRevision || "",
    slide.imageScale || 1,
    slide.imageX || 0,
    slide.imageY || 0,
    slide.texts || [],
    slide.overlays || [],
  ]);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render thumbnail")), "image/png", 1);
  });
}

async function refreshSlideThumbnail(slide) {
  const target = app.querySelector(`[data-thumbnail-slide-id="${slide.id}"]`);
  if (!target) return;
  const signature = thumbnailSignature(slide);
  const cachedUrl = state.thumbnailUrls.get(slide.id);
  if (cachedUrl && state.thumbnailSignatures.get(slide.id) === signature) {
    const image = target.querySelector(".thumb-rendered");
    if (image?.src !== cachedUrl) image.src = cachedUrl;
    return;
  }

  const version = (state.thumbnailVersions.get(slide.id) || 0) + 1;
  state.thumbnailVersions.set(slide.id, version);
  target.classList.add("is-rendering");
  try {
    const canvas = await renderSlideCanvas(slide, 540, 960);
    const blob = await canvasToBlob(canvas);
    if (state.thumbnailVersions.get(slide.id) !== version) return;
    const url = URL.createObjectURL(blob);
    const previousUrl = state.thumbnailUrls.get(slide.id);
    state.thumbnailUrls.set(slide.id, url);
    state.thumbnailSignatures.set(slide.id, signature);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const currentTarget = app.querySelector(`[data-thumbnail-slide-id="${slide.id}"]`);
    if (currentTarget) {
      currentTarget.innerHTML = renderSlideThumbnail(slide);
      currentTarget.classList.remove("is-rendering");
    }
  } catch (error) {
    console.error(error);
    target.classList.remove("is-rendering");
  }
}

function refreshAllSlideThumbnails(slides) {
  slides.forEach((slide) => refreshSlideThumbnail(slide));
}

function renderAssetRail(project) {
  const assets = project.assets || [];
  return `
    <aside class="asset-rail">
      <div class="rail-heading"><h2>Assets</h2><span>${assets.length}</span></div>
      <div class="asset-grid" aria-label="Uploaded assets">
        ${assets.length ? assets.map((asset) => `
          <div class="asset-item" data-asset-id="${asset.id}" draggable="true" title="${escapeHtml(asset.name)}">
            <img src="${asset.imageData}" alt="${escapeHtml(asset.name)}" draggable="false" />
            <button class="asset-remove" type="button" data-action="delete-asset" data-asset-id="${asset.id}" aria-label="Remove ${escapeHtml(asset.name)}">×</button>
          </div>
        `).join("") : `<p class="asset-empty">Upload logos, stickers, or extra photos. Drag them onto a photo to place them.</p>`}
      </div>
      <div class="asset-trash" data-asset-trash>
        ${icon("trash")}
        <span>Drag here to delete</span>
      </div>
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload-assets">${icon("plus")}<span>Upload assets</span></button></div>
    </aside>
  `;
}

function renderEmptyStage() {
  return `
    <div class="empty-stage">
      <div>
        <div class="empty-stage-graphic" aria-hidden="true"></div>
        <h2>Add your first photos</h2>
        <p>Choose one or several images from your computer. Each one becomes a slide.</p>
        <button class="button button--primary" type="button" data-action="upload">Choose photos</button>
      </div>
    </div>
  `;
}

function renderStage(slide) {
  return `
    <div class="canvas-composition">
      <div class="stage-wrap">
        <div class="stage-frame ${selectedLayers().length > 1 ? "has-multi-selection" : ""} ${state.photoAdjustMode ? "is-adjusting-photo" : ""}">
          <img class="stage-image-ghost" src="${slide.imageData}" alt="" draggable="false" aria-hidden="true" />
          <div class="stage ${state.photoAdjustMode ? "is-adjusting" : ""}" data-natural-width="${slide.width}" data-natural-height="${slide.height}">
            <img class="stage-image" src="${slide.imageData}" alt="${escapeHtml(slide.name)}" draggable="false" />
            ${renderTikTokOverlay()}
          </div>
          <div class="layer-stack">
            ${slideItems(slide).map(({ kind, item }) => (kind === "overlay" ? renderOverlayBox(item) : renderTextBox(item))).join("")}
          </div>
        </div>
        <span class="stage-dimensions">
          <span>${OUTPUT_WIDTH} × ${OUTPUT_HEIGHT} · 9:16</span>
          <span class="canvas-zoom-controls" aria-label="Canvas zoom">
            <button class="canvas-zoom-button" type="button" data-action="canvas-zoom-out" aria-label="Zoom canvas out">−</button>
            <button class="canvas-zoom-level" type="button" data-action="canvas-zoom-reset" title="Reset canvas zoom">${Math.round(state.canvasZoom * 100)}%</button>
            <button class="canvas-zoom-button" type="button" data-action="canvas-zoom-in" aria-label="Zoom canvas in">+</button>
          </span>
        </span>
      </div>
      ${renderCanvasActions()}
    </div>
  `;
}

function renderCanvasActions() {
  return `
    <div class="canvas-actions" aria-label="Canvas actions">
      <button class="canvas-action" type="button" data-action="add-text" title="Add text">${icon("text")}<span>Text</span></button>
      <button class="canvas-action" type="button" data-action="upload-assets" title="Add image">${icon("image")}<span>Image</span></button>
      <button class="canvas-action ${state.photoAdjustMode ? "is-active" : ""}" type="button" data-action="adjust-photo" aria-pressed="${state.photoAdjustMode}" title="Adjust photo">${icon("adjust")}<span>Adjust photo</span></button>
      <button class="canvas-action ${state.showTikTokOverlay ? "is-active" : ""}" type="button" data-action="toggle-tiktok-overlay" aria-pressed="${state.showTikTokOverlay}" title="Toggle TikTok UI overlay">${icon("preview")}<span>Overlay</span></button>
    </div>
  `;
}

function renderTikTokOverlay() {
  return `
    <div class="tiktok-overlay ${state.showTikTokOverlay ? "" : "is-hidden"}" aria-hidden="true">
      <div class="tiktok-overlay-canvas">
        <div class="tt-preview-label">PREVIEW ONLY · NOT EXPORTED</div>
        <div class="tt-topbar"><span>Following</span><strong>For You</strong><span class="tt-search">⌕</span></div>
        <div class="tt-side-actions">
          <div class="tt-avatar"><span></span><b>+</b></div>
          <div class="tt-action"><span class="tt-heart">♥</span><small>128K</small></div>
          <div class="tt-action"><span class="tt-bubble">●</span><small>842</small></div>
          <div class="tt-action"><span class="tt-bookmark">▮</span><small>12K</small></div>
          <div class="tt-action"><span class="tt-share">↗</span><small>Share</small></div>
          <div class="tt-disc">♪</div>
        </div>
        <div class="tt-caption">
          <strong>@yourname</strong>
          <p>Your caption appears here <b>more</b></p>
          <span>♫ Original sound · yourname</span>
        </div>
        <div class="tt-bottom-nav">
          <span><b>⌂</b>Home</span><span><b>♙</b>Friends</span><span class="tt-create">+</span><span><b>▣</b>Inbox</span><span><b>◉</b>Profile</span>
        </div>
      </div>
    </div>
  `;
}

function renderOverlayBox(overlay) {
  const asset = projectAsset(overlay.assetId);
  if (!asset) return "";
  const selected = isLayerSelected("overlay", overlay.id);
  const cropping = overlay.id === state.croppingOverlayId;
  const metrics = getOverlayMetrics(overlay, asset);
  const crop = overlayCrop(overlay);
  const imageStyle = cropping
    ? "width:100%;height:100%;left:0;top:0;"
    : `width:${100 / crop.w}%;height:${100 / crop.h}%;left:${(-crop.x / crop.w) * 100}%;top:${(-crop.y / crop.h) * 100}%;`;
  return `
    <div
      class="overlay-box ${selected ? "is-selected" : ""} ${cropping ? "is-cropping" : ""}"
      data-overlay-id="${overlay.id}"
      style="left:${overlay.x * 100}%;top:${overlay.y * 100}%;width:${metrics.width * 100}%;height:${metrics.height * 100}%;transform:rotate(${overlay.rotation || 0}deg);"
      tabindex="0"
      aria-label="Photo overlay: ${escapeHtml(asset.name)}"
    >
      <div class="overlay-image-clip overlay-image-clip--outside"><img src="${asset.imageData}" alt="" draggable="false" style="${imageStyle}" /></div>
      <div class="overlay-image-clip overlay-image-clip--inside" style="clip-path:${overlayClipCss(overlay, asset)}"><img src="${asset.imageData}" alt="" draggable="false" style="${imageStyle}" /></div>
      ${cropping ? `
        <div class="crop-rect" style="left:${crop.x * 100}%;top:${crop.y * 100}%;width:${crop.w * 100}%;height:${crop.h * 100}%;">
          <span class="crop-handle" data-crop="nw"></span>
          <span class="crop-handle" data-crop="n"></span>
          <span class="crop-handle" data-crop="ne"></span>
          <span class="crop-handle" data-crop="e"></span>
          <span class="crop-handle" data-crop="se"></span>
          <span class="crop-handle" data-crop="s"></span>
          <span class="crop-handle" data-crop="sw"></span>
          <span class="crop-handle" data-crop="w"></span>
        </div>
      ` : `
        <span class="rotate-handle" data-rotate="true" aria-hidden="true">${icon("rotate")}</span>
        <span class="edge-resize-handle" data-edge="n" aria-hidden="true"></span>
        <span class="edge-resize-handle" data-edge="e" aria-hidden="true"></span>
        <span class="edge-resize-handle" data-edge="s" aria-hidden="true"></span>
        <span class="edge-resize-handle" data-edge="w" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
      `}
    </div>
  `;
}

function renderTextBox(text) {
  const selected = isLayerSelected("text", text.id);
  const background = text.background || "white";
  const backgroundShape = text.backgroundShape || "lines";
  const color = textColor(text);
  const outlineColor = outlineColorFor(color);
  return `
    <div
      class="text-box ${selected ? "is-selected" : ""}"
      data-text-id="${text.id}"
      data-style="${text.style}"
      data-background="${background}"
      data-box-shape="${backgroundShape}"
      data-align="${textAlignment(text)}"
      style="left:${text.x * 100}%;top:${text.y * 100}%;width:${text.width * 100}%;height:${text.height * 100}%;transform:rotate(${text.rotation || 0}deg);--text-color:${color};--outline-color:${outlineColor};"
      tabindex="0"
      aria-label="Text layer: ${escapeHtml(text.text)}"
    >
      <div class="text-visual text-visual--outside" aria-hidden="true">
        <div class="text-content-wrap"><span class="text-content" spellcheck="false">${escapeHtml(text.text)}</span></div>
      </div>
      <div class="text-visual text-visual--inside" style="clip-path:${layerClipCss(text.x, text.y, text.width, text.height)}">
        <div class="text-content-wrap"><span class="text-content" spellcheck="false">${escapeHtml(text.text)}</span></div>
      </div>
      <span class="rotate-handle" data-rotate="true" aria-hidden="true">${icon("rotate")}</span>
      <span class="edge-resize-handle" data-edge="n" aria-hidden="true"></span>
      <span class="edge-resize-handle" data-edge="e" aria-hidden="true"></span>
      <span class="edge-resize-handle" data-edge="s" aria-hidden="true"></span>
      <span class="edge-resize-handle" data-edge="w" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
    </div>
  `;
}

function interpolateFontSizeControl(value, inputKey, outputKey) {
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

function fontSizeFromSliderPosition(position) {
  return Math.round(interpolateFontSizeControl(position, "position", "size") * 2) / 2;
}

function sliderPositionFromFontSize(size) {
  const position = interpolateFontSizeControl(size, "size", "position");
  return Math.round(position / FONT_SIZE_SLIDER_STEP) * FONT_SIZE_SLIDER_STEP;
}

function formatFontSize(size) {
  const value = Math.round(clamp(Number(size) || FONT_SIZE_MIN, FONT_SIZE_MIN, FONT_SIZE_MAX) * 2) / 2;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderInspector() {
  const text = selectedText();
  const overlay = selectedOverlay();
  const selectionCount = selectedLayers().length;
  const multiMode = selectionCount > 1;
  const overlayAsset = overlay ? projectAsset(overlay.assetId) : null;
  const slide = activeSlide();
  const photoMode = Boolean(state.photoAdjustMode && slide);
  const overlayMode = Boolean(!photoMode && !multiMode && overlay);
  const color = textColor(text);
  return `
    <aside class="inspector ${state.mobileInspectorOpen ? "is-mobile-open" : ""}">
      <div class="inspector-header">
        <h2>${photoMode ? "Photo settings" : multiMode ? `${selectionCount} layers selected` : overlayMode && state.croppingOverlayId === overlay.id ? "Crop" : overlayMode ? "Overlay" : text ? "Text settings" : "Text"}</h2>
        ${multiMode ? `<button class="icon-button" type="button" data-action="delete-selection" aria-label="Delete selected layers">${icon("trash")}</button>` : ((text && !photoMode && !overlayMode) || overlayMode) ? `<button class="icon-button" type="button" data-action="${overlayMode ? "delete-overlay" : "delete-text"}" aria-label="${overlayMode ? "Delete overlay" : "Delete text"}">${icon("trash")}</button>` : ""}
      </div>
      ${photoMode ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="photo-zoom">Zoom <output id="photo-zoom-output">${Math.round((slide.imageScale || 1) * 100)}%</output></label>
            <input id="photo-zoom" type="range" min="1" max="3" step="0.01" value="${slide.imageScale || 1}" />
          </div>
          <button class="button button--quiet reset-photo-button" type="button" data-action="reset-photo">Reset photo</button>
        </div>
      ` : multiMode ? "" : overlayMode && state.croppingOverlayId === overlay.id ? `
        <div class="inspector-body">
          <button class="button button--primary" type="button" data-action="done-crop">Done</button>
        </div>
      ` : overlayMode ? `
        <div class="inspector-body">
          <div class="control-group">
            <div class="control-label">File</div>
            <p class="overlay-asset-name">${escapeHtml(overlayAsset?.name || "Photo")}</p>
          </div>
          <div class="control-group">
            <label class="control-label" for="overlay-rotation">Rotate <output id="overlay-rotation-output">${Math.round(overlay.rotation || 0)}°</output></label>
            <div class="range-wrap">
              <input id="overlay-rotation" type="range" min="0" max="359" step="1" value="${Math.round(overlay.rotation || 0)}" />
              <input id="overlay-rotation-number" class="number-input" type="number" min="0" max="359" step="1" value="${Math.round(overlay.rotation || 0)}" aria-label="Rotation in degrees" />
            </div>
          </div>
        </div>
      ` : text ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="text-value">Words</label>
            <textarea id="text-value" class="text-input" maxlength="500" placeholder="Type something…">${escapeHtml(text.text)}</textarea>
          </div>
          <div class="control-group">
            <div class="control-label">Style</div>
            <div class="style-options">
              <button class="style-option ${text.style === "plain" ? "is-active" : ""}" type="button" data-text-style="plain">
                <span class="style-preview">Aa</span><small>Clean</small>
              </button>
              <button class="style-option ${text.style === "outline" ? "is-active" : ""}" type="button" data-text-style="outline">
                <span class="style-preview style-preview--outline">Aa</span><small>Outline</small>
              </button>
              <button class="style-option ${text.style === "boxed" ? "is-active" : ""}" type="button" data-text-style="boxed">
                <span class="style-preview style-preview--boxed">Aa</span><small>Box</small>
              </button>
            </div>
          </div>
          <div class="control-group">
            <label class="control-label" for="font-size">Size <output>${formatFontSize(text.size)} px</output></label>
            <div class="range-wrap">
              <input id="font-size" type="range" min="0" max="${FONT_SIZE_SLIDER_MAX}" step="${FONT_SIZE_SLIDER_STEP}" value="${sliderPositionFromFontSize(text.size)}" aria-valuetext="${formatFontSize(text.size)} pixels" />
              <input id="font-size-number" class="number-input" type="number" min="${FONT_SIZE_MIN}" max="${FONT_SIZE_MAX}" step="0.5" value="${formatFontSize(text.size)}" aria-label="Font size in pixels" />
            </div>
          </div>
          <div class="control-group color-control">
            <div class="control-label">Text color</div>
            <div class="color-presets" role="group" aria-label="Text color presets">
              ${TEXT_COLOR_PRESETS.map((preset) => `
                <button
                  class="color-preset color-preset--${preset.name.toLowerCase()} ${color === preset.value ? "is-active" : ""}"
                  type="button"
                  data-text-color="${preset.value}"
                  title="${preset.name} ${preset.value}"
                  aria-label="Use ${preset.name} text"
                  aria-pressed="${color === preset.value}"
                ></button>
              `).join("")}
            </div>
            <div class="color-custom">
              <label class="color-picker-wrap" for="text-color-picker">
                <input id="text-color-picker" type="color" value="${color}" aria-label="Choose a custom text color" />
                <span>Color wheel</span>
              </label>
              <div class="color-values">
                <div class="color-value-row">
                  <label for="text-color-hex">Hex</label>
                  <input id="text-color-hex" type="text" value="${color}" maxlength="7" spellcheck="false" aria-label="Text color hex value" />
                  <button type="button" data-copy-color="hex" aria-label="Copy hex color">Copy</button>
                </div>
                <div class="color-value-row">
                  <label for="text-color-rgb">RGB</label>
                  <input id="text-color-rgb" type="text" value="${formatRgb(color)}" spellcheck="false" aria-label="Text color RGB value" />
                  <button type="button" data-copy-color="rgb" aria-label="Copy RGB color">Copy</button>
                </div>
              </div>
            </div>
          </div>
          <div class="control-group">
            <div class="control-label">Alignment</div>
            <div class="alignment-options" role="group" aria-label="Text alignment">
              ${["left", "center", "right"].map((align) => `<button class="alignment-option ${textAlignment(text) === align ? "is-active" : ""}" type="button" data-text-align="${align}" aria-label="Align text ${align}" aria-pressed="${textAlignment(text) === align}">${icon(`align-${align}`)}</button>`).join("")}
            </div>
          </div>
          ${text.style === "boxed" ? `
            <div class="control-group">
              <div class="control-label">Background</div>
              <div class="tone-options">
                <button class="tone-option ${text.background !== "black" ? "is-active" : ""}" type="button" data-background-tone="white"><span class="tone-swatch tone-swatch--white">Aa</span>White</button>
                <button class="tone-option ${text.background === "black" ? "is-active" : ""}" type="button" data-background-tone="black"><span class="tone-swatch tone-swatch--black">Aa</span>Black</button>
              </div>
            </div>
            <div class="control-group">
              <div class="control-label">Shape</div>
              <div class="shape-options">
                <button class="shape-option ${text.backgroundShape !== "full" ? "is-active" : ""}" type="button" data-background-shape="lines"><span class="shape-preview shape-preview--lines"><i>Text line</i><i>Shorter</i></span><small>Per line</small></button>
                <button class="shape-option ${text.backgroundShape === "full" ? "is-active" : ""}" type="button" data-background-shape="full"><span class="shape-preview shape-preview--full">Text box</span><small>Full box</small></button>
              </div>
            </div>
          ` : ""}
        </div>
      ` : `
        <div class="inspector-empty"><span>T</span><p>${slide ? "Select text or an overlay, or add one to this photo." : "Add a photo to start placing text."}</p></div>
      `}
    </aside>
  `;
}

function openProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.activeProjectId = projectId;
  state.activeSlideId = project.slides[0]?.id || null;
  clearLayerSelection();
  state.photoAdjustMode = false;
  renderEditor();
}

function createProject() {
  const now = Date.now();
  const project = { id: uid(), name: "New Project", createdAt: now, updatedAt: now, slides: [], assets: [] };
  state.projects.push(project);
  openProject(project.id);
  putProject(project).catch((error) => {
    console.error(error);
    toast("Couldn’t save this project in your browser.");
  });
}

function bindDashboardEvents() {
  app.querySelectorAll('[data-action="new-project"]').forEach((button) => button.addEventListener("click", createProject));
  app.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", () => openProject(button.dataset.projectId));
  });
}

function bindGlobalActions() {
  app.querySelector('[data-action="home"]')?.addEventListener("click", renderDashboard);
}

function bindEditorEvents() {
  bindGlobalActions();
  const title = app.querySelector(".project-title-input");
  title?.addEventListener("input", () => {
    activeProject().name = title.value || "New Project";
    scheduleSave();
  });

  app.querySelectorAll('[data-action="upload"]').forEach((button) => {
    button.addEventListener("click", () => app.querySelector("#photo-upload").click());
  });
  app.querySelector("#photo-upload")?.addEventListener("change", handleUpload);
  app.querySelector("#slide-background-upload")?.addEventListener("change", handleSlideBackgroundChange);
  app.querySelectorAll('[data-action="upload-assets"]').forEach((button) => {
    button.addEventListener("click", () => app.querySelector("#asset-upload").click());
  });
  app.querySelector("#asset-upload")?.addEventListener("change", handleAssetUpload);

  app.querySelectorAll("[data-slide-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSlideId = button.dataset.slideId;
      clearLayerSelection();
      state.photoAdjustMode = false;
      renderEditor();
    });
  });
  bindSlideReordering();

  app.querySelector('[data-action="add-text"]')?.addEventListener("click", () => addText());
  app.querySelector('[data-action="delete-text"]')?.addEventListener("click", deleteSelectedText);
  app.querySelector('[data-action="delete-overlay"]')?.addEventListener("click", deleteSelectedOverlay);
  app.querySelector('[data-action="delete-selection"]')?.addEventListener("click", deleteSelectedLayers);
  app.querySelector('[data-action="done-crop"]')?.addEventListener("click", finishCrop);
  app.querySelector('[data-action="export"]')?.addEventListener("click", exportActiveSlide);
  app.querySelector('[data-action="share"]')?.addEventListener("click", shareActiveSlide);
  app.querySelector('[data-action="share-all"]')?.addEventListener("click", shareAllSlides);
  app.querySelector('[data-action="toggle-inspector"]')?.addEventListener("click", () => {
    state.mobileInspectorOpen = !state.mobileInspectorOpen;
    app.querySelector(".inspector")?.classList.toggle("is-mobile-open", state.mobileInspectorOpen);
  });
  app.querySelector('[data-action="adjust-photo"]')?.addEventListener("click", () => {
    state.photoAdjustMode = !state.photoAdjustMode;
    clearLayerSelection();
    state.mobileInspectorOpen = true;
    renderEditor();
  });
  app.querySelector('[data-action="toggle-tiktok-overlay"]')?.addEventListener("click", (event) => {
    state.showTikTokOverlay = !state.showTikTokOverlay;
    event.currentTarget.classList.toggle("is-active", state.showTikTokOverlay);
    event.currentTarget.setAttribute("aria-pressed", String(state.showTikTokOverlay));
    app.querySelector(".tiktok-overlay")?.classList.toggle("is-hidden", !state.showTikTokOverlay);
  });
  app.querySelector('[data-action="canvas-zoom-out"]')?.addEventListener("click", () => setCanvasZoom(state.canvasZoom / 1.2));
  app.querySelector('[data-action="canvas-zoom-reset"]')?.addEventListener("click", () => setCanvasZoom(1));
  app.querySelector('[data-action="canvas-zoom-in"]')?.addEventListener("click", () => setCanvasZoom(state.canvasZoom * 1.2));

  app.querySelectorAll(".text-box").forEach(bindTextBox);
  app.querySelectorAll(".overlay-box").forEach(bindOverlayBox);
  bindAssetLibrary();
  bindStageAssetDrop();
  bindImageFileDrops();
  bindInspectorControls();

  const workspace = app.querySelector(".workspace");
  workspace?.addEventListener("pointerdown", (event) => {
    if (state.photoAdjustMode || event.target.closest("button, input, textarea, select, a, [contenteditable], .text-box, .overlay-box, .canvas-actions")) return;
    if (!event.target.closest(".workspace-inner")) return;
    if (state.croppingOverlayId) {
      finishCrop();
      return;
    }
    beginMarqueeSelection(event);
  });

  const stage = app.querySelector(".stage");
  const editorShell = app.querySelector(".editor-shell");
  editorShell?.addEventListener("wheel", (event) => {
    if (!(event.metaKey || event.ctrlKey) || !stage) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? stage.clientHeight
        : 1;
    const nextZoom = clamp(
      state.canvasZoom * Math.exp(-event.deltaY * deltaScale * 0.0015),
      CANVAS_ZOOM_MIN,
      CANVAS_ZOOM_MAX,
    );
    setCanvasZoom(nextZoom, event.clientX, event.clientY);
  }, { passive: false, capture: true });
  let gestureStartZoom = state.canvasZoom;
  editorShell?.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    gestureStartZoom = state.canvasZoom;
  }, { passive: false });
  editorShell?.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    setCanvasZoom(gestureStartZoom * event.scale, event.clientX, event.clientY);
  }, { passive: false });
  editorShell?.addEventListener("gestureend", (event) => event.preventDefault(), { passive: false });
  stage?.addEventListener("pointerdown", (event) => {
    if (state.photoAdjustMode) {
      if (event.target.closest(".text-box") || event.target.closest(".overlay-box")) return;
      event.stopPropagation();
      beginImageDrag(event, stage);
    }
  });
  let photoZoomHistoryTimer = null;
  stage?.addEventListener("wheel", (event) => {
    if (!state.photoAdjustMode || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    const slide = activeSlide();
    if (!slide) return;
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? stage.clientHeight
        : 1;
    const currentScale = slide.imageScale || 1;
    const nextScale = clamp(currentScale * Math.exp(-event.deltaY * deltaScale * 0.0015), 1, 3);
    if (Math.abs(nextScale - currentScale) < 0.0001) return;
    if (!photoZoomHistoryTimer) recordHistory();
    window.clearTimeout(photoZoomHistoryTimer);
    photoZoomHistoryTimer = window.setTimeout(() => {
      photoZoomHistoryTimer = null;
    }, 250);
    zoomPhotoAtPoint(slide, nextScale, event.clientX, event.clientY, stage);
    const photoZoom = app.querySelector("#photo-zoom");
    if (photoZoom) photoZoom.value = slide.imageScale;
    const output = app.querySelector("#photo-zoom-output");
    if (output) output.textContent = `${Math.round(slide.imageScale * 100)}%`;
    scheduleSave();
  }, { passive: false });
  workspace?.addEventListener("dblclick", (event) => {
    if (!stage || event.button !== 0 || event.target.closest(".text-box, .overlay-box") || state.croppingOverlayId) return;
    const rect = stage.getBoundingClientRect();
    const isInsideStage = event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
    if (!isInsideStage) return;
    event.preventDefault();
    addText({
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    }, { editDirectly: true });
  });

  const resizeObserver = new ResizeObserver(() => sizeStage());
  if (workspace) resizeObserver.observe(workspace);
}

function bindInspectorControls() {
  const textarea = app.querySelector("#text-value");
  textarea?.addEventListener("input", () => {
    const text = selectedText();
    if (!text) return;
    text.text = textarea.value;
    updateTextBox(text);
    ensureTextFits(text);
    scheduleSave();
  });

  app.querySelectorAll("[data-text-style]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      recordHistory();
      text.style = button.dataset.textStyle;
      ensureBoxedTextContrast(text);
      scheduleSave();
      refreshSelection();
      updateTextBox(text);
      ensureTextFits(text);
    });
  });

  app.querySelectorAll("[data-text-align]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      recordHistory();
      text.align = button.dataset.textAlign;
      app.querySelectorAll("[data-text-align]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      updateTextBox(text);
      scheduleSave();
    });
  });

  const range = app.querySelector("#font-size");
  const number = app.querySelector("#font-size-number");
  const setSize = (value, { fromSlider = false } = {}) => {
    const text = selectedText();
    if (!text) return;
    text.size = fromSlider
      ? fontSizeFromSliderPosition(value)
      : Math.round(clamp(Number(value) || FONT_SIZE_MIN, FONT_SIZE_MIN, FONT_SIZE_MAX) * 2) / 2;
    if (range) range.value = sliderPositionFromFontSize(text.size);
    if (range) range.setAttribute("aria-valuetext", `${formatFontSize(text.size)} pixels`);
    if (number) number.value = formatFontSize(text.size);
    const output = app.querySelector(".control-label output");
    if (output) output.textContent = `${formatFontSize(text.size)} px`;
    updateTextBox(text);
    ensureTextFits(text);
    scheduleSave();
  };
  range?.addEventListener("pointerdown", recordHistory);
  range?.addEventListener("input", () => setSize(range.value, { fromSlider: true }));
  number?.addEventListener("pointerdown", recordHistory);
  number?.addEventListener("input", () => setSize(number.value));

  const colorPicker = app.querySelector("#text-color-picker");
  const hexInput = app.querySelector("#text-color-hex");
  const rgbInput = app.querySelector("#text-color-rgb");
  const setTextColor = (value, { source = null } = {}) => {
    const text = selectedText();
    const color = normalizeHexColor(value);
    if (!text || !color) return false;
    text.color = color;
    if (colorPicker && source !== "picker") colorPicker.value = color;
    if (hexInput && source !== "hex") hexInput.value = color;
    if (rgbInput && source !== "rgb") rgbInput.value = formatRgb(color);
    app.querySelectorAll("[data-text-color]").forEach((button) => {
      const active = button.dataset.textColor === color;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateTextBox(text);
    scheduleSave();
    return true;
  };

  app.querySelectorAll("[data-text-color]").forEach((button) => {
    button.addEventListener("click", () => {
      recordHistory();
      setTextColor(button.dataset.textColor);
    });
  });
  colorPicker?.addEventListener("pointerdown", recordHistory);
  colorPicker?.addEventListener("input", () => setTextColor(colorPicker.value, { source: "picker" }));
  hexInput?.addEventListener("focus", recordHistory, { once: true });
  hexInput?.addEventListener("input", () => {
    const fullHex = hexInput.value.trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(fullHex)) setTextColor(fullHex, { source: "hex" });
  });
  hexInput?.addEventListener("change", () => {
    const color = normalizeHexColor(hexInput.value);
    if (color) setTextColor(color);
    else hexInput.value = textColor(selectedText());
  });
  rgbInput?.addEventListener("focus", recordHistory, { once: true });
  rgbInput?.addEventListener("input", () => {
    const color = rgbToHex(rgbInput.value);
    if (color) setTextColor(color, { source: "rgb" });
  });
  rgbInput?.addEventListener("change", () => {
    const color = rgbToHex(rgbInput.value);
    if (color) setTextColor(color);
    else rgbInput.value = formatRgb(textColor(selectedText()));
  });
  app.querySelectorAll("[data-copy-color]").forEach((button) => {
    button.addEventListener("click", () => {
      const color = textColor(selectedText());
      copyText(button.dataset.copyColor === "rgb" ? formatRgb(color) : color);
    });
  });

  app.querySelectorAll("[data-background-tone]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      recordHistory();
      text.background = button.dataset.backgroundTone;
      ensureBoxedTextContrast(text);
      refreshSelection();
      updateTextBox(text);
      scheduleSave();
    });
  });

  app.querySelectorAll("[data-background-shape]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      recordHistory();
      text.backgroundShape = button.dataset.backgroundShape;
      app.querySelectorAll("[data-background-shape]").forEach((item) => item.classList.toggle("is-active", item === button));
      updateTextBox(text);
      ensureTextFits(text);
      scheduleSave();
    });
  });

  const photoZoom = app.querySelector("#photo-zoom");
  photoZoom?.addEventListener("pointerdown", recordHistory);
  photoZoom?.addEventListener("input", () => {
    const slide = activeSlide();
    if (!slide) return;
    slide.imageScale = clamp(Number(photoZoom.value) || 1, 1, 3);
    constrainImagePosition(slide);
    updateStageImage(slide);
    const output = app.querySelector("#photo-zoom-output");
    if (output) output.textContent = `${Math.round(slide.imageScale * 100)}%`;
    scheduleSave();
  });
  app.querySelector('[data-action="reset-photo"]')?.addEventListener("click", () => {
    const slide = activeSlide();
    if (!slide) return;
    slide.imageScale = 1;
    slide.imageX = 0;
    slide.imageY = 0;
    updateStageImage(slide);
    if (photoZoom) photoZoom.value = 1;
    const output = app.querySelector("#photo-zoom-output");
    if (output) output.textContent = "100%";
    scheduleSave();
  });

  const rotationRange = app.querySelector("#overlay-rotation");
  const rotationNumber = app.querySelector("#overlay-rotation-number");
  const setRotation = (value) => {
    const overlay = selectedOverlay();
    if (!overlay) return;
    overlay.rotation = ((Number(value) || 0) % 360 + 360) % 360;
    if (rotationRange) rotationRange.value = Math.round(overlay.rotation);
    if (rotationNumber) rotationNumber.value = Math.round(overlay.rotation);
    const output = app.querySelector("#overlay-rotation-output");
    if (output) output.textContent = `${Math.round(overlay.rotation)}°`;
    updateOverlayBox(overlay);
    scheduleSave();
  };
  rotationRange?.addEventListener("input", () => setRotation(rotationRange.value));
  rotationNumber?.addEventListener("input", () => setRotation(rotationNumber.value));
}

function refreshSelection() {
  updateSelectionOutlines();
  const currentInspector = app.querySelector(".inspector");
  if (currentInspector) {
    currentInspector.outerHTML = renderInspector();
    app.querySelector('[data-action="delete-text"]')?.addEventListener("click", deleteSelectedText);
    app.querySelector('[data-action="delete-overlay"]')?.addEventListener("click", deleteSelectedOverlay);
    app.querySelector('[data-action="delete-selection"]')?.addEventListener("click", deleteSelectedLayers);
    app.querySelector('[data-action="done-crop"]')?.addEventListener("click", finishCrop);
    bindInspectorControls();
  }
}

function updateSelectionOutlines() {
  app.querySelectorAll(".text-box").forEach((box) => {
    const selected = isLayerSelected("text", box.dataset.textId);
    box.classList.toggle("is-selected", selected);
    box.setAttribute("aria-selected", String(selected));
  });
  app.querySelectorAll(".overlay-box").forEach((box) => {
    const selected = isLayerSelected("overlay", box.dataset.overlayId);
    box.classList.toggle("is-selected", selected);
    box.setAttribute("aria-selected", String(selected));
  });
  app.querySelector(".stage-frame")?.classList.toggle("has-multi-selection", selectedLayers().length > 1);
}

function beginMarqueeSelection(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const surface = app.querySelector(".workspace-inner");
  if (!surface) return;
  const additive = event.metaKey || event.ctrlKey;
  const baseKeys = additive ? [...selectedLayerKeys()] : [];
  const basePrimary = additive && selectedLayerKeys().length ? selectedLayerKeys().at(-1) : null;
  setLayerSelection(baseKeys, basePrimary);
  updateSelectionOutlines();

  const marquee = document.createElement("div");
  marquee.className = "selection-marquee";
  marquee.setAttribute("aria-hidden", "true");
  surface.appendChild(marquee);
  const surfaceRect = surface.getBoundingClientRect();
  const start = { x: event.clientX, y: event.clientY };
  let moved = false;
  try { surface.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }

  const move = (moveEvent) => {
    const left = Math.min(start.x, moveEvent.clientX);
    const top = Math.min(start.y, moveEvent.clientY);
    const right = Math.max(start.x, moveEvent.clientX);
    const bottom = Math.max(start.y, moveEvent.clientY);
    moved ||= Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) > 3;
    marquee.classList.toggle("is-visible", moved);
    marquee.style.left = `${left - surfaceRect.left}px`;
    marquee.style.top = `${top - surfaceRect.top}px`;
    marquee.style.width = `${right - left}px`;
    marquee.style.height = `${bottom - top}px`;
    if (!moved) return;

    const hitKeys = [...app.querySelectorAll(".text-box, .overlay-box")].flatMap((box) => {
      const rect = box.getBoundingClientRect();
      const intersects = rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      if (!intersects) return [];
      return [box.matches(".text-box")
        ? layerKey("text", box.dataset.textId)
        : layerKey("overlay", box.dataset.overlayId)];
    });
    const keys = [...new Set([...baseKeys, ...hitKeys])];
    setLayerSelection(keys, hitKeys.at(-1) || basePrimary);
    updateSelectionOutlines();
  };
  const end = () => {
    marquee.remove();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (!moved) setLayerSelection(baseKeys, basePrimary);
    refreshSelection();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function sizeStage() {
  const inner = app.querySelector(".workspace-inner");
  const workspace = app.querySelector(".workspace");
  const stage = app.querySelector(".stage");
  const slide = activeSlide();
  if (!inner || !workspace || !stage || !slide) return;
  const innerStyle = getComputedStyle(inner);
  const horizontalPadding = (parseFloat(innerStyle.paddingLeft) || 0) + (parseFloat(innerStyle.paddingRight) || 0);
  const verticalPadding = (parseFloat(innerStyle.paddingTop) || 0) + (parseFloat(innerStyle.paddingBottom) || 0);
  const availableWidth = Math.max(1, workspace.clientWidth - horizontalPadding);
  const availableHeight = Math.max(1, workspace.clientHeight - verticalPadding);
  const actions = inner.querySelector(".canvas-actions");
  const composition = inner.querySelector(".canvas-composition");
  const toolbarGap = composition ? parseFloat(getComputedStyle(composition).columnGap) || 0 : 0;
  const canvasWidth = Math.max(1, availableWidth - (actions?.offsetWidth || 0) - toolbarGap);
  const ratio = OUTPUT_WIDTH / OUTPUT_HEIGHT;
  let width = canvasWidth;
  let height = width / ratio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * ratio;
  }
  width *= state.canvasZoom;
  height *= state.canvasZoom;
  state.stageWidth = width;
  state.stageHeight = height;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.setProperty("--stage-scale", width / OUTPUT_WIDTH);
  updateStageImage(slide);
  activeSlide().texts.forEach(updateTextBox);
  (activeSlide().overlays || []).forEach(updateOverlayBox);
}

function setCanvasZoom(nextZoom, clientX, clientY) {
  const workspace = app.querySelector(".workspace");
  const stage = app.querySelector(".stage");
  if (!workspace || !stage) return;
  const zoom = clamp(nextZoom, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
  if (Math.abs(zoom - state.canvasZoom) < 0.0001) return;

  const oldRect = stage.getBoundingClientRect();
  const focalX = Number.isFinite(clientX) ? clamp(clientX, oldRect.left, oldRect.right) : oldRect.left + oldRect.width / 2;
  const focalY = Number.isFinite(clientY) ? clamp(clientY, oldRect.top, oldRect.bottom) : oldRect.top + oldRect.height / 2;
  const relativeX = oldRect.width ? (focalX - oldRect.left) / oldRect.width : 0.5;
  const relativeY = oldRect.height ? (focalY - oldRect.top) / oldRect.height : 0.5;

  state.canvasZoom = zoom;
  sizeStage();

  const newRect = stage.getBoundingClientRect();
  const newFocalX = newRect.left + relativeX * newRect.width;
  const newFocalY = newRect.top + relativeY * newRect.height;
  workspace.scrollLeft += newFocalX - focalX;
  workspace.scrollTop += newFocalY - focalY;
  const output = app.querySelector(".canvas-zoom-level");
  if (output) output.textContent = `${Math.round(state.canvasZoom * 100)}%`;
}

function getImageLayout(slide, canvasWidth, canvasHeight) {
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

function constrainImagePosition(slide) {
  const canvasWidth = state.stageWidth || OUTPUT_WIDTH;
  const canvasHeight = state.stageHeight || OUTPUT_HEIGHT;
  const layout = getImageLayout(slide, canvasWidth, canvasHeight);
  slide.imageX = clamp(slide.imageX || 0, -layout.maxOffsetX, layout.maxOffsetX);
  slide.imageY = clamp(slide.imageY || 0, -layout.maxOffsetY, layout.maxOffsetY);
}

function updateStageImage(slide) {
  const images = app.querySelectorAll(".stage-image, .stage-image-ghost");
  if (!images.length || !state.stageWidth || !state.stageHeight) return;
  const layout = getImageLayout(slide, state.stageWidth, state.stageHeight);
  images.forEach((image) => {
    image.style.width = `${layout.width}px`;
    image.style.height = `${layout.height}px`;
    image.style.left = `${layout.left}px`;
    image.style.top = `${layout.top}px`;
  });
}

function zoomPhotoAtPoint(slide, nextScale, clientX, clientY, stage) {
  const canvasWidth = state.stageWidth || stage.clientWidth;
  const canvasHeight = state.stageHeight || stage.clientHeight;
  if (!canvasWidth || !canvasHeight) return;
  const rect = stage.getBoundingClientRect();
  const focalX = clamp(clientX - rect.left, 0, canvasWidth);
  const focalY = clamp(clientY - rect.top, 0, canvasHeight);
  const currentLayout = getImageLayout(slide, canvasWidth, canvasHeight);
  const imagePointX = (focalX - currentLayout.left) / currentLayout.width;
  const imagePointY = (focalY - currentLayout.top) / currentLayout.height;

  slide.imageScale = clamp(nextScale, 1, 3);
  const nextLayout = getImageLayout(slide, canvasWidth, canvasHeight);
  slide.imageX = (focalX - imagePointX * nextLayout.width - (canvasWidth - nextLayout.width) / 2) / canvasWidth;
  slide.imageY = (focalY - imagePointY * nextLayout.height - (canvasHeight - nextLayout.height) / 2) / canvasHeight;
  constrainImagePosition(slide);
  updateStageImage(slide);
}

function updateTextBox(text) {
  const box = app.querySelector(`.text-box[data-text-id="${text.id}"]`);
  if (!box) return;
  box.style.left = `${text.x * 100}%`;
  box.style.top = `${text.y * 100}%`;
  box.style.width = `${text.width * 100}%`;
  box.style.height = `${text.height * 100}%`;
  box.style.transform = `rotate(${text.rotation || 0}deg)`;
  box.dataset.style = text.style;
  box.dataset.background = text.background || "white";
  box.dataset.boxShape = text.backgroundShape || "lines";
  box.dataset.align = textAlignment(text);
  const color = textColor(text);
  box.style.setProperty("--text-color", color);
  box.style.setProperty("--outline-color", outlineColorFor(color));
  const insideVisual = box.querySelector(".text-visual--inside");
  if (insideVisual) insideVisual.style.clipPath = layerClipCss(text.x, text.y, text.width, text.height);
  box.querySelectorAll(".text-content-wrap").forEach((contentWrap) => {
    contentWrap.style.textAlign = textAlignment(text);
  });
  box.querySelectorAll(".text-content").forEach((content) => {
    content.style.textAlign = textAlignment(text);
    content.style.alignItems = textAlignment(text) === "left" ? "flex-start" : textAlignment(text) === "right" ? "flex-end" : "center";
    content.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
    paintTextContent(text, content, box);
  });
  const editor = box.querySelector(".text-editor");
  if (editor) {
    editor.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
    editor.style.textAlign = textAlignment(text);
  }
}

const measureCanvas = typeof document === "undefined" ? null : document.createElement("canvas");

function measureFont(text) {
  const fontSize = text.size * ((state.stageWidth || DESIGN_WIDTH) / DESIGN_WIDTH);
  const context = measureCanvas.getContext("2d");
  context.font = `${TEXT_WEIGHT} ${fontSize}px "TikTok Sans"`;
  return { context, fontSize };
}

function wrappedLinesForBox(text, box) {
  const { context, fontSize } = measureFont(text);
  const maxWidth = Math.max(1, (box?.clientWidth || (state.stageWidth || DESIGN_WIDTH) * text.width) - fontSize * 0.32);
  return { lines: wrapText(context, text.text, maxWidth), fontSize, context };
}

function lineCornerRadii(widths, index, radius) {
  const width = widths[index] || 0;
  const above = widths[index - 1];
  const below = widths[index + 1];
  const slop = Math.max(2, radius * 0.2);
  const top = above == null || width > above + slop;
  const bottom = below == null || width > below + slop;
  return [top ? radius : 0, top ? radius : 0, bottom ? radius : 0, bottom ? radius : 0];
}

function lineJunctionCorners(widths, lineCenters, centerX, boxHeight, radius) {
  const corners = [];
  for (let index = 0; index < widths.length - 1; index += 1) {
    const upperWidth = widths[index] || 0;
    const lowerWidth = widths[index + 1] || 0;
    const sideGap = Math.abs(upperWidth - lowerWidth) / 2;
    if (sideGap <= Math.max(1, radius * 0.1)) continue;
    const cornerRadius = Math.min(radius, sideGap);

    if (upperWidth < lowerWidth) {
      const boundaryY = lineCenters[index + 1] - boxHeight / 2;
      corners.push(
        { cx: centerX - upperWidth / 2, cy: boundaryY, radius: cornerRadius, quadrant: "upper-left" },
        { cx: centerX + upperWidth / 2, cy: boundaryY, radius: cornerRadius, quadrant: "upper-right" },
      );
    } else {
      const boundaryY = lineCenters[index] + boxHeight / 2;
      corners.push(
        { cx: centerX - lowerWidth / 2, cy: boundaryY, radius: cornerRadius, quadrant: "lower-left" },
        { cx: centerX + lowerWidth / 2, cy: boundaryY, radius: cornerRadius, quadrant: "lower-right" },
      );
    }
  }
  return corners;
}

function roundedRectSvgPath(x, y, width, height, radii) {
  const [tl, tr, br, bl] = radii.map((value) => Math.max(0, Math.min(value, width / 2, height / 2)));
  return [
    `M ${x + tl} ${y}`,
    `H ${x + width - tr}`,
    `Q ${x + width} ${y} ${x + width} ${y + tr}`,
    `V ${y + height - br}`,
    `Q ${x + width} ${y + height} ${x + width - br} ${y + height}`,
    `H ${x + bl}`,
    `Q ${x} ${y + height} ${x} ${y + height - bl}`,
    `V ${y + tl}`,
    `Q ${x} ${y} ${x + tl} ${y}`,
    "Z",
  ].join(" ");
}

function concaveCornerSvgPath({ cx, cy, radius, quadrant }) {
  const paths = {
    "upper-left": `M ${cx} ${cy - radius} L ${cx} ${cy} L ${cx - radius} ${cy} A ${radius} ${radius} 0 0 0 ${cx} ${cy - radius} Z`,
    "upper-right": `M ${cx} ${cy - radius} L ${cx} ${cy} L ${cx + radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx} ${cy - radius} Z`,
    "lower-right": `M ${cx} ${cy + radius} L ${cx} ${cy} L ${cx + radius} ${cy} A ${radius} ${radius} 0 0 0 ${cx} ${cy + radius} Z`,
    "lower-left": `M ${cx} ${cy + radius} L ${cx} ${cy} L ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx} ${cy + radius} Z`,
  };
  return paths[quadrant];
}

function createPerLineBackground(text, widths, lineHeight, fontSize, contentWidth) {
  const namespace = "http://www.w3.org/2000/svg";
  const boxHeight = fontSize * BOX_LINE_HEIGHT;
  const radius = Math.min(fontSize * BOX_CORNER_RADIUS, boxHeight / 2);
  const junctionRadius = Math.min(fontSize * BOX_JUNCTION_RADIUS, boxHeight / 2);
  const height = (widths.length - 1) * lineHeight + boxHeight;
  const lineCenters = widths.map((_, index) => index * lineHeight + boxHeight / 2);
  const fill = text.background === "black" ? "#111111" : "#ffffff";
  const align = textAlignment(text);
  const lineStart = (width) => align === "left" ? 0 : align === "right" ? contentWidth - width : (contentWidth - width) / 2;
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "text-background");
  svg.setAttribute("viewBox", `0 0 ${contentWidth} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.style.height = `${height}px`;
  svg.style.top = `${(lineHeight - boxHeight) / 2}px`;

  widths.forEach((width, index) => {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", roundedRectSvgPath(
      lineStart(width),
      index * lineHeight,
      width,
      boxHeight,
      lineCornerRadii(widths, index, radius),
    ));
    path.setAttribute("fill", fill);
    svg.appendChild(path);
  });

  (align === "center" ? lineJunctionCorners(widths, lineCenters, contentWidth / 2, boxHeight, junctionRadius) : []).forEach((corner) => {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", concaveCornerSvgPath(corner));
    path.setAttribute("fill", fill);
    svg.appendChild(path);
  });
  return svg;
}

function paintTextContent(text, content, box) {
  const { lines, fontSize, context } = wrappedLinesForBox(text, box);
  const perLineBox = text.style === "boxed" && (text.backgroundShape || "lines") !== "full";
  const lineHeight = fontSize * (perLineBox ? BOX_TEXT_LINE_HEIGHT : TEXT_LINE_HEIGHT);
  const padX = fontSize * BOX_HORIZONTAL_PADDING;
  const widths = lines.map((line) => context.measureText(line || " ").width + (perLineBox ? padX * 2 : 0));
  const contentWidth = Math.max(1, content.clientWidth || box?.clientWidth || 1);
  const nodes = [];
  if (perLineBox) nodes.push(createPerLineBackground(text, widths, lineHeight, fontSize, contentWidth));

  nodes.push(...lines.map((line) => {
    if (text.style === "outline") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "text-line outline-line");
      svg.setAttribute("height", String(lineHeight));
      svg.setAttribute("width", "100%");
      const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
      const align = textAlignment(text);
      node.setAttribute("x", align === "left" ? "0" : align === "right" ? "100%" : "50%");
      node.setAttribute("y", "50%");
      node.setAttribute("text-anchor", align === "left" ? "start" : align === "right" ? "end" : "middle");
      node.setAttribute("dominant-baseline", "middle");
      node.setAttribute("fill", textColor(text));
      node.setAttribute("stroke", outlineColorFor(textColor(text)));
      node.setAttribute("stroke-width", String(fontSize * OUTLINE_RATIO));
      node.setAttribute("stroke-linejoin", "round");
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("paint-order", "stroke fill");
      node.setAttribute("font-family", "TikTok Sans, sans-serif");
      node.setAttribute("font-weight", String(TEXT_WEIGHT));
      node.setAttribute("font-size", `${fontSize}px`);
      node.textContent = line || " ";
      svg.appendChild(node);
      return svg;
    }
    const span = document.createElement("span");
    span.className = "text-line";
    span.textContent = line || "\u00a0";
    return span;
  }));
  content.replaceChildren(...nodes);
}

function updateOverlayBox(overlay) {
  const box = app.querySelector(`.overlay-box[data-overlay-id="${overlay.id}"]`);
  const asset = projectAsset(overlay.assetId);
  if (!box || !asset) return;
  const metrics = getOverlayMetrics(overlay, asset);
  const crop = overlayCrop(overlay);
  const cropping = overlay.id === state.croppingOverlayId;
  box.style.left = `${overlay.x * 100}%`;
  box.style.top = `${overlay.y * 100}%`;
  box.style.width = `${metrics.width * 100}%`;
  box.style.height = `${metrics.height * 100}%`;
  box.style.transform = `rotate(${overlay.rotation || 0}deg)`;
  const images = box.querySelectorAll(".overlay-image-clip img");
  images.forEach((image) => {
    if (cropping) {
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.left = "0";
      image.style.top = "0";
    } else {
      image.style.width = `${100 / crop.w}%`;
      image.style.height = `${100 / crop.h}%`;
      image.style.left = `${(-crop.x / crop.w) * 100}%`;
      image.style.top = `${(-crop.y / crop.h) * 100}%`;
    }
  });
  const inside = box.querySelector(".overlay-image-clip--inside");
  if (inside) inside.style.clipPath = overlayClipCss(overlay, asset);
  const cropRect = box.querySelector(".crop-rect");
  if (cropRect) {
    cropRect.style.left = `${crop.x * 100}%`;
    cropRect.style.top = `${crop.y * 100}%`;
    cropRect.style.width = `${crop.w * 100}%`;
    cropRect.style.height = `${crop.h * 100}%`;
  }
}

function ensureTextFits(text) {
  requestAnimationFrame(() => {
    const box = app.querySelector(`.text-box[data-text-id="${text.id}"]`);
    const contentWrap = box?.querySelector(".text-content-wrap");
    if (!box || !contentWrap || !state.stageHeight) return;
    const previousMaxHeight = contentWrap.style.maxHeight;
    contentWrap.style.maxHeight = "none";
    const neededPixels = contentWrap.scrollHeight + 4;
    contentWrap.style.maxHeight = previousMaxHeight;
    if (neededPixels <= box.clientHeight) return;

    const nextHeight = Math.min(1, neededPixels / state.stageHeight);
    text.height = nextHeight;
    updateTextBox(text);
    scheduleSave();
  });
}

function addText(point = null, { editDirectly = false } = {}) {
  const slide = activeSlide();
  if (!slide) return;
  recordHistory();
  const width = 0.64;
  const height = 0.08;
  const text = {
    id: uid(),
    text: "Your text",
    x: point ? clamp(point.x - width / 2, 0, 1 - width) : 0.18,
    y: point ? clamp(point.y - height / 2, 0, 1 - height) : 0.42,
    width,
    height,
    size: 64,
    style: "plain",
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
    color: "#FFFFFF",
    background: "white",
    backgroundShape: "lines",
    align: "center",
    rotation: 0,
    z: nextLayerZ(slide),
  };
  state.photoAdjustMode = false;
  slide.texts.push(text);
  selectOnlyLayer("text", text.id);
  state.mobileInspectorOpen = true;
  scheduleSave();
  renderEditor();
  requestAnimationFrame(() => {
    if (editDirectly) {
      app.querySelector(`.text-box[data-text-id="${text.id}"]`)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    } else {
      app.querySelector("#text-value")?.select();
    }
  });
}

function deleteSelectedText() {
  if (!state.selectedTextId) return;
  deleteSelectedLayers();
}

function clearSlideThumbnail(slideId) {
  const thumbnailUrl = state.thumbnailUrls.get(slideId);
  if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  state.thumbnailUrls.delete(slideId);
  state.thumbnailSignatures.delete(slideId);
  state.thumbnailVersions.delete(slideId);
}

function beginSlideBackgroundChange(slideId) {
  const project = activeProject();
  const slide = project?.slides.find((item) => item.id === slideId);
  const input = app.querySelector("#slide-background-upload");
  if (!project || !slide || !input) return;
  state.pendingSlideBackgroundTarget = { projectId: project.id, slideId };
  input.value = "";
  input.click();
}

async function handleSlideBackgroundChange(event) {
  const target = state.pendingSlideBackgroundTarget;
  state.pendingSlideBackgroundTarget = null;
  const files = [...event.target.files];
  event.target.value = "";
  const file = files.find(isImageFile);
  if (!file) {
    if (files.length) toast("Choose an image file.");
    return;
  }

  const project = activeProject();
  const slide = project?.slides.find((item) => item.id === target?.slideId);
  if (!target || !project || project.id !== target.projectId || !slide) return;

  try {
    const imageData = await fileToDataUrl(file);
    const dimensions = await getImageDimensions(imageData);
    recordHistory();
    slide.imageData = imageData;
    slide.width = dimensions.width;
    slide.height = dimensions.height;
    slide.backgroundRevision = uid();
    constrainImagePosition(slide);
    clearSlideThumbnail(slide.id);
    scheduleSave();
    renderEditor();
    toast("Slide background changed");
  } catch (error) {
    console.error(error);
    toast("That image couldn’t be used as the slide background.");
  }
}

function removeSlide(slideId) {
  const project = activeProject();
  if (!project) return;
  const index = project.slides.findIndex((item) => item.id === slideId);
  if (index < 0) return;

  recordHistory();
  project.slides.splice(index, 1);
  clearSlideThumbnail(slideId);

  if (state.activeSlideId === slideId) {
    state.activeSlideId = project.slides[index]?.id || project.slides[index - 1]?.id || null;
    clearLayerSelection();
    state.photoAdjustMode = false;
  }
  scheduleSave();
  renderEditor();
}

function clearSlideDropIndicators() {
  app.querySelectorAll(".slide-thumb.is-drop-before, .slide-thumb.is-drop-after")
    .forEach((item) => item.classList.remove("is-drop-before", "is-drop-after"));
}

function clearSlideDragGhost() {
  state.slideDragGhost?.remove();
  state.slideDragGhost = null;
}

function setSlideDragGhost(event, button) {
  clearSlideDragGhost();
  const thumbnail = button.querySelector(".thumb-image");
  if (!thumbnail || !event.dataTransfer) return;
  const rect = thumbnail.getBoundingClientRect();
  const ghost = thumbnail.cloneNode(true);
  ghost.classList.add("slide-drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, rect.width / 2, Math.min(32, rect.height / 2));
  state.slideDragGhost = ghost;
}

function reorderSlide(sourceId, targetId, placement) {
  const project = activeProject();
  if (!project || !sourceId || sourceId === targetId) return;
  const sourceIndex = project.slides.findIndex((slide) => slide.id === sourceId);
  if (sourceIndex < 0) return;
  const target = project.slides.find((slide) => slide.id === targetId);
  if (!target) return;

  recordHistory();
  const [movedSlide] = project.slides.splice(sourceIndex, 1);
  let targetIndex = project.slides.findIndex((slide) => slide.id === targetId);
  if (placement === "after") targetIndex += 1;
  project.slides.splice(targetIndex, 0, movedSlide);
  scheduleSave();
  renderEditor();
}

function bindSlideReordering() {
  const slideType = "application/x-slide-studio-slide";
  const buttons = [...app.querySelectorAll(".slide-thumb[data-slide-id]")];
  buttons.forEach((button) => {
    button.addEventListener("contextmenu", (event) => {
      showSlideMenu(event, button.dataset.slideId);
    });
    button.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      state.draggingSlideId = button.dataset.slideId;
      event.dataTransfer.setData(slideType, button.dataset.slideId);
      event.dataTransfer.setData("text/plain", `slide:${button.dataset.slideId}`);
      event.dataTransfer.effectAllowed = "move";
      setSlideDragGhost(event, button);
      requestAnimationFrame(() => button.classList.add("is-dragging"));
    });
    button.addEventListener("dragover", (event) => {
      if (!state.draggingSlideId || state.draggingSlideId === button.dataset.slideId) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const rect = button.getBoundingClientRect();
      const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      clearSlideDropIndicators();
      button.classList.add(placement === "before" ? "is-drop-before" : "is-drop-after");
    });
    button.addEventListener("drop", (event) => {
      const sourceId = event.dataTransfer.getData(slideType) || state.draggingSlideId;
      if (!sourceId || sourceId === button.dataset.slideId) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = button.getBoundingClientRect();
      const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      state.draggingSlideId = null;
      clearSlideDragGhost();
      clearSlideDropIndicators();
      reorderSlide(sourceId, button.dataset.slideId, placement);
    });
    button.addEventListener("dragend", () => {
      state.draggingSlideId = null;
      clearSlideDragGhost();
      button.classList.remove("is-dragging");
      clearSlideDropIndicators();
    });
  });
}

function bindAssetLibrary() {
  app.querySelectorAll(".asset-item").forEach((item) => {
    const assetId = item.dataset.assetId;
    const previewSrc = item.querySelector("img")?.src;
    item.addEventListener("pointerenter", (event) => {
      if (state.draggingAssetId || !previewSrc) return;
      showAssetPreview(previewSrc, event.clientX, event.clientY);
    });
    item.addEventListener("pointermove", (event) => {
      if (state.draggingAssetId) return hideAssetPreview();
      if (previewSrc) showAssetPreview(previewSrc, event.clientX, event.clientY);
    });
    item.addEventListener("pointerleave", hideAssetPreview);
    item.addEventListener("dragstart", (event) => {
      hideAssetPreview();
      state.draggingAssetId = assetId;
      event.dataTransfer.setData("application/x-slide-asset", assetId);
      event.dataTransfer.setData("text/plain", `asset:${assetId}`);
      event.dataTransfer.effectAllowed = "copyMove";
      item.classList.add("is-dragging");
    });
    item.addEventListener("dragend", () => {
      state.draggingAssetId = null;
      item.classList.remove("is-dragging");
      app.querySelector("[data-asset-trash]")?.classList.remove("is-hot");
      hideAssetPreview();
    });
  });
  app.querySelectorAll('[data-action="delete-asset"]').forEach((button) => {
    button.addEventListener("click", (event) => {
      showAssetDeleteMenu(event, button.dataset.assetId);
    });
  });
  bindAssetTrash();
}

function showAssetPreview(src, clientX, clientY) {
  let preview = document.querySelector(".asset-hover-preview");
  if (!preview) {
    preview = document.createElement("img");
    preview.className = "asset-hover-preview";
    preview.alt = "";
    document.body.appendChild(preview);
  }
  if (preview.getAttribute("src") !== src) preview.src = src;
  const pad = 16;
  const size = 240;
  let left = clientX + pad;
  let top = clientY + pad;
  if (left + size > window.innerWidth - 8) left = clientX - size - pad;
  if (top + size > window.innerHeight - 8) top = clientY - size - pad;
  preview.style.left = `${Math.max(8, left)}px`;
  preview.style.top = `${Math.max(8, top)}px`;
}

function hideAssetPreview() {
  document.querySelector(".asset-hover-preview")?.remove();
}

function bindAssetTrash() {
  const tray = app.querySelector("[data-asset-trash]");
  if (!tray) return;
  const isAssetDrag = (event) => Boolean(state.draggingAssetId) || [...event.dataTransfer.types].includes("application/x-slide-asset");
  tray.addEventListener("dragover", (event) => {
    if (!isAssetDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    tray.classList.add("is-hot");
  });
  tray.addEventListener("dragleave", (event) => {
    if (!tray.contains(event.relatedTarget)) tray.classList.remove("is-hot");
  });
  tray.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    tray.classList.remove("is-hot");
    const payload = event.dataTransfer.getData("application/x-slide-asset") || event.dataTransfer.getData("text/plain") || state.draggingAssetId || "";
    const assetId = payload.startsWith("asset:") ? payload.slice(6) : payload;
    state.draggingAssetId = null;
    if (assetId) deleteProjectAsset(assetId);
  });
}

function bindStageAssetDrop() {
  const stage = app.querySelector(".stage-frame") || app.querySelector(".stage");
  if (!stage) return;
  const hasAssetPayload = (event) => Boolean(state.draggingAssetId) || [...event.dataTransfer.types].includes("application/x-slide-asset");
  stage.addEventListener("dragover", (event) => {
    if (!hasAssetPayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    stage.classList.add("is-drop-target");
  });
  stage.addEventListener("dragleave", (event) => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove("is-drop-target");
  });
  stage.addEventListener("drop", (event) => {
    event.preventDefault();
    stage.classList.remove("is-drop-target");
    const payload = event.dataTransfer.getData("application/x-slide-asset") || event.dataTransfer.getData("text/plain");
    const assetId = payload.startsWith("asset:") ? payload.slice(6) : payload;
    if (!assetId) return;
    const rect = stage.getBoundingClientRect();
    addOverlayFromAsset(assetId, {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    });
  });
}

function bindImageFileDrops() {
  bindImageFileDropTarget(app.querySelector(".slide-rail"), async (files) => {
    await addSlidesFromFiles(files, { activateFirstNew: true });
  });
  bindImageFileDropTarget(app.querySelector(".workspace"), async (files, event) => {
    await addDroppedAssetsToSlide(files, event);
  });
}

function bindImageFileDropTarget(target, onDrop) {
  if (!target) return;
  let dragDepth = 0;
  const acceptsFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  target.addEventListener("dragenter", (event) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    target.classList.add("is-file-drop-target");
  });
  target.addEventListener("dragover", (event) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  target.addEventListener("dragleave", (event) => {
    if (!acceptsFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) target.classList.remove("is-file-drop-target");
  });
  target.addEventListener("drop", async (event) => {
    if (!acceptsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    target.classList.remove("is-file-drop-target");
    const files = imageFilesFromTransfer(event.dataTransfer);
    if (!files.length) {
      toast("Drop an image file here.");
      return;
    }
    if (state.fileDropBusy) return;
    state.fileDropBusy = true;
    try {
      await onDrop(files, event);
    } finally {
      state.fileDropBusy = false;
    }
  });
}

async function addDroppedAssetsToSlide(files, event) {
  const slide = activeSlide();
  if (!slide) {
    toast("Create a slide before adding an asset to the canvas.");
    return;
  }
  recordHistory();
  const assets = [];
  for (const [index, file] of files.entries()) {
    try {
      const asset = await createAssetFromFile(file, files.length > 1 ? `Dropped image ${index + 1}` : "Dropped image");
      if (asset) assets.push(asset);
    } catch (error) {
      console.error(error);
    }
  }
  if (!assets.length) {
    toast("Those images couldn’t be added.");
    return;
  }
  const stage = app.querySelector(".stage-frame");
  const rect = stage?.getBoundingClientRect();
  const droppedOnStage = rect
    && event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  const origin = droppedOnStage
    ? { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
    : { x: 0.5, y: 0.5 };
  assets.forEach((asset, index) => {
    addOverlayFromAsset(asset.id, {
      x: origin.x + index * 0.03,
      y: origin.y + index * 0.03,
    }, { render: false, record: false });
  });
  scheduleSave();
  renderEditor();
  toast(`${assets.length} ${assets.length === 1 ? "image" : "images"} added to the slide`);
}

function addOverlayFromAsset(assetId, point, { render = true, record = true } = {}) {
  const slide = activeSlide();
  const asset = projectAsset(assetId);
  if (!slide || !asset) {
    toast(slide ? "That asset is missing." : "Open a photo first, then drop the asset on it.");
    return null;
  }
  if (record) recordHistory();
  if (!slide.overlays) slide.overlays = [];
  const overlay = constrainOverlay({
    id: uid(),
    assetId: asset.id,
    x: 0.33,
    y: 0.36,
    width: initialOverlayWidth(asset),
    rotation: 0,
    z: nextLayerZ(slide),
  }, asset);
  const metrics = getOverlayMetrics(overlay, asset);
  if (point) {
    overlay.x = point.x - metrics.width / 2;
    overlay.y = point.y - metrics.height / 2;
    constrainOverlay(overlay, asset);
  }
  slide.overlays.push(overlay);
  state.photoAdjustMode = false;
  selectOnlyLayer("overlay", overlay.id);
  state.mobileInspectorOpen = true;
  if (render) {
    scheduleSave();
    renderEditor();
  }
  return overlay;
}

async function handleAssetUpload(event) {
  const files = [...event.target.files];
  event.target.value = "";
  if (!files.length) return;
  const project = activeProject();
  if (!project) return;
  recordHistory();
  if (!project.assets) project.assets = [];
  const button = app.querySelector('[data-action="upload-assets"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Adding…";
  }
  let added = 0;
  try {
    for (const file of files) {
      try {
        if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name)) continue;
        const imageData = await fileToDataUrl(file);
        const dimensions = await getImageDimensions(imageData);
        project.assets.push({
          id: uid(),
          name: file.name.replace(/\.[^.]+$/, "") || "Asset",
          imageData,
          width: dimensions.width,
          height: dimensions.height,
        });
        added += 1;
      } catch (error) {
        console.error(error);
      }
    }
    if (!added) {
      toast("Those files aren’t usable images.");
      renderEditor();
      return;
    }
    await putProject(project);
    toast(`${added} ${added === 1 ? "asset" : "assets"} uploaded`);
    renderEditor();
  } catch (error) {
    console.error(error);
    toast("One of those files couldn’t be added.");
    renderEditor();
  }
}

function deleteProjectAsset(assetId) {
  const project = activeProject();
  if (!project?.assets) return;
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) return;
  recordHistory();
  project.assets = project.assets.filter((item) => item.id !== assetId);
  project.slides.forEach((slide) => {
    slide.overlays = (slide.overlays || []).filter((overlay) => overlay.assetId !== assetId);
  });
  setLayerSelection(selectedLayerKeys());
  scheduleSave();
  renderEditor();
}

function deleteSelectedOverlay() {
  if (!state.selectedOverlayId) return;
  deleteSelectedLayers();
}

function deleteSelectedLayers() {
  const slide = activeSlide();
  const keys = new Set(selectedLayerKeys());
  if (!slide || !keys.size) return;
  recordHistory();
  exitCropMode({ apply: false });
  slide.texts = slide.texts.filter((text) => !keys.has(layerKey("text", text.id)));
  slide.overlays = (slide.overlays || []).filter((overlay) => !keys.has(layerKey("overlay", overlay.id)));
  setLayerSelection([]);
  scheduleSave();
  renderEditor();
}

function prepareLayerPointerSelection(event, kind, id) {
  const key = layerKey(kind, id);
  if ((event.metaKey || event.ctrlKey) && event.button === 0) {
    event.preventDefault();
    event.stopPropagation();
    toggleLayerSelection(kind, id);
    refreshSelection();
    return false;
  }
  if (isLayerSelected(kind, id)) setLayerSelection(selectedLayerKeys(), key);
  else selectOnlyLayer(kind, id);
  refreshSelection();
  return event.button !== 2;
}

function bindOverlayBox(box) {
  box.addEventListener("pointerdown", (event) => {
    if (state.photoAdjustMode) return;
    const corner = event.target.closest("[data-corner]")?.dataset.corner;
    const edge = event.target.closest("[data-edge]")?.dataset.edge;
    const rotate = event.target.closest("[data-rotate]");
    const cropHandle = event.target.closest("[data-crop]")?.dataset.crop;
    if (!prepareLayerPointerSelection(event, "overlay", box.dataset.overlayId)) return;
    if (state.croppingOverlayId && state.croppingOverlayId !== box.dataset.overlayId) {
      finishCrop();
      return;
    }
    if (state.croppingOverlayId === box.dataset.overlayId) {
      if (cropHandle) beginCropResize(event, box, cropHandle);
      else if (event.target.closest(".crop-rect")) beginCropMove(event, box);
      return;
    }
    if (rotate) beginOverlayRotate(event, box);
    else if (corner) beginOverlayResize(event, box, corner);
    else if (edge) beginOverlayResize(event, box, edge, { preserveAspect: false });
    else beginOverlayDrag(event, box);
  });
  box.addEventListener("contextmenu", (event) => {
    showLayerMenu(event, "overlay", box.dataset.overlayId);
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      deleteSelectedLayers();
    }
  });
}

function stagePoint(event) {
  const stage = app.querySelector(".stage");
  const rect = stage.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function rotateDelta(dx, dy, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

function pointerDeltaInLayerAxes(event, startEvent, degrees) {
  const rotated = rotateDelta(event.clientX - startEvent.clientX, event.clientY - startEvent.clientY, degrees);
  return {
    x: rotated.x / state.stageWidth,
    y: rotated.y / state.stageHeight,
  };
}

function layerOffsetToStage(dx, dy, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const pixelX = dx * state.stageWidth;
  const pixelY = dy * state.stageHeight;
  return {
    x: (pixelX * cos - pixelY * sin) / state.stageWidth,
    y: (pixelX * sin + pixelY * cos) / state.stageHeight,
  };
}

function resizeLayerRect(start, handle, delta, { minWidth, minHeight, maxWidth = Infinity, maxHeight = Infinity, preserveAspect = false } = {}) {
  let width = start.width;
  let height = start.height;
  let centerShiftX = 0;
  let centerShiftY = 0;
  if (preserveAspect) {
    const signX = handle.includes("e") ? 1 : -1;
    const signY = handle.includes("s") ? 1 : -1;
    const vectorX = signX * start.width * state.stageWidth;
    const vectorY = signY * start.height * state.stageHeight;
    const nextX = vectorX + delta.x * state.stageWidth;
    const nextY = vectorY + delta.y * state.stageHeight;
    const projectedScale = (nextX * vectorX + nextY * vectorY) / (vectorX ** 2 + vectorY ** 2 || 1);
    const scale = clamp(projectedScale, Math.max(minWidth / start.width, minHeight / start.height), Math.min(maxWidth / start.width, maxHeight / start.height));
    width = start.width * scale;
    height = start.height * scale;
    centerShiftX = signX * (width - start.width) / 2;
    centerShiftY = signY * (height - start.height) / 2;
  } else {
    if (handle.includes("e")) {
      width = clamp(start.width + delta.x, minWidth, maxWidth);
      centerShiftX = (width - start.width) / 2;
    }
    if (handle.includes("w")) {
      width = clamp(start.width - delta.x, minWidth, maxWidth);
      centerShiftX = (start.width - width) / 2;
    }
    if (handle.includes("s")) {
      height = clamp(start.height + delta.y, minHeight, maxHeight);
      centerShiftY = (height - start.height) / 2;
    }
    if (handle.includes("n")) {
      height = clamp(start.height - delta.y, minHeight, maxHeight);
      centerShiftY = (start.height - height) / 2;
    }
  }
  const stageShift = layerOffsetToStage(centerShiftX, centerShiftY, start.rotation);
  return {
    x: start.centerX + stageShift.x - width / 2,
    y: start.centerY + stageShift.y - height / 2,
    width,
    height,
  };
}

function localPointOnOverlay(event, overlay, asset) {
  const stage = app.querySelector(".stage");
  const rect = stage.getBoundingClientRect();
  const metrics = getOverlayMetrics(overlay, asset);
  const centerX = overlay.x + metrics.width / 2;
  const centerY = overlay.y + metrics.height / 2;
  const nx = (event.clientX - rect.left) / rect.width;
  const ny = (event.clientY - rect.top) / rect.height;
  const local = rotateDelta(nx - centerX, ny - centerY, overlay.rotation || 0);
  return {
    x: (centerX + local.x - overlay.x) / metrics.width,
    y: (centerY + local.y - overlay.y) / metrics.height,
  };
}

function applyCropValues(overlay, next) {
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

function beginCropResize(event, box, handle) {
  event.preventDefault();
  event.stopPropagation();
  const overlay = selectedOverlay();
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  recordHistory();
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const startCrop = overlayCrop(overlay);
  const startPoint = localPointOnOverlay(event, overlay, asset);
  const move = (moveEvent) => {
    const point = localPointOnOverlay(moveEvent, overlay, asset);
    const next = { ...startCrop };
    if (handle.includes("e")) next.w = startCrop.w + (point.x - startPoint.x);
    if (handle.includes("s")) next.h = startCrop.h + (point.y - startPoint.y);
    if (handle.includes("w")) {
      next.x = startCrop.x + (point.x - startPoint.x);
      next.w = startCrop.w - (point.x - startPoint.x);
      next.anchorX = startCrop.x + startCrop.w;
    }
    if (handle.includes("n")) {
      next.y = startCrop.y + (point.y - startPoint.y);
      next.h = startCrop.h - (point.y - startPoint.y);
      next.anchorY = startCrop.y + startCrop.h;
    }
    applyCropValues(overlay, next);
    updateOverlayBox(overlay);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginCropMove(event, box) {
  event.preventDefault();
  const overlay = selectedOverlay();
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const startCrop = overlayCrop(overlay);
  const startPoint = localPointOnOverlay(event, overlay, asset);
  const move = (moveEvent) => {
    const point = localPointOnOverlay(moveEvent, overlay, asset);
    applyCropValues(overlay, {
      x: startCrop.x + (point.x - startPoint.x),
      y: startCrop.y + (point.y - startPoint.y),
      w: startCrop.w,
      h: startCrop.h,
    });
    updateOverlayBox(overlay);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginOverlayDrag(event, box) {
  beginLayerDrag(event, box, "overlay");
}

function pointerOverTrash(event) {
  const trash = app.querySelector("[data-asset-trash]");
  if (!trash || !event) return false;
  const rect = trash.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function beginOverlayResize(event, box, handle, { preserveAspect = true } = {}) {
  event.preventDefault();
  event.stopPropagation();
  const overlay = selectedOverlay();
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  recordHistory();
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const startMetrics = getOverlayMetrics(overlay, asset);
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    width: overlay.width,
    x: overlay.x,
    y: overlay.y,
    height: startMetrics.height,
    centerX: overlay.x + overlay.width / 2,
    centerY: overlay.y + startMetrics.height / 2,
    rotation: overlay.rotation || 0,
  };
  const move = (moveEvent) => {
    const delta = pointerDeltaInLayerAxes(moveEvent, start, start.rotation);
    const next = resizeLayerRect(start, handle, delta, {
      minWidth: 0.04,
      minHeight: 0.025,
      maxWidth: 2.4,
      maxHeight: 2.4,
      preserveAspect,
    });
    overlay.x = next.x;
    overlay.y = next.y;
    overlay.width = next.width;
    overlay.height = next.height;
    constrainOverlay(overlay, asset);
    updateOverlayBox(overlay);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginOverlayRotate(event, box) {
  event.preventDefault();
  event.stopPropagation();
  const overlay = selectedOverlay();
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  recordHistory();
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const metrics = getOverlayMetrics(overlay, asset);
  const stage = app.querySelector(".stage");
  const rect = stage.getBoundingClientRect();
  const centerX = rect.left + (overlay.x + metrics.width / 2) * rect.width;
  const centerY = rect.top + (overlay.y + metrics.height / 2) * rect.height;
  const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
  const startRotation = overlay.rotation || 0;
  const move = (moveEvent) => {
    const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
    let degrees = startRotation + ((angle - startAngle) * 180) / Math.PI;
    if (moveEvent.shiftKey) degrees = Math.round(degrees / 15) * 15;
    overlay.rotation = ((degrees % 360) + 360) % 360;
    updateOverlayBox(overlay);
    const output = app.querySelector("#overlay-rotation-output");
    const range = app.querySelector("#overlay-rotation");
    const number = app.querySelector("#overlay-rotation-number");
    if (output) output.textContent = `${Math.round(overlay.rotation)}°`;
    if (range) range.value = Math.round(overlay.rotation);
    if (number) number.value = Math.round(overlay.rotation);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function bindTextBox(box) {
  const content = box.querySelector(".text-visual--inside .text-content");
  box.addEventListener("pointerdown", (event) => {
    const corner = event.target.closest("[data-corner]")?.dataset.corner;
    const edge = event.target.closest("[data-edge]")?.dataset.edge;
    const rotate = event.target.closest("[data-rotate]");
    const contentTarget = event.target.closest(".text-content, .text-editor");
    const wasSelected = isLayerSelected("text", box.dataset.textId);

    if (box.classList.contains("is-editing")) {
      if (contentTarget && !corner && !edge && !rotate) return;
      endTextEditing(box);
    } else if (wasSelected && contentTarget && event.button === 0 && !(event.metaKey || event.ctrlKey)) {
      event.stopPropagation();
      startTextEditing(box, { clientX: event.clientX, clientY: event.clientY });
      return;
    }

    if (!prepareLayerPointerSelection(event, "text", box.dataset.textId)) return;
    if (state.croppingOverlayId) {
      finishCrop();
      return;
    }
    if (rotate) beginTextRotate(event, box);
    else if (corner) beginResize(event, box, corner);
    else if (edge) beginResize(event, box, edge);
    else beginDrag(event, box);
  });
  box.addEventListener("contextmenu", (event) => {
    if (box.classList.contains("is-editing")) return;
    showLayerMenu(event, "text", box.dataset.textId);
  });
  box.addEventListener("dblclick", (event) => {
    if (box.classList.contains("is-editing")) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startTextEditing(box, { selectAll: true });
  });
  box.addEventListener("keydown", (event) => {
    if ((event.key === "Backspace" || event.key === "Delete") && !box.classList.contains("is-editing")) {
      event.preventDefault();
      deleteSelectedLayers();
    }
    if (event.key === "Enter" && !box.classList.contains("is-editing")) {
      event.preventDefault();
      box.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
  });
}

function activeTextEditingBox() {
  return app.querySelector(".text-box.is-editing");
}

function isInlineTextEditing() {
  return Boolean(activeTextEditingBox());
}

function placeTextCaret(content, clientX, clientY) {
  const selection = window.getSelection();
  if (!selection) return;
  let range = null;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(clientX, clientY);
    if (position && content.contains(position.offsetNode)) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  } else if (document.caretRangeFromPoint) {
    const candidate = document.caretRangeFromPoint(clientX, clientY);
    if (candidate && content.contains(candidate.startContainer)) range = candidate;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function startTextEditing(box, { selectAll = false, clientX = null, clientY = null } = {}) {
  const text = activeSlide()?.texts.find((item) => item.id === box?.dataset.textId);
  const content = box?.querySelector(".text-visual--inside .text-content");
  const contentWrap = content?.closest(".text-content-wrap");
  if (!box || !text || !content || !contentWrap) return;

  const otherEditingBox = activeTextEditingBox();
  if (otherEditingBox && otherEditingBox !== box) endTextEditing(otherEditingBox);
  if (!isLayerSelected("text", text.id) || selectedLayerKeys().length !== 1) {
    selectOnlyLayer("text", text.id);
    refreshSelection();
  }

  box.classList.add("is-editing", "is-selected");
  const editor = document.createElement("span");
  editor.className = "text-editor";
  editor.contentEditable = "true";
  editor.spellcheck = false;
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "Edit text layer");
  editor.setAttribute("aria-multiline", "true");
  editor.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
  editor.style.textAlign = textAlignment(text);
  editor.textContent = text.text || "";
  content.setAttribute("aria-hidden", "true");
  contentWrap.appendChild(editor);

  editor.addEventListener("input", () => {
    text.text = editor.innerText.replace(/\n$/, "");
    box.querySelectorAll(".text-content").forEach((renderedContent) => {
      paintTextContent(text, renderedContent, box);
    });
    const textarea = app.querySelector("#text-value");
    if (textarea) textarea.value = text.text;
    ensureTextFits(text);
    scheduleSave();
  });
  editor.addEventListener("blur", () => endTextEditing(box));
  editor.focus({ preventScroll: true });

  const selection = window.getSelection();
  if (selectAll && selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  } else if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    placeTextCaret(editor, clientX, clientY);
  }
}

function endTextEditing(box = activeTextEditingBox(), { deselect = false } = {}) {
  if (!box) return;
  const content = box.querySelector(".text-visual--inside .text-content");
  const wasEditing = box.classList.contains("is-editing");
  if (!wasEditing) return;
  const editor = box.querySelector(".text-editor");
  box.classList.remove("is-editing");
  editor?.remove();
  content?.removeAttribute("aria-hidden");
  window.getSelection()?.removeAllRanges();

  const text = activeSlide()?.texts.find((item) => item.id === box.dataset.textId);
  if (wasEditing && text) updateTextBox(text);
  if (deselect && isLayerSelected("text", box.dataset.textId)) {
    clearLayerSelection();
    refreshSelection();
  }
}

function beginDrag(event, box) {
  beginLayerDrag(event, box, "text");
}

function beginLayerDrag(event, box, draggedKind) {
  event.preventDefault();
  const layers = selectedLayers();
  if (!layers.length) return;
  recordHistory();
  const draggingBoxes = layers.flatMap(({ kind, item }) => {
    const selector = kind === "text"
      ? `.text-box[data-text-id="${item.id}"]`
      : `.overlay-box[data-overlay-id="${item.id}"]`;
    const element = app.querySelector(selector);
    if (element) element.classList.add("is-dragging");
    return element ? [element] : [];
  });
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    layers: layers.map((entry) => ({ ...entry, x: entry.item.x, y: entry.item.y })),
  };
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.clientX) / state.stageWidth;
    const dy = (moveEvent.clientY - start.clientY) / state.stageHeight;
    start.layers.forEach((entry) => {
      entry.item.x = entry.x + dx;
      entry.item.y = entry.y + dy;
      if (entry.kind === "text") updateTextBox(entry.item);
      else updateOverlayBox(entry.item);
    });
    if (draggedKind === "overlay") {
      app.querySelector("[data-asset-trash]")?.classList.toggle("is-hot", pointerOverTrash(moveEvent));
    }
    scheduleSave();
  };
  const end = (endEvent) => {
    draggingBoxes.forEach((element) => element.classList.remove("is-dragging"));
    app.querySelector("[data-asset-trash]")?.classList.remove("is-hot");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    if (draggedKind === "overlay" && pointerOverTrash(endEvent || event)) deleteSelectedLayers();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginResize(event, box, handle) {
  event.preventDefault();
  event.stopPropagation();
  const text = selectedText();
  if (!text) return;
  recordHistory();
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: text.x,
    y: text.y,
    width: text.width,
    height: text.height,
    centerX: text.x + text.width / 2,
    centerY: text.y + text.height / 2,
    rotation: text.rotation || 0,
  };
  const minWidth = 0.1;
  const minHeight = 0.045;
  const move = (moveEvent) => {
    const delta = pointerDeltaInLayerAxes(moveEvent, start, start.rotation);
    const next = resizeLayerRect(start, handle, delta, {
      minWidth,
      minHeight,
    });
    text.width = next.width;
    text.height = next.height;
    text.x = next.x;
    text.y = next.y;
    updateTextBox(text);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginTextRotate(event, box) {
  event.preventDefault();
  event.stopPropagation();
  const text = selectedText();
  if (!text) return;
  recordHistory();
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const stage = app.querySelector(".stage");
  const rect = stage.getBoundingClientRect();
  const centerX = rect.left + (text.x + text.width / 2) * rect.width;
  const centerY = rect.top + (text.y + text.height / 2) * rect.height;
  const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
  const startRotation = text.rotation || 0;
  const move = (moveEvent) => {
    const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
    let degrees = startRotation + ((angle - startAngle) * 180) / Math.PI;
    if (moveEvent.shiftKey) degrees = Math.round(degrees / 15) * 15;
    text.rotation = ((degrees % 360) + 360) % 360;
    updateTextBox(text);
    scheduleSave();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginImageDrag(event, stage) {
  event.preventDefault();
  const slide = activeSlide();
  if (!slide) return;
  recordHistory();
  stage.classList.add("is-moving-photo");
  try { stage.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    imageX: slide.imageX || 0,
    imageY: slide.imageY || 0,
  };
  const move = (moveEvent) => {
    slide.imageX = start.imageX + (moveEvent.clientX - start.clientX) / state.stageWidth;
    slide.imageY = start.imageY + (moveEvent.clientY - start.clientY) / state.stageHeight;
    constrainImagePosition(slide);
    updateStageImage(slide);
    scheduleSave();
  };
  const end = () => {
    stage.classList.remove("is-moving-photo");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function handleUpload(event) {
  const files = [...event.target.files];
  event.target.value = "";
  await addSlidesFromFiles(files);
}

async function addSlidesFromFiles(files, { activateFirstNew = false } = {}) {
  const imageFiles = files.filter(isImageFile);
  if (!imageFiles.length) {
    if (files.length) toast("Drop an image file here.");
    return;
  }
  const project = activeProject();
  if (!project) return;
  recordHistory();
  const button = app.querySelector('[data-action="upload"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Adding…";
  }
  const addedSlides = [];
  try {
    for (const file of imageFiles) {
      try {
        const imageData = await fileToDataUrl(file);
        const dimensions = await getImageDimensions(imageData);
        const slide = {
          id: uid(),
          name: file.name.replace(/\.[^.]+$/, "") || "Slide",
          imageData,
          width: dimensions.width,
          height: dimensions.height,
          imageScale: 1,
          imageX: 0,
          imageY: 0,
          texts: [],
          overlays: [],
        };
        project.slides.push(slide);
        addedSlides.push(slide);
      } catch (error) {
        console.error(error);
      }
    }
    if (!addedSlides.length) {
      toast("Those images couldn’t be added as slides.");
      renderEditor();
      return;
    }
    if (!state.activeSlideId || activateFirstNew) state.activeSlideId = addedSlides[0].id;
    clearLayerSelection();
    scheduleSave();
    toast(`${addedSlides.length} ${addedSlides.length === 1 ? "slide" : "slides"} added`);
    renderEditor();
  } catch (error) {
    console.error(error);
    toast("One of those images couldn’t be added as a slide.");
    renderEditor();
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(src) {
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

async function renderSlideCanvas(slide, width = OUTPUT_WIDTH, height = OUTPUT_HEIGHT) {
  await document.fonts.load(`${TEXT_WEIGHT} 64px "TikTok Sans"`);
  const image = await loadImage(slide.imageData);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const imageLayout = getImageLayout(slide, width, height);
  context.drawImage(image, imageLayout.left, imageLayout.top, imageLayout.width, imageLayout.height);
  await drawSlideLayers(context, slide, width, height);
  return canvas;
}

async function renderSlideBlob(slide = activeSlide()) {
  if (!slide) return null;
  const canvas = await renderSlideCanvas(slide);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
}

function slideExportName(slide = activeSlide(), index = null) {
  const order = index == null ? "" : `${String(index + 1).padStart(2, "0")}-`;
  return `${order}${safeFilename(activeProject().name)}-${safeFilename(slide.name)}.png`;
}

async function exportActiveSlide() {
  const slide = activeSlide();
  if (!slide) return;
  const exportButton = app.querySelector('[data-action="export"]');
  const oldLabel = exportButton?.innerHTML;
  if (exportButton) {
    exportButton.disabled = true;
    exportButton.textContent = "Rendering…";
  }
  try {
    const blob = await renderSlideBlob();
    if (!blob) throw new Error("Could not create PNG");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = slideExportName();
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("PNG downloaded at full resolution");
  } catch (error) {
    console.error(error);
    toast("The image couldn’t be downloaded.");
  } finally {
    if (exportButton) {
      exportButton.disabled = false;
      exportButton.innerHTML = oldLabel;
    }
  }
}

async function shareActiveSlide() {
  const slide = activeSlide();
  if (!slide) return;
  const shareButton = app.querySelector('[data-action="share"]');
  const oldLabel = shareButton?.innerHTML;
  if (shareButton) {
    shareButton.disabled = true;
    shareButton.textContent = "Preparing…";
  }
  try {
    const blob = await renderSlideBlob();
    if (!blob) throw new Error("Could not create PNG");
    const file = new File([blob], slideExportName(), { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: activeProject().name });
    } else if (navigator.share) {
      const url = URL.createObjectURL(blob);
      try {
        await navigator.share({ title: activeProject().name, url });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } else {
      toast("Sharing isn’t available in this browser. Use Download PNG.");
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error(error);
    toast("Couldn’t open the share menu.");
  } finally {
    if (shareButton) {
      shareButton.disabled = false;
      shareButton.innerHTML = oldLabel;
    }
  }
}

async function shareAllSlides() {
  const project = activeProject();
  if (!project?.slides.length) return;
  const shareButton = app.querySelector('[data-action="share-all"]');
  const shareButtons = [...app.querySelectorAll(".share-button")];
  const oldLabel = shareButton?.innerHTML;
  shareButtons.forEach((button) => { button.disabled = true; });
  try {
    let files = state.shareAllCache?.projectId === project.id
      && state.shareAllCache?.projectUpdatedAt === project.updatedAt
      ? state.shareAllCache.files
      : null;
    if (!files) {
      files = [];
      for (const [index, slide] of project.slides.entries()) {
        if (shareButton) shareButton.textContent = `Preparing ${index + 1}/${project.slides.length}…`;
        const blob = await renderSlideBlob(slide);
        if (!blob) throw new Error(`Could not create PNG for slide ${index + 1}`);
        files.push(new File([blob], slideExportName(slide, index), { type: "image/png" }));
      }
      state.shareAllCache = {
        projectId: project.id,
        projectUpdatedAt: project.updatedAt,
        files,
      };
    }
    if (navigator.canShare?.({ files })) {
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        toast("Slides are ready — tap AirDrop all again.");
        return;
      }
      await navigator.share({ files });
      state.shareAllCache = null;
    } else {
      state.shareAllCache = null;
      toast("This browser can’t share multiple images at once.");
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (error?.name === "NotAllowedError" && state.shareAllCache) {
      toast("Slides are ready — tap AirDrop all again.");
      return;
    }
    state.shareAllCache = null;
    console.error(error);
    toast("Couldn’t open the share menu for all slides.");
  } finally {
    shareButtons.forEach((button) => { button.disabled = false; });
    if (shareButton) shareButton.innerHTML = oldLabel;
  }
}

async function drawSlideLayers(context, slide, canvasWidth, canvasHeight) {
  for (const { kind, item } of slideItems(slide)) {
    if (kind === "overlay") await drawOneOverlay(context, item, canvasWidth, canvasHeight);
    else drawTextLayer(context, item, canvasWidth, canvasHeight);
  }
}

async function drawOneOverlay(context, overlay, canvasWidth, canvasHeight) {
  const asset = projectAsset(overlay.assetId);
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

function drawTextLayer(context, text, imageWidth, imageHeight) {
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
  const lines = wrapText(context, text.text, Math.max(1, width - fontSize * 0.32));
  const visibleLineCount = Math.max(1, Math.floor((height - verticalPadding * 2) / lineHeight));
  const visibleLines = lines.slice(0, visibleLineCount);
  const blockHeight = visibleLines.length * lineHeight;
  const startY = y + (height - blockHeight) / 2 + lineHeight / 2;
  const pillWidths = visibleLines.map((line) => Math.min(width, context.measureText(line || " ").width + horizontalPadding * 2));
  const textX = align === "left" ? x + fontSize * 0.16 : align === "right" ? x + width - fontSize * 0.16 : x + width / 2;
  const pillStart = (pillWidth) => align === "left" ? x : align === "right" ? x + width - pillWidth : x + (width - pillWidth) / 2;

  if (text.style === "boxed" && text.backgroundShape === "full") {
    context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
    roundedRect(context, x, y, width, height, Math.min(fontSize * 0.18, width / 2, height / 2));
    context.fill();
  }

  if (perLineBox) {
    const backgroundHeight = fontSize * BOX_LINE_HEIGHT;
    const radius = Math.min(fontSize * BOX_CORNER_RADIUS, backgroundHeight / 2);
    const junctionRadius = Math.min(fontSize * BOX_JUNCTION_RADIUS, backgroundHeight / 2);
    const lineCenters = visibleLines.map((_, index) => startY + index * lineHeight);
    context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
    visibleLines.forEach((line, index) => {
      if (!line) return;
      const backgroundWidth = pillWidths[index];
      roundedRect(
        context,
        pillStart(backgroundWidth),
        lineCenters[index] - backgroundHeight / 2,
        backgroundWidth,
        backgroundHeight,
        lineCornerRadii(pillWidths, index, radius),
      );
      context.fill();
    });
    (align === "center" ? lineJunctionCorners(pillWidths, lineCenters, x + width / 2, backgroundHeight, junctionRadius) : [])
      .forEach((corner) => fillConcaveCorner(context, corner));
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

function wrapText(context, value, maxWidth) {
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

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fillConcaveCorner(context, { cx, cy, radius, quadrant }) {
  const shapes = {
    "upper-left": {
      start: [cx, cy - radius],
      corner: [cx, cy],
      arcStart: [cx - radius, cy],
      arc: [cx - radius, cy - radius, Math.PI * 0.5, 0, true],
    },
    "upper-right": {
      start: [cx, cy - radius],
      corner: [cx, cy],
      arcStart: [cx + radius, cy],
      arc: [cx + radius, cy - radius, Math.PI * 0.5, Math.PI, false],
    },
    "lower-right": {
      start: [cx, cy + radius],
      corner: [cx, cy],
      arcStart: [cx + radius, cy],
      arc: [cx + radius, cy + radius, -Math.PI * 0.5, -Math.PI, true],
    },
    "lower-left": {
      start: [cx, cy + radius],
      corner: [cx, cy],
      arcStart: [cx - radius, cy],
      arc: [cx - radius, cy + radius, -Math.PI * 0.5, 0, false],
    },
  }[quadrant];
  context.beginPath();
  context.moveTo(...shapes.start);
  context.lineTo(...shapes.corner);
  context.lineTo(...shapes.arcStart);
  context.arc(shapes.arc[0], shapes.arc[1], radius, shapes.arc[2], shapes.arc[3], shapes.arc[4]);
  context.closePath();
  context.fill();
}

function safeFilename(value) {
  return String(value || "slide")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "slide";
}

function isEditingTextTarget(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable]"));
}

function isCopiedLayer(value) {
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

function parseCopiedLayer(value) {
  if (!value || !String(value).trim().startsWith("{")) return null;
  try {
    const copied = JSON.parse(value);
    return isCopiedLayer(copied) ? copied : null;
  } catch {
    return null;
  }
}

function rememberCopiedLayer(copied) {
  state.copiedLayer = copied;
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(copied));
  } catch (error) {
    console.warn("Could not share the copied layer with other tabs.", error);
  }
}

function storedCopiedLayer(token) {
  try {
    const copied = parseCopiedLayer(localStorage.getItem(CLIPBOARD_STORAGE_KEY));
    return copied?.token === token ? copied : null;
  } catch {
    return null;
  }
}

function handleLayerCopy(event) {
  if (!activeSlide() || isInlineTextEditing() || isEditingTextTarget(event.target)) return;
  const layers = slideItems(activeSlide()).filter(({ kind, item }) => isLayerSelected(kind, item.id));
  if (!layers.length) return;
  const copies = layers.flatMap(({ kind, item }) => {
    if (kind === "text") return [{ kind, item: { ...item } }];
    const asset = projectAsset(item.assetId);
    return asset ? [{ kind, item: { ...item }, asset: { ...asset } }] : [];
  });
  if (!copies.length) return;
  const token = uid();
  const copied = { token, layers: copies };
  rememberCopiedLayer(copied);
  event.preventDefault();
  event.clipboardData?.setData(CLIPBOARD_LAYER_TYPE, JSON.stringify(copied));
  event.clipboardData?.setData("text/plain", `slide-studio-layer:${token}`);
  toast(copies.length === 1
    ? `${copies[0].kind === "overlay" ? "Asset" : "Text"} copied`
    : `${copies.length} layers copied`);
}

function copiedLayerFromClipboard(clipboardData) {
  if (!clipboardData) return null;
  const clipboardLayer = parseCopiedLayer(clipboardData.getData(CLIPBOARD_LAYER_TYPE));
  let token = clipboardLayer?.token || clipboardData.getData(CLIPBOARD_LAYER_TYPE);
  if (!token) {
    const text = clipboardData.getData("text/plain");
    if (text.startsWith("slide-studio-layer:")) token = text.slice("slide-studio-layer:".length);
  }
  if (!token) return null;
  if (token === state.copiedLayer?.token) return state.copiedLayer;
  const copied = storedCopiedLayer(token) || clipboardLayer;
  if (!copied || copied.token !== token) return null;
  state.copiedLayer = copied;
  return copied;
}

function pasteCopiedLayer(copied) {
  const project = activeProject();
  const slide = activeSlide();
  const layers = copied?.layers || [];
  if (!project || !slide || !layers.length) return false;
  if (layers.some((layer) => layer.kind === "overlay" && !layer.asset)) return false;
  const offset = 0.03;
  const pastedLayers = [];
  const pastedKeys = [];
  let nextZ = nextLayerZ(slide);
  recordHistory();
  if (!Array.isArray(project.assets)) project.assets = [];
  if (!Array.isArray(slide.overlays)) slide.overlays = [];
  layers.forEach((layer) => {
    if (layer.kind === "overlay") {
      let asset = project.assets.find((item) => (
        (layer.asset.fingerprint && item.fingerprint === layer.asset.fingerprint)
        || item.imageData === layer.asset.imageData
      ));
      if (!asset) {
        asset = { ...layer.asset, id: uid() };
        project.assets.push(asset);
      }
      const pasted = constrainOverlay({
        ...layer.item,
        id: uid(),
        assetId: asset.id,
        x: layer.item.x + offset,
        y: layer.item.y + offset,
        z: nextZ,
      }, asset);
      nextZ += 1;
      slide.overlays.push(pasted);
      pastedLayers.push({ kind: "overlay", item: { ...pasted }, asset: { ...asset } });
      pastedKeys.push(layerKey("overlay", pasted.id));
      return;
    }
    const pasted = {
      ...layer.item,
      id: uid(),
      x: clamp(layer.item.x + offset, 0, 1 - layer.item.width),
      y: clamp(layer.item.y + offset, 0, 1 - layer.item.height),
      z: nextZ,
    };
    nextZ += 1;
    slide.texts.push(pasted);
    pastedLayers.push({ kind: "text", item: { ...pasted } });
    pastedKeys.push(layerKey("text", pasted.id));
  });
  copied.layers = pastedLayers;
  setLayerSelection(pastedKeys);
  state.photoAdjustMode = false;
  state.mobileInspectorOpen = true;
  scheduleSave();
  renderEditor();
  toast(pastedLayers.length === 1
    ? `${pastedLayers[0].kind === "overlay" ? "Asset" : "Text"} pasted`
    : `${pastedLayers.length} layers pasted`);
  return true;
}

function isImageFile(file) {
  if (!file) return false;
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name || "");
}

function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const listed = clipboardData.files ? [...clipboardData.files].filter(isImageFile) : [];
  if (listed.length) return listed;
  if (!clipboardData.items) return [];
  return [...clipboardData.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(isImageFile);
}

function imageFilesFromTransfer(dataTransfer) {
  if (!dataTransfer) return [];
  const listed = dataTransfer.files ? [...dataTransfer.files].filter(isImageFile) : [];
  if (listed.length) return listed;
  if (!dataTransfer.items) return [];
  return [...dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(isImageFile);
}

async function fingerprintData(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createAssetFromFile(file, fallbackName = "Pasted image") {
  const project = activeProject();
  if (!project) return null;
  if (!project.assets) project.assets = [];
  const imageData = await fileToDataUrl(file);
  const fingerprint = await fingerprintData(imageData);
  const existing = project.assets.find((asset) => asset.fingerprint === fingerprint || asset.imageData === imageData);
  if (existing) {
    if (!existing.fingerprint) existing.fingerprint = fingerprint;
    return existing;
  }
  const dimensions = await getImageDimensions(imageData);
  const asset = {
    id: uid(),
    name: String(file.name || fallbackName).replace(/\.[^.]+$/, "") || fallbackName,
    imageData,
    width: dimensions.width,
    height: dimensions.height,
    fingerprint,
  };
  project.assets.push(asset);
  return asset;
}

async function handleClipboardPaste(event) {
  if (!activeProject() || isInlineTextEditing() || isEditingTextTarget(event.target) || state.pasteBusy) return;
  const copiedLayer = copiedLayerFromClipboard(event.clipboardData);
  if (copiedLayer) {
    event.preventDefault();
    pasteCopiedLayer(copiedLayer);
    return;
  }
  const files = clipboardImageFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  state.pasteBusy = true;
  recordHistory();
  const assets = [];
  try {
    for (const [index, file] of files.entries()) {
      try {
        const asset = await createAssetFromFile(file, files.length > 1 ? `Pasted image ${index + 1}` : "Pasted image");
        if (asset) assets.push(asset);
      } catch (error) {
        console.error(error);
      }
    }
    if (!assets.length) {
      toast("That clipboard image couldn’t be added.");
      return;
    }
    const slide = activeSlide();
    if (slide) {
      assets.forEach((asset, index) => {
        addOverlayFromAsset(asset.id, { x: 0.5 + index * 0.03, y: 0.5 + index * 0.03 }, { render: false, record: false });
      });
    }
    scheduleSave();
    renderEditor();
    toast(slide
      ? `${assets.length} ${assets.length === 1 ? "image" : "images"} pasted onto the photo`
      : `${assets.length} ${assets.length === 1 ? "asset" : "assets"} added`);
  } finally {
    state.pasteBusy = false;
  }
}

async function init() {
  try {
    state.db = await openDatabase();
    state.projects = await getAllProjects();
    state.projects.forEach((project) => {
      if (!Array.isArray(project.assets)) project.assets = [];
      project.slides.forEach((slide) => {
        if (slide.imageScale == null) slide.imageScale = 1;
        if (slide.imageX == null) slide.imageX = 0;
        if (slide.imageY == null) slide.imageY = 0;
        if (!Array.isArray(slide.overlays)) slide.overlays = [];
        slide.overlays.forEach((overlay, index) => {
          const asset = project.assets.find((item) => item.id === overlay.assetId);
          if (overlay.height == null && asset) {
            const crop = overlayCrop(overlay);
            overlay.height = overlay.width * (OUTPUT_WIDTH / OUTPUT_HEIGHT) * ((asset.height * crop.h) / (asset.width * crop.w));
          }
          if (overlay.z == null) overlay.z = index + 1;
        });
        slide.texts.forEach((text, index) => {
          if (text.outlineWidth == null) text.outlineWidth = DEFAULT_OUTLINE_WIDTH;
          if (!normalizeHexColor(text.color)) text.color = textColor(text);
          if (!text.background) text.background = "white";
          if (!text.backgroundShape) text.backgroundShape = "full";
          if (!text.align) text.align = "center";
          if (text.rotation == null) text.rotation = 0;
          if (text.z == null) text.z = (slide.overlays?.length || 0) + index + 1;
        });
      });
    });
  } catch (error) {
    console.error(error);
    state.projects = [];
    toast("Browser storage is unavailable. Projects won’t persist.");
  }
  renderDashboard();
  bindGlobalActions();
  document.addEventListener("paste", (event) => {
    handleClipboardPaste(event);
  });
  document.addEventListener("copy", handleLayerCopy);
  document.addEventListener("pointerdown", (event) => {
    const editingBox = activeTextEditingBox();
    if (editingBox && event.target.closest(".text-box") !== editingBox) {
      endTextEditing(editingBox, { deselect: !event.target.closest(".inspector") });
    }
    const title = document.activeElement;
    if (title?.classList?.contains("project-title-input") && !event.target.closest(".project-title-input")) {
      title.blur();
    }
    if (!event.target.closest(".layer-menu")) closeLayerMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLayerMenu();
      const editingBox = activeTextEditingBox();
      if (editingBox) {
        event.preventDefault();
        endTextEditing(editingBox);
        editingBox.focus({ preventScroll: true });
      }
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && app.querySelector(".stage")) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setCanvasZoom(state.canvasZoom * 1.2);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        setCanvasZoom(state.canvasZoom / 1.2);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        setCanvasZoom(1);
        return;
      }
    }
    if (meta && event.key.toLowerCase() === "z") {
      if (isEditingTextTarget(event.target)) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "y") {
      if (isEditingTextTarget(event.target)) return;
      event.preventDefault();
      redo();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !isEditingTextTarget(event.target)) {
      if (selectedLayerKeys().length) {
        event.preventDefault();
        deleteSelectedLayers();
      }
    }
  });
}

init();
