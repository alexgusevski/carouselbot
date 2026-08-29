import {
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  DEFAULT_OUTLINE_WIDTH,
  TEXT_WEIGHT,
  CLIPBOARD_LAYER_TYPE,
  LEGACY_CLIPBOARD_LAYER_TYPE,
  CLIPBOARD_STORAGE_KEY,
  LEGACY_CLIPBOARD_STORAGE_KEY,
  HISTORY_LIMIT,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_MAX,
  cloneProject,
  uid,
  projectPath,
  routeFromPathname,
  escapeHtml,
  normalizeHexColor,
  textColor,
  rgbToHex,
  formatRgb,
  ensureBoxedTextContrast,
  layerKey,
  overlayCrop,
  initialOverlayWidth,
  slideItems,
  nextLayerZ,
  fontSizeFromSliderPosition,
  sliderPositionFromFontSize,
  formatFontSize,
  getImageLayout,
  clamp,
  safeFilename,
  isEditingTextTarget,
  parseCopiedLayer,
  isImageFile,
} from "./editor-model.mjs";
import {
  state,
  history,
  app,
  activeProject,
  activeSlide,
  selectedText,
  selectedOverlay,
  selectedLayerKeys,
  isLayerSelected,
  selectedLayers,
  setLayerSelection,
  selectOnlyLayer,
  projectAsset,
  getOverlayMetrics,
  constrainOverlay,
  constrainImagePosition,
} from "./editor-state.mjs";
import {
  formatDate,
  icon,
  renderHeader,
  renderLegacyMigrationNotice,
  renderSlideRail,
  renderSlideThumbnail,
  renderAssetRail,
  renderEmptyStage,
  renderStage,
  renderInspector,
  updateTextBox,
  updateOverlayBox,
  updateStageImage,
} from "./editor-view.mjs";
import { createLayerInteractions } from "./layer-interactions.mjs";
import {
  STORE_NAME,
  PROJECT_SYNC_STORAGE_KEY,
  projectChannel,
  projectChannelSource,
  openDatabase,
  getAllProjects,
  getProjectFromDb,
  announceProjectChange,
  putProject,
  deleteProjectFromDb,
} from "./project-store.mjs";
import {
  canvasToBlob,
  getImageDimensions,
  renderSlideCanvas,
  fingerprintData,
} from "./slide-renderer.mjs";

const { bindOverlayBox, bindTextBox, activeTextEditingBox, isInlineTextEditing, endTextEditing, beginImageDrag } = createLayerInteractions({
  recordHistory,
  clearLayerSelection,
  showLayerMenu,
  finishCrop,
  scheduleSave,
  refreshSelection,
  ensureTextFits,
  deleteSelectedLayers,
});

const APP_CONFIG = window.CAROUSELBOT_CONFIG;

export const domainMigration = window.CarouselBotDomainMigration.createController(window, APP_CONFIG);

const DB_NAME = domainMigration.isLegacyOrigin ? "slide-studio-db" : "carouselbot-db";

let migrationModalDismissed = false;

export function recordHistory(project = activeProject()) {
  if (!project || history.applying) return;
  history.past.push(cloneProject(project));
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future = history.future.filter((snapshot) => snapshot.id !== project.id);
}

function takeProjectHistorySnapshot(stack, projectId) {
  const index = stack.findLastIndex((snapshot) => snapshot.id === projectId);
  return index < 0 ? null : stack.splice(index, 1)[0];
}

async function applyHistorySnapshot(snapshot) {
  const index = state.projects.findIndex((project) => project.id === snapshot.id);
  if (index < 0) return;
  const expectedRevision = Number(state.projects[index].revision) || 0;
  history.applying = true;
  state.projects[index] = { ...cloneProject(snapshot), revision: expectedRevision + 1, updatedAt: Date.now() };
  state.activeProjectId = snapshot.id;
  if (!state.projects[index].slides.some((slide) => slide.id === state.activeSlideId)) {
    state.activeSlideId = state.projects[index].slides[0]?.id || null;
  }
  setLayerSelection(selectedLayerKeys());
  state.croppingOverlayId = null;
  renderEditor();
  try {
    await putProject(state.projects[index], { expectedRevision });
  } catch (error) {
    console.error(error);
    if (error.code === "STALE_PROJECT") await reloadProjectFromDb(snapshot.id);
    throw error;
  } finally {
    history.applying = false;
  }
}

