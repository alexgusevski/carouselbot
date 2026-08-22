const SLIDE_STUDIO_AGENT_PROTOCOL = 2;

function agentProject(projectId = state.activeProjectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(projectId ? `Project not found: ${projectId}` : "No project is open.");
  return project;
}

function agentSlide(project, slideId = state.activeSlideId) {
  const slide = project.slides.find((item) => item.id === slideId);
  if (!slide) throw new Error(slideId ? `Slide not found: ${slideId}` : "No slide is open.");
  return slide;
}

function agentSelect(project, slide = null) {
  updateBrowserRoute(projectPath(project.id), "push");
  state.activeProjectId = project.id;
  state.activeSlideId = slide?.id || project.slides[0]?.id || null;
  clearLayerSelection();
  state.photoAdjustMode = false;
}

function agentProjectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    revision: Number(project.revision) || 0,
    slideCount: project.slides.length,
    assetCount: (project.assets || []).length,
    updatedAt: project.updatedAt,
  };
}

function agentSlideSummary(slide, index) {
  return {
    id: slide.id,
    index,
    name: slide.name,
    width: slide.width,
    height: slide.height,
    imageScale: slide.imageScale || 1,
    imageX: slide.imageX || 0,
    imageY: slide.imageY || 0,
    textCount: slide.texts.length,
    imageCount: (slide.overlays || []).length,
  };
}

function agentInspect({ projectId, slideId, includeAllProjects = true } = {}) {
  const project = state.projects.find((item) => item.id === (projectId || state.activeProjectId)) || null;
  const slide = project?.slides.find((item) => item.id === (slideId || state.activeSlideId)) || null;
  return {
    protocolVersion: SLIDE_STUDIO_AGENT_PROTOCOL,
    activeProjectId: state.activeProjectId,
    activeSlideId: state.activeSlideId,
    view: { canvasZoom: state.canvasZoom, showTikTokOverlay: state.showTikTokOverlay },
    ...(includeAllProjects ? { projects: state.projects.map(agentProjectSummary) } : {}),
    project: project ? {
      ...agentProjectSummary(project),
      slides: project.slides.map(agentSlideSummary),
      assets: (project.assets || []).map(({ id, name, width, height }) => ({ id, name, width, height })),
    } : null,
    slide: slide ? {
      ...agentSlideSummary(slide, project.slides.indexOf(slide)),
      texts: slide.texts.map((text) => ({ ...text })),
      images: (slide.overlays || []).map((overlay) => ({ ...overlay })),
    } : null,
  };
}

function agentSolidBackground(color = "#EEEDE7") {
  const fill = normalizeHexColor(color, "#EEEDE7");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}" viewBox="0 0 ${OUTPUT_WIDTH} ${OUTPUT_HEIGHT}"><rect width="100%" height="100%" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function agentNextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function agentMedia(mediaId) {
  if (!mediaId) return null;
  const media = await window.slideStudioLocalMcpBridge.fetchMedia(mediaId);
  const imageData = await fileToDataUrl(media.file);
  const dimensions = await getImageDimensions(imageData);
  return { imageData, ...dimensions, name: media.name };
}

async function agentCommit(project, slide, mutate, message) {
  agentSelect(project, slide);
  recordHistory();
  const result = await mutate();
  project.updatedAt = Date.now();
  project.revision = (Number(project.revision) || 0) + 1;
  state.shareAllCache = null;
  renderEditor();
  await agentNextFrame();
  await putProject(project);
  if (message) toast(message);
  return {
    projectId: project.id,
    slideId: state.activeSlideId,
    revision: project.revision,
    ...result,
  };
}

