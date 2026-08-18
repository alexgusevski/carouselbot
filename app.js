const DB_NAME = "slide-studio-db";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const DESIGN_WIDTH = 1080;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const DEFAULT_OUTLINE_WIDTH = 14;

const state = {
  projects: [],
  activeProjectId: null,
  activeSlideId: null,
  selectedTextId: null,
  selectedOverlayId: null,
  db: null,
  stageWidth: 0,
  stageHeight: 0,
  saveTimer: null,
  toastTimer: null,
  mobileInspectorOpen: false,
  photoAdjustMode: false,
  showTikTokOverlay: false,
  draggingAssetId: null,
  croppingOverlayId: null,
};

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
  const height = width * (OUTPUT_WIDTH / OUTPUT_HEIGHT) * aspect;
  return { width, height };
}

function overlayPositionLimits(metrics) {
  const minVisible = 0.06;
  return {
    minX: minVisible - metrics.width,
    maxX: 1 - minVisible,
    minY: minVisible - metrics.height,
    maxY: 1 - minVisible,
  };
}

function constrainOverlay(overlay, asset = projectAsset(overlay.assetId)) {
  if (!asset) return overlay;
  overlay.width = clamp(Number(overlay.width) || 0.34, 0.04, 1.6);
  const metrics = getOverlayMetrics(overlay, asset);
  const limits = overlayPositionLimits(metrics);
  overlay.x = clamp(overlay.x, limits.minX, limits.maxX);
  overlay.y = clamp(overlay.y, limits.minY, limits.maxY);
  overlay.rotation = ((Number(overlay.rotation) || 0) % 360 + 360) % 360;
  return overlay;
}

function clearLayerSelection() {
  exitCropMode();
  state.selectedTextId = null;
  state.selectedOverlayId = null;
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
  const slide = activeSlide();
  if (!slide) return;
  const items = slideItems(slide);
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

function showLayerMenu(event, kind, id) {
  event.preventDefault();
  event.stopPropagation();
  closeLayerMenu();
  if (state.photoAdjustMode) return;
  if (kind === "overlay") {
    state.selectedOverlayId = id;
    state.selectedTextId = null;
  } else {
    state.selectedTextId = id;
    state.selectedOverlayId = null;
  }
  refreshSelection();

  const menu = document.createElement("div");
  menu.className = "layer-menu";
  menu.setAttribute("role", "menu");
  const actions = [
    ...(kind === "overlay" ? [["crop", "crop", "Crop"]] : []),
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
        if (kind === "overlay") deleteSelectedOverlay();
        else deleteSelectedText();
      } else if (action === "crop") {
        beginCrop(id);
      } else {
        moveLayer(kind, id, action);
      }
    });
    menu.appendChild(button);
  });
  document.body.appendChild(menu);
  const pad = 8;
  const { width, height } = menu.getBoundingClientRect();
  const left = clamp(event.clientX, pad, window.innerWidth - width - pad);
  const top = clamp(event.clientY, pad, window.innerHeight - height - pad);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function beginCrop(overlayId) {
  const overlay = (activeSlide()?.overlays || []).find((item) => item.id === overlayId);
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  state.photoAdjustMode = false;
  state.selectedOverlayId = overlay.id;
  state.selectedTextId = null;
  const crop = overlayCrop(overlay);
  if (crop.w < 0.999 || crop.h < 0.999 || crop.x > 0.001 || crop.y > 0.001) {
    const croppedHeight = getOverlayMetrics(overlay, asset).height;
    overlay.width /= crop.w;
    overlay.x -= crop.x * overlay.width;
    overlay.y -= crop.y * (croppedHeight / crop.h);
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
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m7 7 1 14h8l1-14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 4v6h-6"/></svg>',
    front: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    "send-back": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 13 5 5 5-5"/><path d="m7 6 5 5 5-5"/></svg>',
    crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
  };
  return icons[name] || "";
}