export function undo() {
  if (isEditingTextTarget(document.activeElement)) return;
  const project = activeProject();
  if (!project) return;
  const snapshot = takeProjectHistorySnapshot(history.past, project.id);
  if (!snapshot) return;
  history.future.push(cloneProject(project));
  return applyHistorySnapshot(snapshot);
}

export function redo() {
  if (isEditingTextTarget(document.activeElement)) return;
  const project = activeProject();
  if (!project) return;
  const snapshot = takeProjectHistorySnapshot(history.future, project.id);
  if (!snapshot) return;
  history.past.push(cloneProject(project));
  return applyHistorySnapshot(snapshot);
}

export function updateBrowserRoute(path, historyMode) {
  if (historyMode === "none" || window.location.pathname === path) return;
  window.history[historyMode === "replace" ? "replaceState" : "pushState"]({}, "", `${path}${window.location.search}${window.location.hash}`);
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

async function importMigratedProject(project) {
  const incoming = structuredClone(project);
  const result = await new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let outcome = "invalid";
    const read = store.get(incoming.id);
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      outcome = domainMigration.migrationResult(read.result || null, incoming);
      if (outcome === "invalid") {
        transaction.abort();
        return;
      }
      if (outcome !== "skipped") store.put(incoming);
    };
    transaction.oncomplete = () => resolve(outcome);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(outcome === "invalid"
      ? new Error(`Project ${incoming.id || "unknown"} is not a valid CarouselBot project.`)
      : transaction.error || new Error("Project import was aborted."));
  });
  if (result === "skipped") return result;
  announceProjectChange("project.updated", incoming);
  const index = state.projects.findIndex((item) => item.id === incoming.id);
  if (index >= 0) state.projects[index] = incoming;
  else state.projects.push(incoming);
  return result;
}

export async function reloadProjectFromDb(projectId, { render = true } = {}) {
  const latest = await getProjectFromDb(projectId);
  const index = state.projects.findIndex((project) => project.id === projectId);
  if (!latest) {
    if (index >= 0) state.projects.splice(index, 1);
    clearProjectCover(projectId);
    if (state.activeProjectId === projectId) {
      state.activeProjectId = null;
      state.activeSlideId = null;
      updateBrowserRoute("/", "replace");
    }
  } else if (index >= 0) {
    state.projects[index] = latest;
    if (state.activeProjectId === projectId && !latest.slides.some((slide) => slide.id === state.activeSlideId)) state.activeSlideId = latest.slides[0]?.id || null;
  } else state.projects.push(latest);
  if (render) {
    if (!state.activeProjectId) renderDashboard();
    else if (state.activeProjectId === projectId) renderEditor();
  }
  return latest;
}

async function handleExternalProjectEvent(data) {
  if (!data || data.source === projectChannelSource || !data.projectId || !state.db) return;
  const local = state.projects.find((project) => project.id === data.projectId);
  if (data.type === "project.deleted" || !local || Number(data.revision) > (Number(local.revision) || 0) || Number(data.updatedAt) > (Number(local.updatedAt) || 0)) {
    await reloadProjectFromDb(data.projectId).catch((error) => console.error("Could not synchronize project", error));
  }
}

projectChannel?.addEventListener("message", ({ data }) => { void handleExternalProjectEvent(data); });

window.addEventListener("storage", (event) => {
  if (event.key !== PROJECT_SYNC_STORAGE_KEY || !event.newValue) return;
  try {
    void handleExternalProjectEvent(JSON.parse(event.newValue));
  } catch (error) {
    console.error("Could not read project synchronization event", error);
  }
});

