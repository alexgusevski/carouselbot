import { safeFilename } from "./editor-model.mjs";
import {
  state,
  app,
  activeProject,
  activeSlide,
} from "./editor-state.mjs";
import { renderSlideThumbnail } from "./editor-view.mjs";
import { canvasToBlob, renderSlideCanvas } from "./slide-renderer.mjs";

export function createEditorOutput({ toast }) {
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
        currentTarget.removeAttribute("title");
        currentTarget.classList.remove("is-rendering");
      }
    } catch (error) {
      console.error("Could not render project cover", error);
      clearProjectCover(project.id);
      const currentTarget = app.querySelector(`[data-project-cover-id="${project.id}"]`);
      if (currentTarget) {
        currentTarget.classList.remove("is-rendering");
        currentTarget.title = error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Preview unavailable";
        if (slide.imageData) {
          const image = document.createElement("img");
          image.src = slide.imageData;
          image.alt = "";
          currentTarget.replaceChildren(image);
        } else currentTarget.innerHTML = `<span class="project-preview-empty">Preview unavailable</span>`;
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
      slide.backgroundRevision || "",
      slide.imageScale || 1,
      slide.imageX || 0,
      slide.imageY || 0,
      slide.texts || [],
      slide.overlays || [],
      fonts,
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
        currentTarget.removeAttribute("title");
        currentTarget.classList.remove("is-rendering");
      }
    } catch (error) {
      console.error(error);
      clearSlideThumbnail(slide.id);
      const currentTarget = app.querySelector(`[data-thumbnail-slide-id="${slide.id}"]`);
      if (currentTarget) {
        currentTarget.classList.remove("is-rendering");
        currentTarget.title = error.code === "FONT_UNAVAILABLE" ? error.message.replace(/^\[FONT_UNAVAILABLE\]\s*/, "") : "Preview unavailable";
        currentTarget.innerHTML = renderSlideThumbnail(slide);
      }
    }
  }

  function refreshAllSlideThumbnails(slides) {
    slides.forEach((slide) => refreshSlideThumbnail(slide));
  }

  function clearSlideThumbnail(slideId) {
    const thumbnailUrl = state.thumbnailUrls.get(slideId);
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    state.thumbnailUrls.delete(slideId);
    state.thumbnailSignatures.delete(slideId);
    state.thumbnailVersions.delete(slideId);
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
    clearSlideThumbnail,
    exportActiveSlide,
    shareActiveSlide,
    shareAllSlides,
  };
}