function agentApplyTextPatch(text, patch = {}) {
  if (patch.text != null) text.text = String(patch.text).slice(0, 4000);
  if (patch.width != null) text.width = clamp(Number(patch.width), 0.1, 1.5);
  if (patch.height != null) text.height = clamp(Number(patch.height), 0.045, 1.5);
  if (patch.x != null) text.x = clamp(Number(patch.x), -0.5, 1.5);
  if (patch.y != null) text.y = clamp(Number(patch.y), -0.5, 1.5);
  if (patch.size != null) text.size = clamp(Number(patch.size), FONT_SIZE_MIN, FONT_SIZE_MAX);
  if (patch.style != null) text.style = ["plain", "outline", "boxed"].includes(patch.style) ? patch.style : text.style;
  if (patch.outlineWidth != null) text.outlineWidth = clamp(Number(patch.outlineWidth), 0, 40);
  if (patch.color != null) text.color = normalizeHexColor(patch.color, textColor(text));
  if (patch.background != null) text.background = patch.background === "black" ? "black" : "white";
  if (patch.backgroundShape != null) text.backgroundShape = patch.backgroundShape === "full" ? "full" : "lines";
  if (patch.align != null) text.align = ["left", "center", "right"].includes(patch.align) ? patch.align : text.align;
  if (patch.rotation != null) text.rotation = ((Number(patch.rotation) || 0) % 360 + 360) % 360;
  if (patch.z != null) text.z = Number(patch.z) || text.z;
  ensureBoxedTextContrast(text);
  return text;
}

function agentApplyImagePatch(image, patch = {}, asset = projectAsset(image.assetId)) {
  for (const key of ["x", "y", "width", "height", "rotation", "z", "cropX", "cropY", "cropW", "cropH"]) {
    if (patch[key] != null && Number.isFinite(Number(patch[key]))) image[key] = Number(patch[key]);
  }
  constrainOverlay(image, asset);
  const crop = overlayCrop(image);
  Object.assign(image, { cropX: crop.x, cropY: crop.y, cropW: crop.w, cropH: crop.h });
  return image;
}

function agentFindLayer(slide, layerId) {
  const text = slide.texts.find((item) => item.id === layerId);
  if (text) return { kind: "text", item: text };
  const image = (slide.overlays || []).find((item) => item.id === layerId);
  if (image) return { kind: "image", item: image };
  throw new Error(`Layer not found: ${layerId}`);
}

async function agentRender(slide, { width = 540, format = "png", quality = 0.9 } = {}) {
  const safeWidth = Math.round(clamp(Number(width) || 540, 180, OUTPUT_WIDTH));
  const safeHeight = Math.round(safeWidth * OUTPUT_HEIGHT / OUTPUT_WIDTH);
  const canvas = await renderSlideCanvas(slide, safeWidth, safeHeight);
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const dataUrl = canvas.toDataURL(mimeType, clamp(Number(quality) || 0.9, 0.4, 1));
  return {
    mimeType,
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    width: safeWidth,
    height: safeHeight,
    filename: `${safeFilename(slide.name)}.${format === "jpeg" ? "jpg" : "png"}`,
  };
}