function renderHeader({ editor = false } = {}) {
  const project = activeProject();
  return `
    <header class="app-header">
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
          <button class="button button--primary" type="button" data-action="export" ${activeSlide() ? "" : "disabled"}>
            ${icon("download")} <span>Download PNG</span>
          </button>
        ` : `<button class="button button--primary" type="button" data-action="new-project">New project</button>`}
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
  hideAssetPreview();

  app.innerHTML = `
    ${renderHeader({ editor: true })}
    <main class="editor-shell">
      ${renderSlideRail(project)}
      ${renderAssetRail(project)}
      <section class="workspace" aria-label="Image editor">
        <div class="workspace-tools">
          <button class="tool-chip ${state.photoAdjustMode ? "is-active" : ""}" type="button" data-action="adjust-photo" aria-pressed="${state.photoAdjustMode}" ${activeSlide() ? "" : "disabled"}>Adjust photo</button>
          <button class="tool-chip ${state.showTikTokOverlay ? "is-active" : ""}" type="button" data-action="toggle-tiktok-overlay" aria-pressed="${state.showTikTokOverlay}" ${activeSlide() ? "" : "disabled"}>TikTok UI preview</button>
        </div>
        <div class="workspace-inner">
          ${activeSlide() ? renderStage(activeSlide()) : renderEmptyStage()}
        </div>
      </section>
      ${renderInspector()}
    </main>
    <input id="photo-upload" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" multiple />
    <input id="asset-upload" class="hidden-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" multiple />
  `;
  bindEditorEvents();
  if (activeSlide()) requestAnimationFrame(sizeStage);
}

function renderSlideRail(project) {
  return `
    <aside class="slide-rail">
      <div class="rail-heading"><h2>Photos</h2><span>${project.slides.length}</span></div>
      <div class="slide-list">
        ${project.slides.map((slide, index) => `
          <button class="slide-thumb ${slide.id === state.activeSlideId ? "is-active" : ""}" type="button" data-slide-id="${slide.id}" aria-label="Open slide ${index + 1}">
            <span class="slide-number">${String(index + 1).padStart(2, "0")}</span>
            <span class="thumb-image"><img src="${slide.imageData}" alt="" /></span>
          </button>
        `).join("")}
      </div>
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload">+ Add photos</button></div>
    </aside>
  `;
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
      <div class="rail-upload"><button class="button button--quiet" type="button" data-action="upload-assets">+ Upload assets</button></div>
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
    <div class="stage-wrap">
      <div class="stage-frame">
        <div class="stage ${state.photoAdjustMode ? "is-adjusting" : ""}" data-natural-width="${slide.width}" data-natural-height="${slide.height}">
          <img class="stage-image" src="${slide.imageData}" alt="${escapeHtml(slide.name)}" draggable="false" />
          ${renderTikTokOverlay()}
        </div>
        <div class="layer-stack">
          ${slideItems(slide).map(({ kind, item }) => (kind === "overlay" ? renderOverlayBox(item) : renderTextBox(item))).join("")}
        </div>
      </div>
      <span class="stage-dimensions">${OUTPUT_WIDTH} × ${OUTPUT_HEIGHT} · 9:16</span>
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
  const selected = overlay.id === state.selectedOverlayId;
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
      <div class="overlay-image-clip"><img src="${asset.imageData}" alt="" draggable="false" style="${imageStyle}" /></div>
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
        <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
        <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
      `}
    </div>
  `;
}

function renderTextBox(text) {
  const selected = text.id === state.selectedTextId;
  const outlineWidth = text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH;
  const background = text.background || "white";
  const backgroundShape = text.backgroundShape || "lines";
  return `
    <div
      class="text-box ${selected ? "is-selected" : ""}"
      data-text-id="${text.id}"
      data-style="${text.style}"
      data-background="${background}"
      data-box-shape="${backgroundShape}"
      style="left:${text.x * 100}%;top:${text.y * 100}%;width:${text.width * 100}%;height:${text.height * 100}%;--outline-width:${outlineWidth * (state.stageWidth / DESIGN_WIDTH)}px;"
      tabindex="0"
      aria-label="Text layer: ${escapeHtml(text.text)}"
    >
      <div class="text-content-wrap"><span class="text-content" spellcheck="false">${escapeHtml(text.text)}</span></div>
      <span class="resize-handle" data-corner="nw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="ne" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="sw" aria-hidden="true"></span>
      <span class="resize-handle" data-corner="se" aria-hidden="true"></span>
    </div>
  `;
}