export function clearLayerSelection() {
  exitCropMode();
  setLayerSelection([]);
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

function showProjectMenu(event, projectId) {
  event.preventDefault();
  event.stopPropagation();
  closeLayerMenu();

  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;

  const menu = document.createElement("div");
  menu.className = "layer-menu layer-menu--confirm";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${project.name}`);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "layer-menu-item is-danger";
  button.setAttribute("role", "menuitem");
  button.setAttribute("aria-label", `Remove ${project.name}`);
  button.innerHTML = `${icon("trash")}<span>Remove</span>`;
  button.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    closeLayerMenu();
    showProjectDeleteConfirmation(projectId);
  });
  menu.appendChild(button);
  document.body.appendChild(menu);

  const triggerRect = event.currentTarget.getBoundingClientRect();
  const clientX = event.clientX || triggerRect.left + triggerRect.width / 2;
  const clientY = event.clientY || triggerRect.top + triggerRect.height / 2;
  positionLayerMenu(menu, clientX, clientY);
}

function closeProjectDeleteConfirmation() {
  document.querySelector(".project-delete-confirmation")?.remove();
}

function showProjectDeleteConfirmation(projectId) {
  closeProjectDeleteConfirmation();
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop project-delete-confirmation";
  backdrop.innerHTML = `
    <section class="modal modal--confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" aria-describedby="delete-project-description">
      <h2 id="delete-project-title">Remove project?</h2>
      <p id="delete-project-description"><strong>${escapeHtml(project.name)}</strong> and all of its slides will be permanently deleted. This can’t be undone.</p>
      <div class="modal-actions">
        <button class="button button--quiet" type="button" data-action="cancel-project-delete">Cancel</button>
        <button class="button button--danger" type="button" data-action="confirm-project-delete">Remove project</button>
      </div>
    </section>
  `;

  const cancelButton = backdrop.querySelector('[data-action="cancel-project-delete"]');
  const confirmButton = backdrop.querySelector('[data-action="confirm-project-delete"]');
  const close = () => closeProjectDeleteConfirmation();

  cancelButton.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  confirmButton.addEventListener("click", async () => {
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    confirmButton.textContent = "Removing…";
    try {
      await deleteProjectFromDb(projectId, { expectedRevision: Number(project.revision) || 0 });
      project.slides.forEach((slide) => clearSlideThumbnail(slide.id));
      clearProjectCover(projectId);
      state.slideRailScrollPositions.delete(projectId);
      state.projects = state.projects.filter((item) => item.id !== projectId);
      close();
      renderDashboard();
      toast("Project removed");
    } catch (error) {
      console.error(error);
      if (error.code === "STALE_PROJECT") await reloadProjectFromDb(projectId);
      cancelButton.disabled = false;
      confirmButton.disabled = false;
      confirmButton.textContent = "Remove project";
      toast("Couldn’t remove this project from your browser.");
    }
  });

  document.body.appendChild(backdrop);
  cancelButton.focus();
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
      const baseRevision = Number(project.revision) || 0;
      project.revision = baseRevision + 1;
      await putProject(project, { expectedRevision: baseRevision });
    } catch (error) {
      console.error(error);
      if (error.code === "STALE_PROJECT") {
        await reloadProjectFromDb(project.id);
        toast("This project changed in another tab. Reloaded the latest version.");
      } else toast("Couldn’t save this project in your browser.");
    }
  }, 180);
}

export function toast(message) {
  document.querySelector(".toast")?.remove();
  clearTimeout(state.toastTimer);
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  document.body.appendChild(element);
  state.toastTimer = setTimeout(() => element.remove(), 2600);
}

export function renderDashboard() {
  hideAssetPreview();
  state.activeProjectId = null;
  state.activeSlideId = null;
  clearLayerSelection();
  document.title = "CarouselBot";
  const sortedProjects = [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  app.innerHTML = `
    ${renderHeader()}
    ${renderLegacyMigrationNotice(sortedProjects, domainMigration, migrationModalDismissed)}
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
            const slide = project.slides[0];
            const cover = slide ? state.projectCoverUrls.get(project.id) || slide.imageData : null;
            return `
              <a class="project-card" href="${projectPath(project.id)}" data-project-id="${project.id}" aria-haspopup="menu" aria-label="Open ${escapeHtml(project.name)}. Right-click for actions." title="Right-click for actions">
                <span class="project-preview" data-project-cover-id="${project.id}">
                  ${cover ? `<img src="${cover}" alt=""${state.projectCoverUrls.has(project.id) ? " data-composite-cover=\"true\"" : ""} />` : `<span class="project-preview-empty">No slides yet</span>`}
                </span>
                <span class="project-meta">
                  <strong>${escapeHtml(project.name)}</strong>
                  <span>${project.slides.length} ${project.slides.length === 1 ? "slide" : "slides"} · ${formatDate(project.updatedAt)}</span>
                </span>
              </a>
            `;
          }).join("")}
        </div>
      </section>
    </main>
  `;
  bindDashboardEvents();
  // The dashboard DOM is already mounted. Start composing covers immediately so
  // background tabs are not left with raw solid-color slide backgrounds while
  // requestAnimationFrame is throttled or paused by the browser.
  refreshAllProjectCovers(sortedProjects);
}

function projectCoverSignature(project) {
  const slide = project.slides[0];
  return slide ? `${Number(project.revision) || 0}:${slide.id}:${thumbnailSignature(slide)}` : "";
}

async function refreshProjectCover(project) {
  const slide = project.slides[0];
  const target = app.querySelector(`[data-project-cover-id="${project.id}"]`);
  if (!target) return;
  if (!slide) {
    clearProjectCover(project.id);
    target.innerHTML = `<span class="project-preview-empty">No slides yet</span>`;
    return;
  }
  const signature = projectCoverSignature(project);
  const cachedUrl = state.projectCoverUrls.get(project.id);
  if (cachedUrl && state.projectCoverSignatures.get(project.id) === signature) {
    const image = target.querySelector("img");
    if (image?.src !== cachedUrl) image.src = cachedUrl;
    image?.setAttribute("data-composite-cover", "true");
    return;
  }

  const version = (state.projectCoverVersions.get(project.id) || 0) + 1;
  state.projectCoverVersions.set(project.id, version);
  target.classList.add("is-rendering");
  try {
    const canvas = await renderSlideCanvas(slide, 270, 480, project);
    const blob = await canvasToBlob(canvas);
    if (state.projectCoverVersions.get(project.id) !== version) return;
    const url = URL.createObjectURL(blob);
    const previousUrl = state.projectCoverUrls.get(project.id);
    state.projectCoverUrls.set(project.id, url);
    state.projectCoverSignatures.set(project.id, signature);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const currentTarget = app.querySelector(`[data-project-cover-id="${project.id}"]`);
    if (currentTarget) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      image.dataset.compositeCover = "true";
      currentTarget.replaceChildren(image);
      currentTarget.classList.remove("is-rendering");
    }
  } catch (error) {
    console.error("Could not render project cover", error);
    target.classList.remove("is-rendering");
  }
}

function refreshAllProjectCovers(projects = state.projects) {
  projects.forEach((project) => { void refreshProjectCover(project); });
}

export function clearProjectCover(projectId) {
  const url = state.projectCoverUrls.get(projectId);
  if (url) URL.revokeObjectURL(url);
  state.projectCoverUrls.delete(projectId);
  state.projectCoverSignatures.delete(projectId);
  state.projectCoverVersions.delete(projectId);
}

export function renderEditor() {
  const project = activeProject();
  if (!project) return renderDashboard();
  document.title = `${project.name} · CarouselBot`;
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
  void repaintTextAfterFontLoad(project.id, state.activeSlideId);
}

async function repaintTextAfterFontLoad(projectId, slideId) {
  try {
    await document.fonts.load(`${TEXT_WEIGHT} 64px "TikTok Sans"`);
    await document.fonts.ready;
  } catch {
    return;
  }
  if (state.activeProjectId !== projectId || state.activeSlideId !== slideId) return;
  requestAnimationFrame(() => {
    if (state.activeProjectId !== projectId || state.activeSlideId !== slideId) return;
    activeSlide()?.texts.forEach(updateTextBox);
  });
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

function openProject(projectId, { historyMode = "push" } = {}) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return false;
  updateBrowserRoute(projectPath(projectId), historyMode);
  state.activeProjectId = projectId;
  state.activeSlideId = project.slides[0]?.id || null;
  clearLayerSelection();
  state.photoAdjustMode = false;
  renderEditor();
  return true;
}

function openDashboard({ historyMode = "push" } = {}) {
  updateBrowserRoute("/", historyMode);
  renderDashboard();
}

function renderCurrentRoute() {
  const route = routeFromPathname();
  if (route.view === "project" && openProject(route.projectId, { historyMode: "none" })) return;
  const missingProject = route.view === "project";
  updateBrowserRoute("/", "replace");
  renderDashboard();
  if (missingProject) toast("This project isn’t available in this browser.");
}

function createProject() {
  const now = Date.now();
  const project = { id: uid(), name: "New Project", createdAt: now, updatedAt: now, revision: 0, slides: [], assets: [] };
  state.projects.push(project);
  openProject(project.id);
  putProject(project).catch((error) => {
    console.error(error);
    toast("Couldn’t save this project in your browser.");
  });
}

function bindDashboardEvents() {
  bindGlobalActions();
  const migrationModal = app.querySelector("[data-migration-modal]");
  const dismissMigrationModal = () => {
    if (!migrationModal) return;
    migrationModalDismissed = true;
    migrationModal.classList.add("is-closing");
    window.setTimeout(() => migrationModal.remove(), 150);
    app.querySelector('[data-action="new-project"]')?.focus({ preventScroll: true });
  };
  migrationModal?.querySelector('[data-action="close-migration-modal"]')?.addEventListener("click", dismissMigrationModal);
  migrationModal?.addEventListener("click", (event) => {
    if (event.target === migrationModal) dismissMigrationModal();
  });
  migrationModal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismissMigrationModal();
  });
  migrationModal?.querySelector('[data-action="close-migration-modal"]')?.focus({ preventScroll: true });
  app.querySelector('[data-action="migrate-projects"]')?.addEventListener("click", migrateLegacyProjects);
  app.querySelectorAll('[data-action="new-project"]').forEach((button) => button.addEventListener("click", createProject));
  app.querySelectorAll("[data-project-id]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openProject(link.dataset.projectId);
    });
    link.addEventListener("contextmenu", (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        window.open(link.href, "_blank", "noopener");
        return;
      }
      showProjectMenu(event, link.dataset.projectId);
    });
  });
}

async function migrateLegacyProjects(event) {
  const button = event.currentTarget;
  const status = app.querySelector("[data-migration-status]");
  button.disabled = true;
  button.textContent = "Opening CarouselBot…";
  try {
    const summary = await domainMigration.start([...state.projects], {
      onProgress: ({ completed, total }) => {
        button.textContent = `Copying ${completed} of ${total}…`;
        if (status) status.textContent = "Keep both tabs open while your projects and images are copied.";
      },
    });
    if (status) status.textContent = `Copied ${summary.projectCount} ${summary.projectCount === 1 ? "project" : "projects"} to carousel.bot. Your originals are still safe here.`;
    button.textContent = "Projects copied";
  } catch (error) {
    console.error(error);
    if (status) status.textContent = error.message;
    button.disabled = false;
    button.textContent = "Try again";
  }
}

export function bindGlobalActions() {
  const homeLink = app.querySelector('[data-action="home"]');
  homeLink?.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openDashboard();
  });
  homeLink?.addEventListener("contextmenu", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    window.open(homeLink.href, "_blank", "noopener");
  });
}

function bindEditorEvents() {
  bindGlobalActions();
  const title = app.querySelector(".project-title-input");
  title?.addEventListener("input", () => {
    activeProject().name = title.value || "New Project";
    document.title = `${activeProject().name} · CarouselBot`;
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

export function clearSlideThumbnail(slideId) {
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
  const slideType = "application/x-carouselbot-slide";
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
    const baseRevision = Number(project.revision) || 0;
    project.updatedAt = Date.now();
    project.revision = baseRevision + 1;
    await putProject(project, { expectedRevision: baseRevision });
    toast(`${added} ${added === 1 ? "asset" : "assets"} uploaded`);
    renderEditor();
  } catch (error) {
    console.error(error);
    if (error.code === "STALE_PROJECT") await reloadProjectFromDb(project.id);
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

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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

function rememberCopiedLayer(copied) {
  state.copiedLayer = copied;
  try {
    localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(copied));
    localStorage.setItem(LEGACY_CLIPBOARD_STORAGE_KEY, JSON.stringify(copied));
  } catch (error) {
    console.warn("Could not share the copied layer with other tabs.", error);
  }
}

function storedCopiedLayer(token) {
  try {
    const copied = parseCopiedLayer(localStorage.getItem(CLIPBOARD_STORAGE_KEY))
      || parseCopiedLayer(localStorage.getItem(LEGACY_CLIPBOARD_STORAGE_KEY));
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
  event.clipboardData?.setData(LEGACY_CLIPBOARD_LAYER_TYPE, JSON.stringify(copied));
  event.clipboardData?.setData("text/plain", `carouselbot-layer:${token}`);
  toast(copies.length === 1
    ? `${copies[0].kind === "overlay" ? "Asset" : "Text"} copied`
    : `${copies.length} layers copied`);
}

function copiedLayerFromClipboard(clipboardData) {
  if (!clipboardData) return null;
  const clipboardLayer = parseCopiedLayer(clipboardData.getData(CLIPBOARD_LAYER_TYPE))
    || parseCopiedLayer(clipboardData.getData(LEGACY_CLIPBOARD_LAYER_TYPE));
  let token = clipboardLayer?.token || clipboardData.getData(CLIPBOARD_LAYER_TYPE) || clipboardData.getData(LEGACY_CLIPBOARD_LAYER_TYPE);
  if (!token) {
    const text = clipboardData.getData("text/plain");
    if (text.startsWith("carouselbot-layer:")) token = text.slice("carouselbot-layer:".length);
    else if (text.startsWith("slide-studio-layer:")) token = text.slice("slide-studio-layer:".length);
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

export async function init() {
  try {
    state.db = await openDatabase(DB_NAME);
    state.projects = await getAllProjects();
    state.projects.forEach((project) => {
      if (!Number.isFinite(Number(project.revision))) project.revision = 0;
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
        if (!Array.isArray(slide.texts)) slide.texts = [];
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
  window.addEventListener("carouselbot:migration-complete", async (event) => {
    state.projects = await getAllProjects();
    renderDashboard();
    const { imported = 0, updated = 0, skipped = 0 } = event.detail || {};
    toast(`Projects ready: ${imported} copied, ${updated} updated${skipped ? `, ${skipped} already current` : ""}.`);
  });
  try {
    domainMigration.registerImporter(importMigratedProject);
  } catch (error) {
    console.error(error);
    toast(error.message);
  }
  if (domainMigration.isLegacyOrigin
    && domainMigration.config.autoForwardEmptyLegacyStorage
    && !domainMigration.hasPendingProjects(state.projects)) {
    window.location.replace(domainMigration.config.canonicalOrigin);
    return;
  }
  renderCurrentRoute();
  window.addEventListener("popstate", renderCurrentRoute);
  window.addEventListener("pageshow", () => {
    if (!state.activeProjectId) void refreshDashboardProjects();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.activeProjectId) void refreshDashboardProjects();
  });
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

let dashboardRefreshPromise = null;

function refreshDashboardProjects() {
  if (!state.db || state.activeProjectId) return Promise.resolve();
  if (dashboardRefreshPromise) return dashboardRefreshPromise;
  dashboardRefreshPromise = getAllProjects()
    .then((projects) => {
      if (state.activeProjectId) return;
      state.projects = projects;
      renderDashboard();
      bindGlobalActions();
    })
    .catch((error) => console.error("Could not refresh dashboard projects", error))
    .finally(() => { dashboardRefreshPromise = null; });
  return dashboardRefreshPromise;
}