async function executeSlideStudioAgentOperation(operation) {
  if (!operation || typeof operation.type !== "string") throw new Error("Operation type is required.");

  if (operation.type === "editor.inspect") return agentInspect(operation);
  if (operation.type === "ui.notify") {
    window.slideStudioLocalMcpBridge?.notify(operation.message, operation.tone);
    return { shown: true, message: String(operation.message) };
  }

  if (operation.expectedRevision != null && operation.type !== "project.create") {
    const project = agentProject(operation.projectId);
    const actual = Number(project.revision) || 0;
    if (actual !== Number(operation.expectedRevision)) throw new Error(`Project revision changed: expected ${operation.expectedRevision}, current ${actual}. Inspect the editor and retry with current IDs and state.`);
  }

  if (operation.type === "project.create") {
    const dashboardVisible = !state.activeProjectId && Boolean(app.querySelector(".dashboard"));
    const now = Date.now();
    const project = {
      id: uid(), name: String(operation.name || "New Project").slice(0, 160), createdAt: now,
      updatedAt: now, revision: 1, slides: [], assets: [],
    };
    state.projects.push(project);
    await putProject(project);
    if (dashboardVisible) {
      renderDashboard();
      bindGlobalActions();
    } else {
      agentSelect(project);
      renderEditor();
    }
    await agentNextFrame();
    toast("AI agent created a project");
    return { projectId: project.id, name: project.name, revision: project.revision, opened: !dashboardVisible };
  }

  if (operation.type === "project.open") {
    const project = agentProject(operation.projectId);
    const slide = operation.slideId ? agentSlide(project, operation.slideId) : project.slides[0] || null;
    agentSelect(project, slide);
    renderEditor();
    await agentNextFrame();
    return agentInspect({ includeAllProjects: false });
  }

  if (operation.type === "project.update") {
    const project = agentProject(operation.projectId);
    return agentCommit(project, project.slides.find((item) => item.id === state.activeSlideId), () => {
      if (operation.name != null) project.name = String(operation.name || "New Project").slice(0, 160);
      return { name: project.name };
    }, "AI agent updated the project");
  }

  if (operation.type === "project.delete") {
    const project = agentProject(operation.projectId);
    state.projects = state.projects.filter((item) => item.id !== project.id);
    await deleteProjectFromDb(project.id);
    if (state.activeProjectId === project.id) {
      state.activeProjectId = null;
      state.activeSlideId = null;
      clearLayerSelection();
    }
    updateBrowserRoute("/", "push");
    renderDashboard();
    bindGlobalActions();
    toast("AI agent deleted a project");
    return { deletedProjectId: project.id };
  }

  if (operation.type === "slide.add") {
    const project = agentProject(operation.projectId);
    const media = await agentMedia(operation.mediaId);
    const slide = {
      id: uid(), name: String(operation.name || `Slide ${project.slides.length + 1}`).slice(0, 160),
      imageData: media?.imageData || agentSolidBackground(operation.backgroundColor),
      width: media?.width || OUTPUT_WIDTH, height: media?.height || OUTPUT_HEIGHT,
      imageScale: 1, imageX: 0, imageY: 0, texts: [], overlays: [],
    };
    const index = operation.index == null ? project.slides.length : clamp(Math.round(operation.index), 0, project.slides.length);
    return agentCommit(project, slide, () => {
      project.slides.splice(index, 0, slide);
      state.activeSlideId = slide.id;
      return { createdSlideId: slide.id, index, name: slide.name };
    }, "AI agent added a slide");
  }

  if (operation.type === "slide.update") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    const media = await agentMedia(operation.mediaId);
    return agentCommit(project, slide, () => {
      if (operation.name != null) slide.name = String(operation.name || "Slide").slice(0, 160);
      if (media) Object.assign(slide, { imageData: media.imageData, width: media.width, height: media.height, backgroundRevision: uid() });
      if (operation.backgroundColor) Object.assign(slide, { imageData: agentSolidBackground(operation.backgroundColor), width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, backgroundRevision: uid() });
      if (operation.imageScale != null) slide.imageScale = clamp(Number(operation.imageScale), 1, 3);
      if (operation.imageX != null) slide.imageX = Number(operation.imageX) || 0;
      if (operation.imageY != null) slide.imageY = Number(operation.imageY) || 0;
      constrainImagePosition(slide);
      clearSlideThumbnail(slide.id);
      return { updatedSlideId: slide.id, name: slide.name };
    }, "AI agent updated the slide");
  }

  if (operation.type === "slide.duplicate") {
    const project = agentProject(operation.projectId);
    const source = agentSlide(project, operation.slideId);
    const copy = { ...source, id: uid(), name: String(operation.name || `${source.name} copy`), texts: source.texts.map((item) => ({ ...item, id: uid() })), overlays: (source.overlays || []).map((item) => ({ ...item, id: uid() })) };
    const sourceIndex = project.slides.indexOf(source);
    return agentCommit(project, copy, () => {
      project.slides.splice(sourceIndex + 1, 0, copy);
      state.activeSlideId = copy.id;
      return { createdSlideId: copy.id, index: sourceIndex + 1 };
    }, "AI agent duplicated the slide");
  }

  if (operation.type === "slide.reorder") {
    const project = agentProject(operation.projectId);
    const current = project.slides.find((item) => item.id === state.activeSlideId) || project.slides[0] || null;
    return agentCommit(project, current, () => {
      const expected = new Set(project.slides.map((item) => item.id));
      if (operation.slideIds.length !== expected.size || operation.slideIds.some((id) => !expected.has(id))) throw new Error("slideIds must contain every slide exactly once.");
      const byId = new Map(project.slides.map((item) => [item.id, item]));
      project.slides = operation.slideIds.map((id) => byId.get(id));
      return { slideIds: project.slides.map((item) => item.id) };
    }, "AI agent reordered the slides");
  }

  if (operation.type === "slide.delete") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    const index = project.slides.indexOf(slide);
    return agentCommit(project, slide, () => {
      project.slides.splice(index, 1);
      clearSlideThumbnail(slide.id);
      state.activeSlideId = project.slides[index]?.id || project.slides[index - 1]?.id || null;
      return { deletedSlideId: slide.id };
    }, "AI agent deleted a slide");
  }

  if (operation.type === "text.add") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    const text = agentApplyTextPatch({
      id: uid(), text: "Your text", x: 0.12, y: 0.4, width: 0.76, height: 0.12,
      size: 64, style: "plain", outlineWidth: DEFAULT_OUTLINE_WIDTH, color: "#FFFFFF",
      background: "black", backgroundShape: "lines", align: "center", rotation: 0,
      z: nextLayerZ(slide),
    }, operation);
    return agentCommit(project, slide, () => {
      slide.texts.push(text);
      selectOnlyLayer("text", text.id);
      return { createdTextId: text.id };
    }, "AI agent added text");
  }

  if (operation.type === "text.update") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    return agentCommit(project, slide, () => {
      const updated = operation.updates.map(({ id, ...patch }) => {
        const text = slide.texts.find((item) => item.id === id);
        if (!text) throw new Error(`Text layer not found: ${id}`);
        agentApplyTextPatch(text, patch);
        return id;
      });
      if (updated.length === 1) selectOnlyLayer("text", updated[0]);
      return { updatedTextIds: updated };
    }, "AI agent updated text");
  }

  if (operation.type === "asset.import") {
    const project = agentProject(operation.projectId);
    const current = project.slides.find((item) => item.id === (operation.slideId || state.activeSlideId)) || project.slides[0] || null;
    const media = await agentMedia(operation.mediaId);
    if (!media) throw new Error("An image path is required.");
    const fingerprint = await fingerprintData(media.imageData);
    const existing = (project.assets || []).find((item) => item.fingerprint === fingerprint);
    if (existing) return { projectId: project.id, assetId: existing.id, existing: true };
    const asset = { id: uid(), name: String(operation.name || media.name || "Image").replace(/\.[^.]+$/, ""), imageData: media.imageData, width: media.width, height: media.height, fingerprint };
    return agentCommit(project, current, () => {
      if (!project.assets) project.assets = [];
      project.assets.push(asset);
      return { assetId: asset.id, width: asset.width, height: asset.height };
    }, "AI agent imported an image");
  }

  if (operation.type === "asset.update") {
    const project = agentProject(operation.projectId);
    const current = project.slides.find((item) => item.id === state.activeSlideId) || project.slides[0] || null;
    return agentCommit(project, current, () => {
      const asset = (project.assets || []).find((item) => item.id === operation.assetId);
      if (!asset) throw new Error(`Asset not found: ${operation.assetId}`);
      if (operation.name != null) asset.name = String(operation.name || "Image").slice(0, 160);
      return { assetId: asset.id, name: asset.name };
    }, "AI agent updated an image asset");
  }

  if (operation.type === "asset.delete") {
    const project = agentProject(operation.projectId);
    const current = project.slides.find((item) => item.id === state.activeSlideId) || project.slides[0] || null;
    return agentCommit(project, current, () => {
      if (!(project.assets || []).some((item) => item.id === operation.assetId)) throw new Error(`Asset not found: ${operation.assetId}`);
      project.assets = project.assets.filter((item) => item.id !== operation.assetId);
      project.slides.forEach((item) => { item.overlays = (item.overlays || []).filter((overlay) => overlay.assetId !== operation.assetId); });
      return { deletedAssetId: operation.assetId };
    }, "AI agent deleted an image asset");
  }

  if (operation.type === "image.add") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    return agentCommit(project, slide, () => {
      const asset = (project.assets || []).find((item) => item.id === operation.assetId);
      if (!asset) throw new Error(`Asset not found: ${operation.assetId}`);
      const image = agentApplyImagePatch({ id: uid(), assetId: asset.id, x: 0.3, y: 0.34, width: initialOverlayWidth(asset), rotation: 0, z: nextLayerZ(slide) }, operation, asset);
      slide.overlays ||= [];
      slide.overlays.push(image);
      selectOnlyLayer("overlay", image.id);
      return { createdImageId: image.id, assetId: asset.id };
    }, "AI agent placed an image");
  }

  if (operation.type === "image.update") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    return agentCommit(project, slide, () => {
      const updated = operation.updates.map(({ id, ...patch }) => {
        const image = (slide.overlays || []).find((item) => item.id === id);
        if (!image) throw new Error(`Image layer not found: ${id}`);
        agentApplyImagePatch(image, patch);
        return id;
      });
      if (updated.length === 1) selectOnlyLayer("overlay", updated[0]);
      return { updatedImageIds: updated };
    }, "AI agent updated an image");
  }

  if (operation.type === "layer.delete") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    return agentCommit(project, slide, () => {
      const ids = new Set(operation.layerIds);
      slide.texts = slide.texts.filter((item) => !ids.has(item.id));
      slide.overlays = (slide.overlays || []).filter((item) => !ids.has(item.id));
      clearLayerSelection();
      return { deletedLayerIds: [...ids] };
    }, "AI agent deleted layers");
  }

  if (operation.type === "layer.duplicate") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    return agentCommit(project, slide, () => {
      const created = [];
      let z = nextLayerZ(slide);
      for (const id of operation.layerIds) {
        const { kind, item } = agentFindLayer(slide, id);
        const copy = { ...item, id: uid(), x: item.x + (operation.offsetX ?? 0.03), y: item.y + (operation.offsetY ?? 0.03), z: z++ };
        if (kind === "text") slide.texts.push(copy); else (slide.overlays ||= []).push(copy);
        created.push({ sourceId: id, id: copy.id, kind });
      }
      setLayerSelection(created.map((item) => layerKey(item.kind === "image" ? "overlay" : "text", item.id)));
      return { createdLayers: created };
    }, "AI agent duplicated layers");
  }

  if (operation.type === "layer.reorder") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    return agentCommit(project, slide, () => {
      const all = slideItems(slide);
      const expected = new Set(all.map(({ item }) => item.id));
      if (operation.layerIds.length !== expected.size || operation.layerIds.some((id) => !expected.has(id))) throw new Error("layerIds must contain every layer exactly once, from back to front.");
      operation.layerIds.forEach((id, index) => { agentFindLayer(slide, id).item.z = index + 1; });
      return { layerIds: operation.layerIds };
    }, "AI agent reordered layers");
  }

  if (operation.type === "history.undo" || operation.type === "history.redo") {
    const project = agentProject(operation.projectId);
    const slide = project.slides.find((item) => item.id === (operation.slideId || state.activeSlideId)) || project.slides[0] || null;
    agentSelect(project, slide);
    document.activeElement?.blur?.();
    operation.type === "history.undo" ? undo() : redo();
    await agentNextFrame();
    const updated = activeProject();
    if (updated) await putProject(updated);
    return { projectId: updated?.id || null, slideId: state.activeSlideId, canUndo: history.past.length > 0, canRedo: history.future.length > 0 };
  }

  if (operation.type === "view.update") {
    const project = operation.projectId ? agentProject(operation.projectId) : activeProject();
    const slide = project && operation.slideId ? agentSlide(project, operation.slideId) : project?.slides.find((item) => item.id === state.activeSlideId) || project?.slides[0] || null;
    if (project) agentSelect(project, slide);
    if (operation.canvasZoom != null) state.canvasZoom = clamp(Number(operation.canvasZoom), CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
    if (operation.showTikTokOverlay != null) state.showTikTokOverlay = Boolean(operation.showTikTokOverlay);
    project ? renderEditor() : renderDashboard();
    await agentNextFrame();
    return { projectId: project?.id || null, slideId: slide?.id || null, canvasZoom: state.canvasZoom, showTikTokOverlay: state.showTikTokOverlay };
  }

  if (operation.type === "slide.render") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    agentSelect(project, slide);
    renderEditor();
    await agentNextFrame();
    return agentRender(slide, operation);
  }

  throw new Error(`Unsupported agent operation: ${operation.type}`);
}

window.slideStudioAgent = {
  protocolVersion: SLIDE_STUDIO_AGENT_PROTOCOL,
  execute: executeSlideStudioAgentOperation,
  inspect: agentInspect,
};