function renderInspector() {
  const text = selectedText();
  const overlay = selectedOverlay();
  const overlayAsset = overlay ? projectAsset(overlay.assetId) : null;
  const slide = activeSlide();
  const photoMode = Boolean(state.photoAdjustMode && slide);
  const overlayMode = Boolean(!photoMode && overlay);
  return `
    <aside class="inspector ${state.mobileInspectorOpen ? "is-mobile-open" : ""}">
      <div class="inspector-header">
        <h2>${photoMode ? "Photo settings" : overlayMode && state.croppingOverlayId === overlay.id ? "Crop" : overlayMode ? "Overlay" : text ? "Text settings" : "Text"}</h2>
        ${((text && !photoMode && !overlayMode) || overlayMode) ? `<button class="icon-button" type="button" data-action="${overlayMode ? "delete-overlay" : "delete-text"}" aria-label="${overlayMode ? "Delete overlay" : "Delete text"}">${icon("trash")}</button>` : ""}
      </div>
      ${photoMode ? `
        <div class="inspector-body">
          <div class="control-group">
            <label class="control-label" for="photo-zoom">Zoom <output id="photo-zoom-output">${Math.round((slide.imageScale || 1) * 100)}%</output></label>
            <input id="photo-zoom" type="range" min="1" max="3" step="0.01" value="${slide.imageScale || 1}" />
          </div>
          <button class="button button--quiet reset-photo-button" type="button" data-action="reset-photo">Reset photo</button>
          <div class="tip"><strong>Move it</strong><span>Drag the photo inside the 9:16 frame. Zoom in until the crop looks right.</span></div>
        </div>
      ` : overlayMode && state.croppingOverlayId === overlay.id ? `
        <div class="inspector-body">
          <div class="tip"><strong>Crop</strong><span>Drag the handles to choose what stays. Click outside the photo to finish and deselect.</span></div>
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
          <div class="tip"><strong>Place it</strong><span>Drag to move. Corner handles resize and keep the photo’s shape. The top handle rotates it.</span></div>
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
            <label class="control-label" for="font-size">Size <output>${Math.round(text.size)} px</output></label>
            <div class="range-wrap">
              <input id="font-size" type="range" min="20" max="180" step="1" value="${text.size}" />
              <input id="font-size-number" class="number-input" type="number" min="20" max="180" step="1" value="${Math.round(text.size)}" aria-label="Font size in pixels" />
            </div>
          </div>
          ${text.style === "outline" ? `
            <div class="control-group">
              <label class="control-label" for="outline-width">Outline <output id="outline-output">${Math.round(text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH)} px</output></label>
              <div class="range-wrap">
                <input id="outline-width" type="range" min="2" max="18" step="1" value="${text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH}" />
                <input id="outline-width-number" class="number-input" type="number" min="2" max="18" step="1" value="${Math.round(text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH)}" aria-label="Outline thickness in pixels" />
              </div>
            </div>
          ` : ""}
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
          <div class="tip"><strong>Tip</strong><span>Drag text to move it. Drag any corner to reshape its box. Double-click the text to type directly.</span></div>
        </div>
      ` : `
        <div class="inspector-empty"><span>T</span><p>${slide ? "Select text or an overlay, or add one to this photo." : "Add a photo to start placing text."}</p></div>
      `}
      <div class="bottom-actions">
        <button class="button button--primary" type="button" data-action="add-text" ${activeSlide() ? "" : "disabled"}>+ Add text</button>
        ${activeSlide() ? `<button class="button button--quiet" type="button" data-action="delete-slide">Remove photo</button>` : ""}
      </div>
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

function showProjectModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <form class="modal">
      <h2>New project</h2>
      <p>Give this slideshow a name. It stays saved in this browser.</p>
      <input name="project-name" value="Untitled slideshow" maxlength="64" autocomplete="off" aria-label="Project name" />
      <div class="modal-actions">
        <button class="button button--quiet" type="button" data-action="cancel-modal">Cancel</button>
        <button class="button button--primary" type="submit">Create project</button>
      </div>
    </form>
  `;
  document.body.appendChild(backdrop);
  const input = backdrop.querySelector("input");
  requestAnimationFrame(() => input.select());
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop || event.target.closest('[data-action="cancel-modal"]')) backdrop.remove();
  });
  backdrop.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim() || "Untitled slideshow";
    const project = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), slides: [], assets: [] };
    state.projects.push(project);
    await putProject(project);
    backdrop.remove();
    openProject(project.id);
  });
}

