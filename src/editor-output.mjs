import { safeFilename, slideVideoDuration, scaleCanvasDimensions, slideCanvasDimensions } from "./editor-model.mjs";
import { renderSlideMp4 } from "./video-export.mjs";
import {
  state,
  app,
  activeProject,
  activeSlide,
  slideThumbnailKey,
} from "./editor-state.mjs";
import { getProjectFromDb, getStoredPreview, storePreview } from "./project-store.mjs";
import { renderSlideThumbnail } from "./editor-view.mjs";
import { canvasToBlob, renderSlideCanvas, renderAssetThumbnail } from "./slide-renderer.mjs";

export function createEditorOutput({ toast }) {
  const thumbnailRenderQueue = [];
  let activeThumbnailRenders = 0;
  let dashboardThumbnailObserver = null;
  let coverObserver = null;
  let assetObserver = null;
  let assetGeneration = 0;
  const assetUrls = new Map();
  let coverGeneration = 0;
  let dashboardThumbnailKeys = new Set();
  let slideObservationGeneration = 0;

  function acquireThumbnailRenderSlot(key) {
    const queued = thumbnailRenderQueue.findIndex((entry) => entry.key === key);
    if (queued >= 0) thumbnailRenderQueue.splice(queued, 1)[0].resolve(false);
    if (activeThumbnailRenders < 2) {
      activeThumbnailRenders += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => thumbnailRenderQueue.push({ key, resolve }));
  }

  function cancelPendingThumbnailRenders() {
    for (const entry of thumbnailRenderQueue.splice(0)) entry.resolve(false);
  }

  function releaseThumbnailRenderSlot() {
    const next = thumbnailRenderQueue.shift();
    if (next) next.resolve(true);
    else activeThumbnailRenders = Math.max(0, activeThumbnailRenders - 1);
  }

  function previewIsVisible(target) {
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < -160 || rect.top > innerHeight + 160
      || rect.right < -160 || rect.left > innerWidth + 160) return false;
    const clip = target.closest("[data-project-preview-strip], .slide-list, .asset-grid");
    if (!clip) return true;
    const bounds = clip.getBoundingClientRect();
    return rect.right > bounds.left && rect.left < bounds.right
      && rect.bottom > bounds.top && rect.top < bounds.bottom;
  }

  let videoExportBusy = false;
  function projectCoverSignature(project) {
    const slide = project.slides[0];
    return slide ? `${Number(project.revision) || 0}:${slide.id}:${thumbnailSignature(slide, project)}` : "";
  }

  async function refreshProjectCover(project, generation = coverGeneration) {
    if (generation !== coverGeneration) return;
    let slide = project.slides[0];
    const target = app.querySelector(`[data-project-cover-id="${project.id}"]`);
    if (!target) return;
    if (!slide) {
      clearProjectCover(project.id);
      const overflowLabel = target.querySelector(".folder-preview-more");
      target.innerHTML = target.classList.contains("folder-preview-slot") ? "" : `<span class="project-preview-empty">No slides yet</span>`;
      if (overflowLabel) target.appendChild(overflowLabel);
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

    const version = Symbol("cover");
    state.projectCoverVersions.set(project.id, version);
    target.classList.add("is-rendering");
    if (!await acquireThumbnailRenderSlot(`cover:${project.id}`)) return;
    try {
      if (generation !== coverGeneration || state.projectCoverVersions.get(project.id) !== version || !target.isConnected) return;
      const key = JSON.stringify([project.id, "cover"]);
      let blob = await getStoredPreview(key, signature);
      if (!blob) {
        if (project.__catalog) project = await getProjectFromDb(project.id);
        if (!project || generation !== coverGeneration) return;
        slide = project.slides[0];
        if (!slide) return;
        const preview = scaleCanvasDimensions(project, 270, slide);
        const canvas = await renderSlideCanvas(slide, preview.width, preview.height, project);
        blob = await canvasToBlob(canvas);
        if (generation !== coverGeneration || state.projectCoverVersions.get(project.id) !== version) return;
        storePreview(key, signature, blob, project);
      }
      if (generation !== coverGeneration || state.projectCoverVersions.get(project.id) !== version) return;
      const url = URL.createObjectURL(blob);
      const previousUrl = state.projectCoverUrls.get(project.id);
      state.projectCoverUrls.set(project.id, url);
      state.projectCoverSignatures.set(project.id, signature);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      const currentTarget = app.querySelector(`[data-project-cover-id="${project.id}"]`);
      if (currentTarget) {
        const overflowLabel = currentTarget.querySelector(".folder-preview-more");
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        image.dataset.compositeCover = "true";
        currentTarget.replaceChildren(image);
        currentTarget.removeAttribute("title");
        if (overflowLabel) currentTarget.appendChild(overflowLabel);
        currentTarget.classList.remove("is-rendering");
      }
    } catch (error) {
      if (generation !== coverGeneration || state.projectCoverVersions.get(project.id) !== version) return;
      console.error("Could not render project cover", error);
      const fallback = slide.imageData ? await renderAssetThumbnail(slide).catch(() => null) : null;
      if (generation !== coverGeneration || state.projectCoverVersions.get(project.id) !== version) return;
      clearProjectCover(project.id);
      const currentTarget = app.querySelector(`[data-project-cover-id="${project.id}"]`);
      if (currentTarget) {
        const overflowLabel = currentTarget.querySelector(".folder-preview-more");
        currentTarget.classList.remove("is-rendering");
        currentTarget.title = error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Preview unavailable";
        if (fallback) {
          const image = document.createElement("img");
          image.src = URL.createObjectURL(fallback);
          state.projectCoverUrls.set(project.id, image.src);
          image.alt = "";
          currentTarget.replaceChildren(image);
        } else {
          currentTarget.innerHTML = currentTarget.classList.contains("folder-preview-slot") ? "" : `<span class="project-preview-empty">Preview unavailable</span>`;
        }
        if (overflowLabel) currentTarget.appendChild(overflowLabel);
      }
    } finally {
      releaseThumbnailRenderSlot();
    }
  }

  function refreshAllProjectCovers(projects = state.projects) {
    coverObserver?.disconnect();
    const generation = ++coverGeneration;
    const byId = new Map(projects.map((project) => [project.id, project]));
    const targets = [...app.querySelectorAll("[data-project-cover-id]")];
    const visibleIds = new Set(targets.map((target) => target.dataset.projectCoverId));
    for (const id of state.projectCoverUrls.keys()) if (!visibleIds.has(id)) clearProjectCover(id);
    const requested = new WeakSet();
    const refresh = (target) => {
      if (requested.has(target)) return;
      requested.add(target);
      const project = byId.get(target.dataset.projectCoverId);
      if (project) void refreshProjectCover(project, generation);
    };
    if (typeof IntersectionObserver !== "function") { targets.forEach(refresh); return; }
    coverObserver = new IntersectionObserver((entries) => {
      if (generation !== coverGeneration) return;
      for (const entry of entries) {
        if (entry.isIntersecting) refresh(entry.target);
        else {
          requested.delete(entry.target);
          clearProjectCover(entry.target.dataset.projectCoverId);
          entry.target.querySelector("img")?.remove();
        }
      }
    }, { rootMargin: "160px" });
    targets.forEach((target) => {
      coverObserver.observe(target);
      if (previewIsVisible(target)) refresh(target);
    });
  }

  function clearProjectCover(projectId) {
    const url = state.projectCoverUrls.get(projectId);
    if (url) URL.revokeObjectURL(url);
    state.projectCoverUrls.delete(projectId);
    state.projectCoverSignatures.delete(projectId);
    state.projectCoverVersions.delete(projectId);
  }

  function scheduleThumbnailRefresh() {
    clearTimeout(state.thumbnailRefreshTimer);
    state.thumbnailRefreshTimer = setTimeout(() => {
      state.thumbnailRefreshTimer = null;
      const slide = activeSlide();
      if (slide) refreshSlideThumbnail(slide);
    }, 80);
  }

  function thumbnailSignature(slide, project = activeProject()) {
    const fontIds = new Set((slide.texts || []).map((text) => text.fontId).filter(Boolean));
    const fonts = (project?.fonts || [])
      .filter((font) => fontIds.has(font.id))
      .map((font) => [font.id, font.fingerprint || font.localFontId || "", font.dataRevision || ""]);
    return JSON.stringify([
      slideCanvasDimensions(project, slide),
      slide.backgroundRevision || "",
      slide.backgroundColor || "",
      slide.imageScale || 1,
      slide.imageX || 0,
      slide.imageY || 0,
      slide.texts || [],
      slide.overlays || [],
      fonts,
    ]);
  }

  function slideThumbnailTargets(slideId, project) {
    return [...app.querySelectorAll("[data-thumbnail-slide-id][data-thumbnail-project-id]")]
      .filter((target) => target.dataset.thumbnailSlideId === String(slideId)
        && target.dataset.thumbnailProjectId === String(project?.id || ""));
  }

  async function refreshSlideThumbnail(slide, project = activeProject()) {
    const targets = slideThumbnailTargets(slide.id, project);
    if (!targets.length) return;
    const cacheKey = slideThumbnailKey(project?.id, slide.id);
    const storedKey = JSON.stringify([project?.id, "slide", slide.id]);
    const signature = `${Number(project?.revision) || 0}:${thumbnailSignature(slide, project)}`;
    const renderToken = Symbol("slide-thumbnail-render");
    state.thumbnailVersions.set(cacheKey, renderToken);
    const cachedUrl = state.thumbnailUrls.get(cacheKey);
    if (cachedUrl && state.thumbnailSignatures.get(cacheKey) === signature) {
      targets.forEach((target) => {
        const image = target.querySelector(".thumb-rendered");
        if (image) {
          if (image.src !== cachedUrl) image.src = cachedUrl;
        } else {
          target.innerHTML = renderSlideThumbnail(slide, project);
        }
        target.classList.remove("is-rendering");
      });
      return;
    }

    targets.forEach((target) => target.classList.add("is-rendering"));
    if (!await acquireThumbnailRenderSlot(`slide:${cacheKey}`)) return;
    try {
      if (state.thumbnailVersions.get(cacheKey) !== renderToken || !slideThumbnailTargets(slide.id, project).length) return;
      let blob = await getStoredPreview(storedKey, signature);
      if (!blob) {
        const slideId = slide.id;
        if (project.__catalog) project = await getProjectFromDb(project.id);
        if (!project || state.thumbnailVersions.get(cacheKey) !== renderToken) return;
        slide = project.slides.find((item) => item.id === slideId);
        if (!slide) return;
        const preview = scaleCanvasDimensions(project, 540, slide);
        const canvas = await renderSlideCanvas(slide, preview.width, preview.height, project);
        blob = await canvasToBlob(canvas);
        if (state.thumbnailVersions.get(cacheKey) !== renderToken) return;
        storePreview(storedKey, signature, blob, project);
      }
      if (state.thumbnailVersions.get(cacheKey) !== renderToken) return;
      const url = URL.createObjectURL(blob);
      const previousUrl = state.thumbnailUrls.get(cacheKey);
      state.thumbnailUrls.set(cacheKey, url);
      state.thumbnailSignatures.set(cacheKey, signature);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      slideThumbnailTargets(slide.id, project).forEach((currentTarget) => {
        currentTarget.innerHTML = renderSlideThumbnail(slide, project);
        currentTarget.removeAttribute("title");
        currentTarget.classList.remove("is-rendering");
      });
    } catch (error) {
      if (state.thumbnailVersions.get(cacheKey) !== renderToken) return;
      console.error(error);
      const fallback = slide.imageData ? await renderAssetThumbnail(slide).catch(() => null) : null;
      if (state.thumbnailVersions.get(cacheKey) !== renderToken) return;
      clearSlideThumbnail(slide.id, project?.id);
      const fallbackUrl = fallback ? URL.createObjectURL(fallback) : null;
      if (fallbackUrl) state.thumbnailUrls.set(cacheKey, fallbackUrl);
      slideThumbnailTargets(slide.id, project).forEach((currentTarget) => {
        currentTarget.classList.remove("is-rendering");
        currentTarget.title = error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Preview unavailable";
        if (currentTarget.classList.contains("project-preview-slide") && fallbackUrl) {
          const image = document.createElement("img");
          image.className = "project-preview-source";
          image.src = fallbackUrl;
          image.alt = "";
          image.draggable = false;
          image.loading = "lazy";
          image.decoding = "async";
          image.setAttribute("aria-hidden", "true");
          currentTarget.replaceChildren(image);
        } else {
          currentTarget.innerHTML = renderSlideThumbnail(slide, project);
        }
      });
    } finally {
      releaseThumbnailRenderSlot();
    }
  }

  function refreshAllSlideThumbnails(slides, project = activeProject()) {
    disconnectDashboardSlideThumbnails();
    releaseUnusedPreviews();
    observeSlideTargets([project]);
    refreshAssetPreviews(project);
  }

  function refreshAssetPreviews(project) {
    assetObserver?.disconnect();
    const generation = ++assetGeneration;
    for (const url of assetUrls.values()) URL.revokeObjectURL(url);
    assetUrls.clear();
    if (!project) return;
    const versions = new WeakMap();
    assetObserver = new IntersectionObserver((entries) => {
      if (generation !== assetGeneration) return;
      for (const entry of entries) {
        const token = Symbol("asset-preview");
        versions.set(entry.target, token);
        entry.target.dataset.previewVisible = String(entry.isIntersecting);
        if (!entry.isIntersecting) {
          const id = entry.target.dataset.assetPreviewId;
          if (assetUrls.has(id)) URL.revokeObjectURL(assetUrls.get(id));
          assetUrls.delete(id);
          entry.target.removeAttribute("src");
          continue;
        }
        void (async () => {
          if (!await acquireThumbnailRenderSlot(`asset:${project.id}:${entry.target.dataset.assetPreviewId}`)) return;
          try {
            if (generation !== assetGeneration || !entry.target.isConnected || versions.get(entry.target) !== token || entry.target.dataset.previewVisible !== "true") return;
            const asset = project.assets.find((item) => item.id === entry.target.dataset.assetPreviewId);
            if (!asset) return;
            const key = JSON.stringify([project.id, "asset", asset.id]);
            const signature = asset.fingerprint || `${Number(project.revision) || 0}:${asset.id}`;
            let blob = await getStoredPreview(key, signature);
            if (!blob) {
              blob = await renderAssetThumbnail(asset);
              storePreview(key, signature, blob, project);
            }
            if (generation !== assetGeneration || !entry.target.isConnected || versions.get(entry.target) !== token || entry.target.dataset.previewVisible !== "true") return;
            const url = URL.createObjectURL(blob);
            if (assetUrls.has(asset.id)) URL.revokeObjectURL(assetUrls.get(asset.id));
            assetUrls.set(asset.id, url);
            entry.target.src = url;
          } catch (error) { console.error("Could not render asset preview", error); }
          finally { releaseThumbnailRenderSlot(); }
        })();
      }
    }, { rootMargin: "160px" });
    app.querySelectorAll("[data-asset-preview-id]").forEach((target) => assetObserver.observe(target));
  }

  function refreshDashboardSlideThumbnails(projects) {
    refreshAssetPreviews(null);
    disconnectDashboardSlideThumbnails();
    observeSlideTargets(projects);
  }

  function observeSlideTargets(projects) {
    const generation = slideObservationGeneration;
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const targets = [...app.querySelectorAll("[data-thumbnail-project-id][data-thumbnail-slide-id]")];
    dashboardThumbnailKeys = new Set(targets.map((target) => slideThumbnailKey(
      target.dataset.thumbnailProjectId,
      target.dataset.thumbnailSlideId,
    )));
    dashboardThumbnailKeys.forEach((cacheKey) => {
      state.thumbnailVersions.set(cacheKey, Symbol("dashboard-thumbnail-generation"));
    });
    const requested = new WeakSet();
    const refreshTarget = (target) => {
      if (requested.has(target)) return;
      requested.add(target);
      const project = projectsById.get(target.dataset.thumbnailProjectId);
      const slide = project?.slides.find((item) => item.id === target.dataset.thumbnailSlideId);
      if (slide) void refreshSlideThumbnail(slide, project);
    };

    const deferredTargets = targets;
    releaseUnusedPreviews();
    if (!deferredTargets.length) return;
    if (typeof IntersectionObserver !== "function") {
      deferredTargets.forEach(refreshTarget);
      return;
    }

    dashboardThumbnailObserver = new IntersectionObserver((entries) => {
      if (generation !== slideObservationGeneration) return;
      entries.forEach((entry) => {
        if (entry.isIntersecting) refreshTarget(entry.target);
        else {
          requested.delete(entry.target);
          const key = slideThumbnailKey(entry.target.dataset.thumbnailProjectId, entry.target.dataset.thumbnailSlideId);
          clearThumbnailCacheKey(key);
          entry.target.innerHTML = '<span class="thumb-rendering-placeholder" aria-hidden="true"><span></span></span>';
        }
      });
    }, { rootMargin: "160px", threshold: 0.01 });
    deferredTargets.forEach((target) => {
      dashboardThumbnailObserver.observe(target);
      // Keep in-viewport previews current even when background tabs throttle frames.
      if (previewIsVisible(target)) refreshTarget(target);
    });
  }

  function disconnectDashboardSlideThumbnails() {
    slideObservationGeneration += 1;
    dashboardThumbnailObserver?.disconnect();
    dashboardThumbnailObserver = null;
    dashboardThumbnailKeys.forEach((cacheKey) => {
      if (state.thumbnailVersions.has(cacheKey)) {
        state.thumbnailVersions.set(cacheKey, Symbol("dashboard-thumbnail-disconnected"));
      }
    });
    dashboardThumbnailKeys = new Set();
  }

  function releaseUnusedPreviews() {
    const liveKeys = new Set([...app.querySelectorAll("[data-thumbnail-project-id][data-thumbnail-slide-id]")]
      .map((target) => slideThumbnailKey(target.dataset.thumbnailProjectId, target.dataset.thumbnailSlideId)));
    for (const key of state.thumbnailVersions.keys()) if (!liveKeys.has(key)) clearThumbnailCacheKey(key);
    for (const key of state.thumbnailUrls.keys()) if (!liveKeys.has(key)) clearThumbnailCacheKey(key);
    if (state.activeProjectId) {
      coverGeneration += 1;
      coverObserver?.disconnect();
      for (const id of new Set([...state.projectCoverVersions.keys(), ...state.projectCoverUrls.keys()])) clearProjectCover(id);
    }
  }

  function clearThumbnailCacheKey(cacheKey) {
    const thumbnailUrl = state.thumbnailUrls.get(cacheKey);
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    state.thumbnailUrls.delete(cacheKey);
    state.thumbnailSignatures.delete(cacheKey);
    state.thumbnailVersions.delete(cacheKey);
  }

  function clearSlideThumbnail(slideId, projectId = state.activeProjectId) {
    if (projectId) {
      clearThumbnailCacheKey(slideThumbnailKey(projectId, slideId));
      return;
    }
    const knownKeys = new Set([
      ...state.thumbnailUrls.keys(),
      ...state.thumbnailSignatures.keys(),
      ...state.thumbnailVersions.keys(),
    ]);
    knownKeys.forEach((cacheKey) => {
      try {
        if (JSON.parse(cacheKey)[1] === String(slideId)) clearThumbnailCacheKey(cacheKey);
      } catch {
        if (cacheKey === slideId) clearThumbnailCacheKey(cacheKey);
      }
    });
  }

  function pruneSlideThumbnails(projects = state.projects) {
    const liveKeys = new Set(projects.flatMap((project) => project.slides.map((slide) => slideThumbnailKey(project.id, slide.id))));
    const knownKeys = new Set([
      ...state.thumbnailUrls.keys(),
      ...state.thumbnailSignatures.keys(),
      ...state.thumbnailVersions.keys(),
    ]);
    knownKeys.forEach((cacheKey) => {
      if (!liveKeys.has(cacheKey)) clearThumbnailCacheKey(cacheKey);
    });
  }

  async function renderSlideBlob(slide = activeSlide(), project = activeProject()) {
    if (!slide) return null;
    if (slideVideoDuration(slide, project)) {
      if (videoExportBusy) throw new Error("A video export is already running.");
      videoExportBusy = true;
      const snapshot = structuredClone(project);
      try { return await renderSlideMp4(snapshot.slides.find((item) => item.id === slide.id), snapshot); }
      finally { videoExportBusy = false; }
    }
    const canvas = await renderSlideCanvas(slide, undefined, undefined, project);
    return canvasToBlob(canvas);
  }

  function slideExportName(slide = activeSlide(), index = null) {
    const order = index == null ? "" : `${String(index + 1).padStart(2, "0")}-`;
    return `${order}${safeFilename(activeProject().name)}-${safeFilename(slide.name)}.${slideVideoDuration(slide, activeProject()) ? "mp4" : "png"}`;
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
      const blob = await renderSlideBlob(slide);
      if (!blob) throw new Error("Could not create PNG");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = slideExportName(slide);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`${slideVideoDuration(slide, activeProject()) ? "MP4" : "PNG"} downloaded at full resolution`);
    } catch (error) {
      console.error(error);
      toast(error.message?.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") || "The slide couldn’t be downloaded.");
    } finally {
      if (exportButton) {
        exportButton.disabled = false;
        exportButton.innerHTML = oldLabel;
      }
    }
  }

  let exportingAll = false;

  async function exportAllSlides() {
    if (exportingAll || !activeProject()?.slides.length) return;
    const project = structuredClone(activeProject());
    const button = app.querySelector('[data-action="export-all"]');
    const oldLabel = button?.innerHTML;
    exportingAll = true;
    if (button) button.disabled = true;
    try {
      const digits = Math.max(2, String(project.slides.length).length);
      for (const [index, slide] of project.slides.entries()) {
        if (button) button.textContent = `Rendering ${index + 1}/${project.slides.length}…`;
        const blob = await renderSlideBlob(slide, project);
        if (!blob) throw new Error(`Could not create PNG for slide ${index + 1}`);
        const url = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `${safeFilename(project.name)}-slide-${String(index + 1).padStart(digits, "0")}.${slideVideoDuration(slide, project) ? "mp4" : "png"}`;
          anchor.click();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      }
      toast("All downloads started in slide order");
    } catch (error) {
      console.error(error);
      toast(error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Couldn’t download all slides. Please try again.");
    } finally {
      exportingAll = false;
      if (button) {
        button.disabled = false;
        button.innerHTML = oldLabel;
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
      const blob = await renderSlideBlob(slide);
      if (!blob) throw new Error("Could not create PNG");
      const file = new File([blob], slideExportName(slide), { type: blob.type });
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
        toast("Sharing isn’t available in this browser. Use Download.");
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error(error);
      toast(error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Couldn’t open the share menu.");
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
          const blob = await renderSlideBlob(slide, project);
          if (!blob) throw new Error(`Could not create PNG for slide ${index + 1}`);
          files.push(new File([blob], slideExportName(slide, index), { type: blob.type }));
        }
        state.shareAllCache = {
          projectId: project.id,
          projectUpdatedAt: project.updatedAt,
          files,
        };
      }
      if (navigator.canShare?.({ files })) {
        if (navigator.userActivation && !navigator.userActivation.isActive) {
          toast("Slides are ready — tap All beside AirDrop again.");
          return;
        }
        await navigator.share({ files });
        state.shareAllCache = null;
      } else {
        state.shareAllCache = null;
        toast("This browser can’t share multiple files at once.");
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (error?.name === "NotAllowedError" && state.shareAllCache) {
        toast("Slides are ready — tap All beside AirDrop again.");
        return;
      }
      state.shareAllCache = null;
      console.error(error);
      toast(error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Couldn’t open the share menu for all slides.");
    } finally {
      shareButtons.forEach((button) => { button.disabled = false; });
      if (shareButton) shareButton.innerHTML = oldLabel;
    }
  }

  return {
    cancelPendingThumbnailRenders,
    scheduleThumbnailRefresh,
    refreshAllProjectCovers,
    clearProjectCover,
    refreshAllSlideThumbnails,
    refreshDashboardSlideThumbnails,
    disconnectDashboardSlideThumbnails,
    clearSlideThumbnail,
    pruneSlideThumbnails,
    exportActiveSlide,
    exportAllSlides,
    shareActiveSlide,
    shareAllSlides,
  };
}
