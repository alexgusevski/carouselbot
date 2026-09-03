import {
  DEFAULT_OUTLINE_WIDTH,
  CLIPBOARD_LAYER_TYPE,
  LEGACY_CLIPBOARD_LAYER_TYPE,
  CLIPBOARD_STORAGE_KEY,
  LEGACY_CLIPBOARD_STORAGE_KEY,
  uid,
  layerKey,
  overlayCrop,
  initialOverlayWidth,
  initialTextBoxHeight,
  aspectRatioFromDimensions,
  normalizeAspectRatio,
  slideCanvasDimensions,
  remapLayerGeometryBetweenCanvases,
  clampLayerCoordinate,
  slideItems,
  nextLayerZ,
  clamp,
  isEditingTextTarget,
  parseCopiedLayer,
  isImageFile,
} from "./editor-model.mjs";
import {
  state,
  app,
  activeProject,
  activeSlide,
  selectedLayerKeys,
  isLayerSelected,
  setLayerSelection,
  selectOnlyLayer,
  projectAsset,
  getOverlayMetrics,
  constrainOverlay,
  constrainImagePosition,
} from "./editor-state.mjs";
import { putProject } from "./project-store.mjs";
import { getImageDimensions, fingerprintData } from "./slide-renderer.mjs";
import { canonicalSolidBackgroundColor, solidBackgroundDataUrl } from "./slide-background.mjs";
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_WEIGHT } from "./project-fonts.mjs";

export function createEditorActions({
  recordHistory,
  scheduleSave,
  reloadProjectFromDb,
  renderEditor,
  toast,
  isInlineTextEditing,
  clearSlideThumbnail,
}) {
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

  function clearLayerSelection() {
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

  function finishCrop() {
    if (!state.croppingOverlayId) return;
    exitCropMode();
    scheduleSave();
    renderEditor();
  }

  function addText(point = null, { editDirectly = false } = {}) {
    const slide = activeSlide();
    if (!slide) return;
    recordHistory();
    const width = 0.64;
    const height = initialTextBoxHeight(activeProject(), 64, slide);
    const text = {
      id: uid(),
      text: "Your text",
      x: point ? clamp(point.x - width / 2, 0, 1 - width) : 0.18,
      y: point ? clamp(point.y - height / 2, 0, 1 - height) : 0.42,
      width,
      height,
      size: 64,
      fontFamily: DEFAULT_FONT_FAMILY,
      fontWeight: DEFAULT_FONT_WEIGHT,
      fontStyle: "normal",
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
      delete slide.backgroundColor;
      slide.backgroundRevision = uid();
      constrainImagePosition(slide);
      clearSlideThumbnail(slide.id, project.id);
      scheduleSave();
      renderEditor();
      toast("Slide background changed");
    } catch (error) {
      console.error(error);
      toast("That image couldn’t be used as the slide background.");
    }
  }

  function setSlideAspectRatio(slideId, value) {
    const project = activeProject();
    const slide = project?.slides.find((item) => item.id === slideId);
    if (!project || !slide) return false;

    const sourceCanvas = slideCanvasDimensions(project, slide);
    const aspectRatio = normalizeAspectRatio(value, sourceCanvas.aspectRatio);
    if (aspectRatio === sourceCanvas.aspectRatio) return false;
    const solidBackgroundColor = canonicalSolidBackgroundColor(slide, project);
    const targetSlide = { ...slide, aspectRatio };
    const targetCanvas = slideCanvasDimensions(project, targetSlide);

    exitCropMode();
    recordHistory();
    slide.texts = (slide.texts || []).map((text) => (
      remapLayerGeometryBetweenCanvases(text, sourceCanvas, targetCanvas, { maxHeight: 2.4 })
    ));
    slide.overlays = (slide.overlays || []).map((overlay) => {
      const geometry = remapLayerGeometryBetweenCanvases(overlay, sourceCanvas, targetCanvas, { maxHeight: 2.4 });
      const asset = project.assets?.find((item) => item.id === overlay.assetId);
      return constrainOverlay(geometry, asset, { project, slide: targetSlide });
    });
    slide.aspectRatio = aspectRatio;
    if (solidBackgroundColor) {
      slide.imageData = solidBackgroundDataUrl(solidBackgroundColor, project, slide);
      slide.width = targetCanvas.width;
      slide.height = targetCanvas.height;
      slide.backgroundRevision = uid();
    }
    constrainImagePosition(slide, project);
    clearSlideThumbnail(slide.id, project.id);
    state.shareAllCache = null;
    scheduleSave();
    renderEditor();
    toast(`Slide format changed to ${aspectRatio}`);
    return true;
  }

  function removeSlide(slideId) {
    const project = activeProject();
    if (!project) return;
    const index = project.slides.findIndex((item) => item.id === slideId);
    if (index < 0) return;

    recordHistory();
    project.slides.splice(index, 1);
    clearSlideThumbnail(slideId, project.id);

    if (state.activeSlideId === slideId) {
      state.activeSlideId = project.slides[index]?.id || project.slides[index - 1]?.id || null;
      clearLayerSelection();
      state.photoAdjustMode = false;
    }
    scheduleSave();
    renderEditor();
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
      width: initialOverlayWidth(asset, activeProject(), slide),
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
            aspectRatio: aspectRatioFromDimensions(dimensions.width, dimensions.height, project.aspectRatio),
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
    const copied = { token, sourceCanvas: slideCanvasDimensions(activeProject(), activeSlide()), layers: copies };
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
    const targetCanvas = slideCanvasDimensions(project, slide);
    const sourceCanvas = copied.sourceCanvas;
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
        const geometry = remapLayerGeometryBetweenCanvases(layer.item, sourceCanvas, targetCanvas, { maxHeight: 2.4 });
        const pasted = constrainOverlay({
          ...geometry,
          id: uid(),
          assetId: asset.id,
          x: geometry.x + offset,
          y: geometry.y + offset,
          z: nextZ,
        }, asset, { project, slide });
        pasted.x = clampLayerCoordinate(pasted.x, pasted.width);
        pasted.y = clampLayerCoordinate(pasted.y, pasted.height);
        nextZ += 1;
        slide.overlays.push(pasted);
        pastedLayers.push({ kind: "overlay", item: { ...pasted }, asset: { ...asset } });
        pastedKeys.push(layerKey("overlay", pasted.id));
        return;
      }
      const geometry = remapLayerGeometryBetweenCanvases(layer.item, sourceCanvas, targetCanvas, { maxHeight: 2.4 });
      const pasted = {
        ...geometry,
        id: uid(),
        x: clampLayerCoordinate(geometry.x + offset, geometry.width),
        y: clampLayerCoordinate(geometry.y + offset, geometry.height),
        z: nextZ,
      };
      nextZ += 1;
      slide.texts.push(pasted);
      pastedLayers.push({ kind: "text", item: { ...pasted } });
      pastedKeys.push(layerKey("text", pasted.id));
    });
    copied.layers = pastedLayers;
    copied.sourceCanvas = targetCanvas;
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

  return {
    clearLayerSelection,
    moveLayer,
    beginCrop,
    exitCropMode,
    finishCrop,
    addText,
    deleteSelectedText,
    beginSlideBackgroundChange,
    handleSlideBackgroundChange,
    setSlideAspectRatio,
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
    fileToDataUrl,
    handleLayerCopy,
    handleClipboardPaste,
    imageFilesFromTransfer,
  };
}