function bindDashboardEvents() {
  app.querySelectorAll('[data-action="new-project"]').forEach((button) => button.addEventListener("click", showProjectModal));
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
    activeProject().name = title.value || "Untitled slideshow";
    scheduleSave();
  });

  app.querySelectorAll('[data-action="upload"]').forEach((button) => {
    button.addEventListener("click", () => app.querySelector("#photo-upload").click());
  });
  app.querySelector("#photo-upload")?.addEventListener("change", handleUpload);
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

  app.querySelector('[data-action="add-text"]')?.addEventListener("click", addText);
  app.querySelector('[data-action="delete-text"]')?.addEventListener("click", deleteSelectedText);
  app.querySelector('[data-action="delete-overlay"]')?.addEventListener("click", deleteSelectedOverlay);
  app.querySelector('[data-action="done-crop"]')?.addEventListener("click", finishCrop);
  app.querySelector('[data-action="delete-slide"]')?.addEventListener("click", deleteActiveSlide);
  app.querySelector('[data-action="export"]')?.addEventListener("click", exportActiveSlide);
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

  app.querySelectorAll(".text-box").forEach(bindTextBox);
  app.querySelectorAll(".overlay-box").forEach(bindOverlayBox);
  bindAssetLibrary();
  bindStageAssetDrop();
  bindInspectorControls();

  const workspace = app.querySelector(".workspace");
  workspace?.addEventListener("pointerdown", (event) => {
    if (event.target === workspace || event.target.classList.contains("workspace-inner") || event.target.classList.contains("layer-stack")) {
      const wasCropping = Boolean(state.croppingOverlayId);
      clearLayerSelection();
      if (wasCropping) renderEditor();
      else refreshSelection();
    }
  });

  const stage = app.querySelector(".stage");
  stage?.addEventListener("pointerdown", (event) => {
    if (state.photoAdjustMode) {
      if (event.target.closest(".text-box") || event.target.closest(".overlay-box")) return;
      beginImageDrag(event, stage);
      return;
    }
    if (!event.target.closest(".text-box") && !event.target.closest(".overlay-box")) {
      const wasCropping = Boolean(state.croppingOverlayId);
      clearLayerSelection();
      if (wasCropping) renderEditor();
      else refreshSelection();
    }
  });

  const resizeObserver = new ResizeObserver(() => sizeStage());
  const workspaceInner = app.querySelector(".workspace-inner");
  if (workspaceInner) resizeObserver.observe(workspaceInner);
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
      text.style = button.dataset.textStyle;
      scheduleSave();
      refreshSelection();
      updateTextBox(text);
      ensureTextFits(text);
    });
  });

  const range = app.querySelector("#font-size");
  const number = app.querySelector("#font-size-number");
  const setSize = (value) => {
    const text = selectedText();
    if (!text) return;
    text.size = Math.max(20, Math.min(180, Number(value) || 20));
    if (range) range.value = text.size;
    if (number) number.value = Math.round(text.size);
    const output = app.querySelector(".control-label output");
    if (output) output.textContent = `${Math.round(text.size)} px`;
    updateTextBox(text);
    ensureTextFits(text);
    scheduleSave();
  };
  range?.addEventListener("input", () => setSize(range.value));
  number?.addEventListener("input", () => setSize(number.value));

  const outlineRange = app.querySelector("#outline-width");
  const outlineNumber = app.querySelector("#outline-width-number");
  const setOutlineWidth = (value) => {
    const text = selectedText();
    if (!text) return;
    text.outlineWidth = Math.max(2, Math.min(18, Number(value) || DEFAULT_OUTLINE_WIDTH));
    if (outlineRange) outlineRange.value = text.outlineWidth;
    if (outlineNumber) outlineNumber.value = Math.round(text.outlineWidth);
    const output = app.querySelector("#outline-output");
    if (output) output.textContent = `${Math.round(text.outlineWidth)} px`;
    updateTextBox(text);
    scheduleSave();
  };
  outlineRange?.addEventListener("input", () => setOutlineWidth(outlineRange.value));
  outlineNumber?.addEventListener("input", () => setOutlineWidth(outlineNumber.value));

  app.querySelectorAll("[data-background-tone]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      text.background = button.dataset.backgroundTone;
      app.querySelectorAll("[data-background-tone]").forEach((item) => item.classList.toggle("is-active", item === button));
      updateTextBox(text);
      scheduleSave();
    });
  });

  app.querySelectorAll("[data-background-shape]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = selectedText();
      if (!text) return;
      text.backgroundShape = button.dataset.backgroundShape;
      app.querySelectorAll("[data-background-shape]").forEach((item) => item.classList.toggle("is-active", item === button));
      updateTextBox(text);
      ensureTextFits(text);
      scheduleSave();
    });
  });

  const photoZoom = app.querySelector("#photo-zoom");
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
  app.querySelectorAll(".text-box").forEach((box) => {
    box.classList.toggle("is-selected", box.dataset.textId === state.selectedTextId);
  });
  app.querySelectorAll(".overlay-box").forEach((box) => {
    box.classList.toggle("is-selected", box.dataset.overlayId === state.selectedOverlayId);
  });
  const currentInspector = app.querySelector(".inspector");
  if (currentInspector) {
    currentInspector.outerHTML = renderInspector();
    app.querySelector('[data-action="add-text"]')?.addEventListener("click", addText);
    app.querySelector('[data-action="delete-text"]')?.addEventListener("click", deleteSelectedText);
    app.querySelector('[data-action="delete-overlay"]')?.addEventListener("click", deleteSelectedOverlay);
    app.querySelector('[data-action="done-crop"]')?.addEventListener("click", finishCrop);
    app.querySelector('[data-action="delete-slide"]')?.addEventListener("click", deleteActiveSlide);
    bindInspectorControls();
  }
}

