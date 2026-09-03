import { safeFilename, scaleCanvasDimensions, slideCanvasDimensions } from "./editor-model.mjs";
import {
  state,
  app,
  activeProject,
  activeSlide,
  slideThumbnailKey,
} from "./editor-state.mjs";
import { renderSlideThumbnail } from "./editor-view.mjs";
import { canvasToBlob, renderSlideCanvas } from "./slide-renderer.mjs";

export function createEditorOutput({ toast }) {
  const thumbnailRenderQueue = [];
  let activeThumbnailRenders = 0;
  let dashboardThumbnailObserver = null;
  let dashboardThumbnailKeys = new Set();

  function acquireThumbnailRenderSlot() {
    if (activeThumbnailRenders < 4) {
      activeThumbnailRenders += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => thumbnailRenderQueue.push(resolve));
  }

  function releaseThumbnailRenderSlot() {
    const next = thumbnailRenderQueue.shift();
    if (next) next();
    else activeThumbnailRenders = Math.max(0, activeThumbnailRenders - 1);
  }

  function projectCoverSignature(project) {
    const slide = project.slides[0];
    return slide ? `${Number(project.revision) || 0}:${slide.id}:${thumbnailSignature(slide, project)}` : "";
  }

  async function refreshProjectCover(project) {
    const slide = project.slides[0];
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

    const version = (state.projectCoverVersions.get(project.id) || 0) + 1;
    state.projectCoverVersions.set(project.id, version);
    target.classList.add("is-rendering");
    try {
      const preview = scaleCanvasDimensions(project, 270, slide);
      const canvas = await renderSlideCanvas(slide, preview.width, preview.height, project);
      const blob = await canvasToBlob(canvas);
      if (state.projectCoverVersions.get(project.id) !== version) return;
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
      console.error("Could not render project cover", error);
      clearProjectCover(project.id);
      const currentTarget = app.querySelector(`[data-project-cover-id="${project.id}"]`);
      if (currentTarget) {
        const overflowLabel = currentTarget.querySelector(".folder-preview-more");
        currentTarget.classList.remove("is-rendering");
        currentTarget.title = error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Preview unavailable";
        if (slide.imageData) {
          const image = document.createElement("img");
          image.src = slide.imageData;
          image.alt = "";
          currentTarget.replaceChildren(image);
        } else {
          currentTarget.innerHTML = currentTarget.classList.contains("folder-preview-slot") ? "" : `<span class="project-preview-empty">Preview unavailable</span>`;
        }
        if (overflowLabel) currentTarget.appendChild(overflowLabel);
      }
    }
  }

  function refreshAllProjectCovers(projects = state.projects) {
    projects.forEach((project) => { void refreshProjectCover(project); });
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
      .map((font) => [font.id, font.fingerprint || font.localFontId || "", font.dataRevision || "", font.fontData?.length || 0]);
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
    const signature = thumbnailSignature(slide, project);
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
    await acquireThumbnailRenderSlot();
    try {
      if (state.thumbnailVersions.get(cacheKey) !== renderToken || !slideThumbnailTargets(slide.id, project).length) return;
      const preview = scaleCanvasDimensions(project, 540, slide);
      const canvas = await renderSlideCanvas(slide, preview.width, preview.height, project);
      const blob = await canvasToBlob(canvas);
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
      clearSlideThumbnail(slide.id, project?.id);
      slideThumbnailTargets(slide.id, project).forEach((currentTarget) => {
        currentTarget.classList.remove("is-rendering");
        currentTarget.title = error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Preview unavailable";
        if (currentTarget.classList.contains("project-preview-slide") && slide.imageData) {
          const image = document.createElement("img");
          image.className = "project-preview-source";
          image.src = slide.imageData;
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
    slides.forEach((slide) => { void refreshSlideThumbnail(slide, project); });
  }

  function refreshDashboardSlideThumbnails(projects) {
    disconnectDashboardSlideThumbnails();
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const targets = [...app.querySelectorAll(".project-preview-slide[data-thumbnail-project-id][data-thumbnail-slide-id]")];
    dashboardThumbnailKeys = new Set(targets.map((target) => slideThumbnailKey(
      target.dataset.thumbnailProjectId,
      target.dataset.thumbnailSlideId,
    )));
    dashboardThumbnailKeys.forEach((cacheKey) => {
      state.thumbnailVersions.set(cacheKey, Symbol("dashboard-thumbnail-generation"));
    });
    const refreshTarget = (target) => {
      const project = projectsById.get(target.dataset.thumbnailProjectId);
      const slide = project?.slides.find((item) => item.id === target.dataset.thumbnailSlideId);
      if (slide) void refreshSlideThumbnail(slide, project);
    };

    const eagerProjectIds = new Set();
    const deferredTargets = [];
    targets.forEach((target) => {
      if (!eagerProjectIds.has(target.dataset.thumbnailProjectId)) {
        eagerProjectIds.add(target.dataset.thumbnailProjectId);
        refreshTarget(target);
      } else {
        deferredTargets.push(target);
      }
    });
    if (!deferredTargets.length) return;
    if (typeof IntersectionObserver !== "function") {
      deferredTargets.forEach(refreshTarget);
      return;
    }

    dashboardThumbnailObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        refreshTarget(entry.target);
      });
    }, { rootMargin: "160px", threshold: 0.01 });
    deferredTargets.forEach((target) => dashboardThumbnailObserver.observe(target));
  }

  function disconnectDashboardSlideThumbnails() {
    dashboardThumbnailObserver?.disconnect();
    dashboardThumbnailObserver = null;
    dashboardThumbnailKeys.forEach((cacheKey) => {
      if (state.thumbnailVersions.has(cacheKey)) {
        state.thumbnailVersions.set(cacheKey, Symbol("dashboard-thumbnail-disconnected"));
      }
    });
    dashboardThumbnailKeys = new Set();
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
    const canvas = await renderSlideCanvas(slide, undefined, undefined, project);
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
      toast(error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "The image couldn’t be downloaded.");
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
      toast(error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Couldn’t open the share menu for all slides.");
    } finally {
      shareButtons.forEach((button) => { button.disabled = false; });
      if (shareButton) shareButton.innerHTML = oldLabel;
    }
  }

  return {
    scheduleThumbnailRefresh,
    refreshAllProjectCovers,
    clearProjectCover,
    refreshAllSlideThumbnails,
    refreshDashboardSlideThumbnails,
    disconnectDashboardSlideThumbnails,
    clearSlideThumbnail,
    pruneSlideThumbnails,
    exportActiveSlide,
    shareActiveSlide,
    shareAllSlides,
  };
}
