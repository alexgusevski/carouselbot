import {
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  TEXT_WEIGHT,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_MAX,
  projectPath,
  adjacentSlideId,
  escapeHtml,
  normalizeHexColor,
  textColor,
  rgbToHex,
  formatRgb,
  ensureBoxedTextContrast,
  layerKey,
  fontSizeFromSliderPosition,
  sliderPositionFromFontSize,
  formatFontSize,
  getImageLayout,
  clamp,
} from "./editor-model.mjs";
import {
  state,
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
  constrainImagePosition,
} from "./editor-state.mjs";
import {
  formatDate,
  icon,
  renderHeader,
  renderLegacyMigrationNotice,
  renderSlideRail,
  renderAssetRail,
  renderEmptyStage,
  renderStage,
  renderInspector,
  updateTextBox,
  updateOverlayBox,
  updateStageImage,
} from "./editor-view.mjs";
import { createLayerInteractions } from "./layer-interactions.mjs";

export function createEditorUI({ projects, actions, output }) {
  const {
    recordHistory,
    scheduleSave,
    bindDashboardEvents,
    bindGlobalActions,
    domainMigration,
  } = projects;
  const {
    clearLayerSelection,
    moveLayer,
    beginCrop,
    finishCrop,
    addText,
    deleteSelectedText,
    beginSlideBackgroundChange,
    handleSlideBackgroundChange,
    removeSlide,
    reorderSlide,
    addDroppedAssetsToSlide,
    addOverlayFromAsset,
    handleAssetUpload,
    deleteProjectAsset,
    deleteSelectedOverlay,
    deleteSelectedLayers,
    handleUpload,
    addSlidesFromFiles,
    imageFilesFromTransfer,
  } = actions;
  const {
    refreshAllProjectCovers,
    refreshAllSlideThumbnails,
    exportActiveSlide,
    shareActiveSlide,
    shareAllSlides,
  } = output;

  const {
    bindOverlayBox,
    bindTextBox,
    activeTextEditingBox,
    isInlineTextEditing,
    endTextEditing,
    beginImageDrag,
  } = createLayerInteractions({
    recordHistory,
    clearLayerSelection,
    showLayerMenu,
    finishCrop,
    scheduleSave,
    refreshSelection,
    ensureTextFits,
    deleteSelectedLayers,
  });

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


  function toast(message) {
    document.querySelector(".toast")?.remove();
    clearTimeout(state.toastTimer);
    const element = document.createElement("div");
    element.className = "toast";
    element.textContent = message;
    document.body.appendChild(element);
    state.toastTimer = setTimeout(() => element.remove(), 2600);
  }

  function renderDashboard() {
    hideAssetPreview();
    state.activeProjectId = null;
    state.activeSlideId = null;
    clearLayerSelection();
    document.title = "CarouselBot";
    const sortedProjects = [...state.projects].sort((a, b) => b.updatedAt - a.updatedAt);
    app.innerHTML = `
      ${renderHeader()}
      ${renderLegacyMigrationNotice(sortedProjects, domainMigration, projects.isMigrationModalDismissed())}
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


  function renderEditor() {
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

  function activateSlide(slideId, { reveal = false } = {}) {
    const project = activeProject();
    if (!project?.slides.some((slide) => slide.id === slideId)) return false;
    state.activeSlideId = slideId;
    clearLayerSelection();
    state.photoAdjustMode = false;
    closeLayerMenu();
    renderEditor();
    if (reveal) {
      app.querySelector(".slide-thumb.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    return true;
  }

  function navigateSlides(offset) {
    const project = activeProject();
    const slideId = adjacentSlideId(project?.slides, state.activeSlideId, offset);
    if (!slideId) return false;
    if (slideId !== state.activeSlideId) activateSlide(slideId, { reveal: true });
    return true;
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
        activateSlide(button.dataset.slideId);
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


  return {
    toast,
    renderDashboard,
    renderEditor,
    navigateSlides,
    refreshSelection,
    ensureTextFits,
    setCanvasZoom,
    closeLayerMenu,
    activeTextEditingBox,
    isInlineTextEditing,
    endTextEditing,
  };
}