function sizeStage() {
  const inner = app.querySelector(".workspace-inner");
  const stage = app.querySelector(".stage");
  const slide = activeSlide();
  if (!inner || !stage || !slide) return;
  const availableWidth = inner.clientWidth;
  const availableHeight = inner.clientHeight;
  const ratio = OUTPUT_WIDTH / OUTPUT_HEIGHT;
  let width = availableWidth;
  let height = width / ratio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * ratio;
  }
  state.stageWidth = width;
  state.stageHeight = height;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.setProperty("--stage-scale", width / OUTPUT_WIDTH);
  updateStageImage(slide);
  activeSlide().texts.forEach(updateTextBox);
  (activeSlide().overlays || []).forEach(updateOverlayBox);
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
  const image = app.querySelector(".stage-image");
  if (!image || !state.stageWidth || !state.stageHeight) return;
  const layout = getImageLayout(slide, state.stageWidth, state.stageHeight);
  image.style.width = `${layout.width}px`;
  image.style.height = `${layout.height}px`;
  image.style.left = `${layout.left}px`;
  image.style.top = `${layout.top}px`;
}

function updateTextBox(text) {
  const box = app.querySelector(`.text-box[data-text-id="${text.id}"]`);
  if (!box) return;
  box.style.left = `${text.x * 100}%`;
  box.style.top = `${text.y * 100}%`;
  box.style.width = `${text.width * 100}%`;
  box.style.height = `${text.height * 100}%`;
  box.dataset.style = text.style;
  box.dataset.background = text.background || "white";
  box.dataset.boxShape = text.backgroundShape || "lines";
  box.style.setProperty("--outline-width", `${(text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH) * (state.stageWidth / DESIGN_WIDTH)}px`);
  const content = box.querySelector(".text-content");
  content.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
  if (!box.classList.contains("is-editing")) content.textContent = text.text;
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
  const image = box.querySelector("img");
  if (image) {
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
  }
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
    text.y = Math.min(text.y, 1 - nextHeight);
    text.height = nextHeight;
    box.style.top = `${text.y * 100}%`;
    box.style.height = `${text.height * 100}%`;
    scheduleSave();
  });
}

function addText() {
  const slide = activeSlide();
  if (!slide) return;
  const text = {
    id: uid(),
    text: "Your text",
    x: 0.18,
    y: 0.42,
    width: 0.64,
    height: 0.13,
    size: 64,
    style: "outline",
    outlineWidth: DEFAULT_OUTLINE_WIDTH,
    background: "white",
    backgroundShape: "lines",
    z: nextLayerZ(slide),
  };
  state.photoAdjustMode = false;
  state.selectedOverlayId = null;
  slide.texts.push(text);
  state.selectedTextId = text.id;
  state.mobileInspectorOpen = true;
  scheduleSave();
  renderEditor();
  requestAnimationFrame(() => app.querySelector("#text-value")?.select());
}

function deleteSelectedText() {
  const slide = activeSlide();
  if (!slide || !state.selectedTextId) return;
  slide.texts = slide.texts.filter((text) => text.id !== state.selectedTextId);
  state.selectedTextId = null;
  scheduleSave();
  renderEditor();
}

async function deleteActiveSlide() {
  const project = activeProject();
  const slide = activeSlide();
  if (!project || !slide) return;
  const confirmed = window.confirm(`Remove “${slide.name}” from this project?`);
  if (!confirmed) return;
  const index = project.slides.findIndex((item) => item.id === slide.id);
  project.slides.splice(index, 1);
  state.activeSlideId = project.slides[index]?.id || project.slides[index - 1]?.id || null;
  clearLayerSelection();
  scheduleSave();
  renderEditor();
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
      event.preventDefault();
      event.stopPropagation();
      hideAssetPreview();
      deleteProjectAsset(button.dataset.assetId);
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

function addOverlayFromAsset(assetId, point, { render = true } = {}) {
  const slide = activeSlide();
  const asset = projectAsset(assetId);
  if (!slide || !asset) {
    toast(slide ? "That asset is missing." : "Open a photo first, then drop the asset on it.");
    return null;
  }
  if (!slide.overlays) slide.overlays = [];
  const overlay = constrainOverlay({
    id: uid(),
    assetId: asset.id,
    x: 0.33,
    y: 0.36,
    width: 0.34,
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
  state.selectedTextId = null;
  state.selectedOverlayId = overlay.id;
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
  const usedSlides = project.slides.filter((slide) => (slide.overlays || []).some((overlay) => overlay.assetId === assetId)).length;
  const confirmed = window.confirm(usedSlides
    ? `Remove “${asset.name}” from this project? It will also disappear from ${usedSlides} ${usedSlides === 1 ? "photo" : "photos"}.`
    : `Remove “${asset.name}” from uploaded assets?`);
  if (!confirmed) return;
  project.assets = project.assets.filter((item) => item.id !== assetId);
  project.slides.forEach((slide) => {
    slide.overlays = (slide.overlays || []).filter((overlay) => overlay.assetId !== assetId);
  });
  if (state.selectedOverlayId && !selectedOverlay()) state.selectedOverlayId = null;
  scheduleSave();
  renderEditor();
}

function deleteSelectedOverlay() {
  const slide = activeSlide();
  if (!slide || !state.selectedOverlayId) return;
  exitCropMode({ apply: false });
  slide.overlays = (slide.overlays || []).filter((overlay) => overlay.id !== state.selectedOverlayId);
  state.selectedOverlayId = null;
  scheduleSave();
  renderEditor();
}

function bindOverlayBox(box) {
  box.addEventListener("pointerdown", (event) => {
    if (state.photoAdjustMode) return;
    const corner = event.target.closest("[data-corner]")?.dataset.corner;
    const rotate = event.target.closest("[data-rotate]");
    const cropHandle = event.target.closest("[data-crop]")?.dataset.crop;
    state.selectedOverlayId = box.dataset.overlayId;
    state.selectedTextId = null;
    refreshSelection();
    if (event.button === 2) return;
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
    else beginOverlayDrag(event, box);
  });
  box.addEventListener("contextmenu", (event) => {
    showLayerMenu(event, "overlay", box.dataset.overlayId);
  });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      deleteSelectedOverlay();
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
  event.preventDefault();
  const overlay = selectedOverlay();
  if (!overlay) return;
  box.classList.add("is-dragging");
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = { clientX: event.clientX, clientY: event.clientY, x: overlay.x, y: overlay.y };
  const move = (moveEvent) => {
    const asset = projectAsset(overlay.assetId);
    const metrics = getOverlayMetrics(overlay, asset);
    overlay.x = start.x + (moveEvent.clientX - start.clientX) / state.stageWidth;
    overlay.y = start.y + (moveEvent.clientY - start.clientY) / state.stageHeight;
    const limits = overlayPositionLimits(metrics);
    overlay.x = clamp(overlay.x, limits.minX, limits.maxX);
    overlay.y = clamp(overlay.y, limits.minY, limits.maxY);
    updateOverlayBox(overlay);
    scheduleSave();
  };
  const end = () => {
    box.classList.remove("is-dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginOverlayResize(event, box, corner) {
  event.preventDefault();
  event.stopPropagation();
  const overlay = selectedOverlay();
  const asset = overlay ? projectAsset(overlay.assetId) : null;
  if (!overlay || !asset) return;
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const startMetrics = getOverlayMetrics(overlay, asset);
  const start = {
    width: overlay.width,
    x: overlay.x,
    y: overlay.y,
    height: startMetrics.height,
    pointer: stagePoint(event),
  };
  const anchors = {
    se: { x: start.x, y: start.y },
    sw: { x: start.x + start.width, y: start.y },
    ne: { x: start.x, y: start.y + start.height },
    nw: { x: start.x + start.width, y: start.y + start.height },
  };
  const anchor = anchors[corner];
  const center = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
  const toLocal = (point) => {
    const local = rotateDelta(point.x - center.x, point.y - center.y, overlay.rotation || 0);
    return { x: center.x + local.x, y: center.y + local.y };
  };
  const startLocal = toLocal(start.pointer);
  const startDistance = Math.hypot(
    (startLocal.x - anchor.x) * state.stageWidth,
    (startLocal.y - anchor.y) * state.stageHeight,
  ) || 1;
  const move = (moveEvent) => {
    const local = toLocal(stagePoint(moveEvent));
    const distance = Math.hypot(
      (local.x - anchor.x) * state.stageWidth,
      (local.y - anchor.y) * state.stageHeight,
    );
    overlay.width = start.width * (distance / startDistance);
    constrainOverlay(overlay, asset);
    const metrics = getOverlayMetrics(overlay, asset);
    if (corner.includes("w")) overlay.x = anchor.x - metrics.width;
    else overlay.x = anchor.x;
    if (corner.includes("n")) overlay.y = anchor.y - metrics.height;
    else overlay.y = anchor.y;
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
  const content = box.querySelector(".text-content");
  box.addEventListener("pointerdown", (event) => {
    if (box.classList.contains("is-editing")) return;
    const corner = event.target.dataset.corner;
    state.selectedTextId = box.dataset.textId;
    state.selectedOverlayId = null;
    refreshSelection();
    if (event.button === 2) return;
    if (state.croppingOverlayId) {
      finishCrop();
      return;
    }
    if (corner) beginResize(event, box, corner);
    else beginDrag(event, box);
  });
  box.addEventListener("contextmenu", (event) => {
    if (box.classList.contains("is-editing")) return;
    showLayerMenu(event, "text", box.dataset.textId);
  });
  box.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    state.selectedTextId = box.dataset.textId;
    box.classList.add("is-editing", "is-selected");
    content.contentEditable = "true";
    content.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  content.addEventListener("input", () => {
    const text = selectedText();
    if (!text) return;
    text.text = content.innerText.replace(/\n$/, "");
    const textarea = app.querySelector("#text-value");
    if (textarea) textarea.value = text.text;
    ensureTextFits(text);
    scheduleSave();
  });
  content.addEventListener("blur", () => {
    content.contentEditable = "false";
    box.classList.remove("is-editing");
  });
  box.addEventListener("keydown", (event) => {
    if ((event.key === "Backspace" || event.key === "Delete") && !box.classList.contains("is-editing")) {
      event.preventDefault();
      deleteSelectedText();
    }
    if (event.key === "Enter" && !box.classList.contains("is-editing")) {
      event.preventDefault();
      box.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }
  });
}

function beginDrag(event, box) {
  event.preventDefault();
  const text = selectedText();
  if (!text) return;
  box.classList.add("is-dragging");
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = { clientX: event.clientX, clientY: event.clientY, x: text.x, y: text.y };
  const move = (moveEvent) => {
    text.x = clamp(start.x + (moveEvent.clientX - start.clientX) / state.stageWidth, 0, 1 - text.width);
    text.y = clamp(start.y + (moveEvent.clientY - start.clientY) / state.stageHeight, 0, 1 - text.height);
    updateTextBox(text);
    scheduleSave();
  };
  const end = () => {
    box.classList.remove("is-dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
}

function beginResize(event, box, corner) {
  event.preventDefault();
  event.stopPropagation();
  const text = selectedText();
  if (!text) return;
  try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
  const start = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: text.x,
    y: text.y,
    width: text.width,
    height: text.height,
  };
  const minWidth = 0.1;
  const minHeight = 0.045;
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - start.clientX) / state.stageWidth;
    const dy = (moveEvent.clientY - start.clientY) / state.stageHeight;
    let nextX = start.x;
    let nextY = start.y;
    let nextWidth = start.width;
    let nextHeight = start.height;

    if (corner.includes("e")) nextWidth = clamp(start.width + dx, minWidth, 1 - start.x);
    if (corner.includes("s")) nextHeight = clamp(start.height + dy, minHeight, 1 - start.y);
    if (corner.includes("w")) {
      nextX = clamp(start.x + dx, 0, start.x + start.width - minWidth);
      nextWidth = start.width + (start.x - nextX);
    }
    if (corner.includes("n")) {
      nextY = clamp(start.y + dy, 0, start.y + start.height - minHeight);
      nextHeight = start.height + (start.y - nextY);
    }
    text.x = nextX;
    text.y = nextY;
    text.width = nextWidth;
    text.height = nextHeight;
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
  if (!files.length) return;
  const project = activeProject();
  if (!project) return;
  const button = app.querySelector('[data-action="upload"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Adding…";
  }
  try {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const imageData = await fileToDataUrl(file);
      const dimensions = await getImageDimensions(imageData);
      project.slides.push({
        id: uid(),
        name: file.name.replace(/\.[^.]+$/, ""),
        imageData,
        width: dimensions.width,
        height: dimensions.height,
        imageScale: 1,
        imageX: 0,
        imageY: 0,
        texts: [],
        overlays: [],
      });
    }
    if (!state.activeSlideId) state.activeSlideId = project.slides[0]?.id || null;
    await putProject(project);
    toast(`${files.length} ${files.length === 1 ? "photo" : "photos"} added`);
    renderEditor();
  } catch (error) {
    console.error(error);
    toast("One of those photos couldn’t be added.");
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
    await document.fonts.load('700 64px "TikTok Sans"');
    const image = await loadImage(slide.imageData);
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_WIDTH;
    canvas.height = OUTPUT_HEIGHT;
    const context = canvas.getContext("2d");
    const imageLayout = getImageLayout(slide, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    context.drawImage(image, imageLayout.left, imageLayout.top, imageLayout.width, imageLayout.height);
    await drawSlideLayers(context, slide, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
    if (!blob) throw new Error("Could not create PNG");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(activeProject().name)}-${safeFilename(slide.name)}.png`;
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
  const x = text.x * imageWidth;
  const y = text.y * imageHeight;
  const width = text.width * imageWidth;
  const height = text.height * imageHeight;
  const exportScale = imageWidth / DESIGN_WIDTH;
  const fontSize = text.size * exportScale;
  const lineHeight = fontSize * 1.05;
  const horizontalPadding = text.style === "boxed" ? fontSize * 0.26 : fontSize * 0.16;
  const verticalPadding = fontSize * 0.1;
  context.save();
  context.font = `760 ${fontSize}px "TikTok Sans"`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  const lines = wrapText(context, text.text, Math.max(1, width - horizontalPadding * 2));
  const visibleLineCount = Math.max(1, Math.floor((height - verticalPadding * 2) / lineHeight));
  const visibleLines = lines.slice(0, visibleLineCount);
  const blockHeight = visibleLines.length * lineHeight;
  const startY = y + (height - blockHeight) / 2 + lineHeight / 2;

  if (text.style === "boxed" && text.backgroundShape === "full") {
    context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
    roundedRect(context, x, y, width, height, Math.min(fontSize * 0.18, width / 2, height / 2));
    context.fill();
  }

  visibleLines.forEach((line, index) => {
    const lineY = startY + index * lineHeight;
    if (text.style === "boxed" && text.backgroundShape !== "full" && line) {
      const backgroundWidth = Math.min(width, context.measureText(line).width + horizontalPadding * 2);
      const backgroundHeight = lineHeight * 0.98;
      context.fillStyle = text.background === "black" ? "#111111" : "#ffffff";
      roundedRect(
        context,
        x + (width - backgroundWidth) / 2,
        lineY - backgroundHeight / 2,
        backgroundWidth,
        backgroundHeight,
        Math.min(fontSize * 0.14, backgroundHeight / 2),
      );
      context.fill();
    }
    if (text.style === "outline") {
      context.strokeStyle = "#111111";
      context.lineWidth = (text.outlineWidth ?? DEFAULT_OUTLINE_WIDTH) * exportScale;
      context.strokeText(line, x + width / 2, lineY);
      context.fillStyle = "#ffffff";
      context.fillText(line, x + width / 2, lineY);
    } else {
      context.fillStyle = text.style === "boxed" && text.background !== "black" ? "#111111" : "#ffffff";
      context.fillText(line, x + width / 2, lineY);
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

function safeFilename(value) {
  return String(value || "slide")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "slide";
}

function isEditingTextTarget(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable='true'], [contenteditable='']"));
}

function clipboardImageFiles(clipboardData) {
  if (!clipboardData) return [];
  const seen = new Set();
  const files = [];
  const add = (file) => {
    if (!file) return;
    const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.name || "");
    if (!isImage) return;
    const key = `${file.type}:${file.size}:${file.lastModified}:${file.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  if (clipboardData.files) [...clipboardData.files].forEach(add);
  if (clipboardData.items) {
    [...clipboardData.items].forEach((item) => {
      if (item.kind === "file") add(item.getAsFile());
    });
  }
  return files;
}

async function createAssetFromFile(file, fallbackName = "Pasted image") {
  const project = activeProject();
  if (!project) return null;
  if (!project.assets) project.assets = [];
  const imageData = await fileToDataUrl(file);
  const dimensions = await getImageDimensions(imageData);
  const asset = {
    id: uid(),
    name: String(file.name || fallbackName).replace(/\.[^.]+$/, "") || fallbackName,
    imageData,
    width: dimensions.width,
    height: dimensions.height,
  };
  project.assets.push(asset);
  return asset;
}

async function handleClipboardPaste(event) {
  if (!activeProject() || isEditingTextTarget(event.target)) return;
  const files = clipboardImageFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  const assets = [];
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
      addOverlayFromAsset(asset.id, { x: 0.5 + index * 0.03, y: 0.5 + index * 0.03 }, { render: false });
    });
  }
  scheduleSave();
  renderEditor();
  toast(slide
    ? `${assets.length} ${assets.length === 1 ? "image" : "images"} pasted onto the photo`
    : `${assets.length} ${assets.length === 1 ? "asset" : "assets"} added`);
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
          if (overlay.z == null) overlay.z = index + 1;
        });
        slide.texts.forEach((text, index) => {
          if (text.outlineWidth == null) text.outlineWidth = DEFAULT_OUTLINE_WIDTH;
          if (!text.background) text.background = "white";
          if (!text.backgroundShape) text.backgroundShape = "full";
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
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".layer-menu")) closeLayerMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeLayerMenu();
  });
}

init();
