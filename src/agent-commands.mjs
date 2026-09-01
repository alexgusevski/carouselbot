import {
  DESIGN_WIDTH,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  DEFAULT_OUTLINE_WIDTH,
  TEXT_LINE_HEIGHT,
  BOX_TEXT_LINE_HEIGHT,
  BOX_LINE_HEIGHT,
  BOX_HORIZONTAL_PADDING,
  TEXT_BOX_EDGE_PADDING,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_MAX,
  uid,
  projectPath,
  normalizeFolderPath,
  normalizeHexColor,
  textColor,
  ensureBoxedTextContrast,
  layerKey,
  overlayCrop,
  textAlignment,
  initialOverlayWidth,
  slideItems,
  nextLayerZ,
  clamp,
  wrapText,
  safeFilename,
} from "./editor-model.mjs";
import {
  state,
  history,
  app,
  activeProject,
  selectedLayerKeys,
  setLayerSelection,
  selectOnlyLayer,
  projectAsset,
  constrainOverlay,
  constrainImagePosition,
} from "./editor-state.mjs";
import {
  getProjectFromDb,
  staleProjectError,
  putProject,
  deleteProjectFromDb,
} from "./project-store.mjs";
import { measureCanvas } from "./editor-view.mjs";
import { getImageDimensions, renderSlideCanvas, fingerprintData } from "./slide-renderer.mjs";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_WEIGHT,
  applyProjectFontToText,
  createProjectFont,
  ensureProjectFontsLoaded,
  projectFontForText,
  publicProjectFont,
  textCanvasFont,
  textFontVariationCss,
} from "./project-fonts.mjs";
import { reconcileAgentFontWeightPatch } from "./agent-font-patch.mjs";
import {
  recordHistory,
  undo,
  redo,
  updateBrowserRoute,
  reloadProjectFromDb,
  flushPendingSave,
  clearLayerSelection,
  toast,
  renderDashboard,
  clearProjectCover,
  renderEditor,
  bindGlobalActions,
  clearSlideThumbnail,
  fileToDataUrl,
} from "./editor.mjs";

const CAROUSELBOT_AGENT_PROTOCOL = 3;
const AGENT_TEXT_ROLE_SIZES = { title: 104, subtitle: 76, body: 60, caption: 48 };
const AGENT_TEXT_VERTICAL_SAFETY_PADDING = 0.36;

function agentTextRole(value, requestedRole) {
  if (Object.hasOwn(AGENT_TEXT_ROLE_SIZES, requestedRole)) return requestedRole;
  const length = String(value || "").replace(/\s+/g, " ").trim().length;
  if (length <= 48) return "title";
  if (length <= 110) return "subtitle";
  return "body";
}

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
    folderPath: project.folderPath || null,
    revision: Number(project.revision) || 0,
    slideCount: project.slides.length,
    assetCount: (project.assets || []).length,
    fontCount: (project.fonts || []).length,
    updatedAt: project.updatedAt,
  };
}

function agentFolderSummaries() {
  const folders = new Map();
  for (const project of state.projects) {
    if (!project.folderPath) continue;
    const folder = folders.get(project.folderPath) || {
      path: project.folderPath,
      projectIds: [],
      projectCount: 0,
      updatedAt: 0,
    };
    folder.projectIds.push(project.id);
    folder.projectCount += 1;
    folder.updatedAt = Math.max(folder.updatedAt, Number(project.updatedAt) || 0);
    folders.set(project.folderPath, folder);
  }
  return [...folders.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
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
    protocolVersion: CAROUSELBOT_AGENT_PROTOCOL,
    activeProjectId: state.activeProjectId,
    activeSlideId: state.activeSlideId,
    activeFolderPath: state.activeFolderPath,
    view: { canvasZoom: state.canvasZoom, showTikTokOverlay: state.showTikTokOverlay },
    ...(includeAllProjects ? { projects: state.projects.map(agentProjectSummary), folders: agentFolderSummaries() } : {}),
    project: project ? {
      ...agentProjectSummary(project),
      slides: project.slides.map(agentSlideSummary),
      assets: (project.assets || []).map(({ id, name, width, height }) => ({ id, name, width, height })),
      fonts: (project.fonts || []).map((font) => publicProjectFont(project, font)),
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
  if (document.visibilityState !== "visible") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 250);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

async function agentMedia(mediaId) {
  if (!mediaId) return null;
  const media = await window.carouselBotLocalMcpBridge.fetchMedia(mediaId);
  const imageData = await fileToDataUrl(media.file);
  const dimensions = await getImageDimensions(imageData);
  return { imageData, ...dimensions, name: media.name };
}

async function agentMarkFontsUsed(project, textLayers) {
  const bridge = window.carouselBotLocalMcpBridge;
  if (!bridge?.markFontUsed) return;
  const localFontIds = [...new Set(textLayers.flatMap((text) => {
    const font = projectFontForText(project, text);
    return font?.localFontId ? [font.localFontId] : [];
  }))];
  await Promise.all(localFontIds.map((localFontId) => bridge.markFontUsed(localFontId).catch((error) => {
    console.warn(`Could not update recent font usage for ${localFontId}:`, error);
  })));
}

async function agentCommit(project, slide, mutate, message) {
  const stored = await getProjectFromDb(project.id);
  const baseRevision = Number(project.revision) || 0;
  const storedRevision = Number(stored?.revision) || 0;
  if (stored && (storedRevision !== baseRevision || Number(stored.updatedAt) > Number(project.updatedAt))) {
    await reloadProjectFromDb(project.id);
    throw staleProjectError(project.id, baseRevision, storedRevision);
  }
  const visibleView = {
    projectId: state.activeProjectId,
    slideId: state.activeSlideId,
    layerKeys: selectedLayerKeys(),
    photoAdjustMode: state.photoAdjustMode,
    croppingOverlayId: state.croppingOverlayId,
  };
  const targetIsVisible = visibleView.projectId === project.id;
  if (targetIsVisible) agentSelect(project, slide);
  recordHistory(project);
  const result = await mutate();
  if (!targetIsVisible) {
    state.activeProjectId = visibleView.projectId;
    state.activeSlideId = visibleView.slideId;
    setLayerSelection(visibleView.layerKeys);
    state.photoAdjustMode = visibleView.photoAdjustMode;
    state.croppingOverlayId = visibleView.croppingOverlayId;
  }
  project.updatedAt = Date.now();
  project.revision = baseRevision + 1;
  state.shareAllCache = null;
  if (targetIsVisible) renderEditor();
  else if (!visibleView.projectId) {
    if (state.activeFolderPath && !state.projects.some((item) => item.folderPath === state.activeFolderPath)) {
      state.activeFolderPath = null;
      updateBrowserRoute("/", "replace");
    }
    renderDashboard();
    bindGlobalActions();
  }
  await agentNextFrame();
  try {
    await putProject(project, { expectedRevision: baseRevision });
  } catch (error) {
    if (error.code === "STALE_PROJECT") await reloadProjectFromDb(project.id);
    throw error;
  }
  if (message) toast(message);
  return {
    projectId: project.id,
    slideId: slide?.id || null,
    revision: project.revision,
    visibleProjectId: state.activeProjectId,
    viewChanged: targetIsVisible,
    ...result,
  };
}

function agentFontError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

function agentApplyTextPatch(text, patch = {}, project = null) {
  if (patch.text != null) text.text = String(patch.text).slice(0, 4000);
  if (patch.role != null && Object.hasOwn(AGENT_TEXT_ROLE_SIZES, patch.role)) text.role = patch.role;
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
  if (Object.hasOwn(patch, "fontId")) {
    if (!project) throw new Error("A project is required when changing a text font.");
    applyProjectFontToText(project, text, patch.fontId);
  }
  const projectFont = projectFontForText(project, text);
  if (patch.fontWeight != null) {
    const requestedWeight = clamp(Math.round(Number(patch.fontWeight) || DEFAULT_FONT_WEIGHT), 1, 1000);
    const weightAxis = projectFont?.variableAxes?.find((axis) => axis.tag === "wght");
    if (projectFont && !weightAxis && requestedWeight !== projectFont.weight) {
      throw agentFontError("FONT_FACE_MISMATCH", `${projectFont.fullName} is weight ${projectFont.weight}. Import and use the exact installed face for weight ${requestedWeight}.`);
    }
    text.fontWeight = weightAxis ? clamp(requestedWeight, weightAxis.min, weightAxis.max) : requestedWeight;
  }
  if (patch.fontStyle != null) {
    const requestedStyle = patch.fontStyle === "italic" ? "italic" : "normal";
    const exactStyle = projectFont?.italic ? "italic" : "normal";
    if (projectFont && requestedStyle !== exactStyle) {
      throw agentFontError("FONT_FACE_MISMATCH", `${projectFont.fullName} is ${exactStyle}. Import and use the exact installed ${requestedStyle} face.`);
    }
    text.fontStyle = requestedStyle;
  }
  if (patch.fontVariationSettings != null) {
    const axes = new Map((projectFont?.variableAxes || []).map((axis) => [axis.tag, axis]));
    if (projectFont) {
      const unsupported = Object.keys(patch.fontVariationSettings).find((tag) => !axes.has(tag));
      if (unsupported) throw agentFontError("FONT_AXIS_UNSUPPORTED", `${projectFont.fullName} does not expose the ${unsupported} axis.`);
    }
    text.fontVariationSettings = Object.fromEntries(Object.entries(patch.fontVariationSettings)
      .filter(([tag, value]) => /^[A-Za-z0-9]{4}$/.test(tag) && Number.isFinite(Number(value)))
      .map(([tag, value]) => {
        const axis = axes.get(tag);
        const numeric = tag === "wght" ? Math.round(Number(value)) : Number(value);
        return [tag, axis ? clamp(numeric, axis.min, axis.max) : tag === "wght" ? clamp(numeric, 1, 1000) : numeric];
      }));
  }
  reconcileAgentFontWeightPatch(text, patch);
  if (patch.rotation != null) text.rotation = ((Number(patch.rotation) || 0) % 360 + 360) % 360;
  if (patch.z != null) text.z = Number(patch.z) || text.z;
  ensureBoxedTextContrast(text);
  return text;
}

function agentFitTextBox(text, mode = "both", project = agentProject()) {
  const context = measureCanvas.getContext("2d");
  const fontSize = text.size;
  context.font = textCanvasFont(project, text, fontSize);
  if ("fontVariationSettings" in context) context.fontVariationSettings = textFontVariationCss(project, text);
  const perLineBox = text.style === "boxed" && (text.backgroundShape || "lines") !== "full";
  const fullBox = text.style === "boxed" && text.backgroundShape === "full";
  const horizontalInset = perLineBox
    ? fontSize * (TEXT_BOX_EDGE_PADDING * 2 + BOX_HORIZONTAL_PADDING * 2)
    : fullBox ? fontSize * 0.76 : fontSize * 0.32;
  const currentWidth = text.width * DESIGN_WIDTH;
  const longestParagraph = Math.max(...String(text.text || " ").split("\n").map((line) => context.measureText(line || " ").width));
  const fittedWidth = mode === "height"
    ? currentWidth
    : Math.min(currentWidth, Math.max(DESIGN_WIDTH * 0.12, longestParagraph + horizontalInset));
  const lines = wrapText(context, text.text, Math.max(1, fittedWidth - horizontalInset));
  const lineHeight = fontSize * (perLineBox ? BOX_TEXT_LINE_HEIGHT : TEXT_LINE_HEIGHT);
  const contentHeight = perLineBox
    ? Math.max(fontSize * BOX_LINE_HEIGHT, (lines.length - 1) * lineHeight + fontSize * BOX_LINE_HEIGHT) + fontSize * AGENT_TEXT_VERTICAL_SAFETY_PADDING
    : lines.length * lineHeight + fontSize * (fullBox ? 0.76 : 0.28);
  const fittedHeight = Math.max(OUTPUT_HEIGHT * 0.045, contentHeight);
  const previous = { x: text.x, y: text.y, width: text.width, height: text.height };
  const horizontalAnchor = textAlignment(text);
  const right = text.x + text.width;
  const centerX = text.x + text.width / 2;
  const centerY = text.y + text.height / 2;
  text.width = clamp(fittedWidth / DESIGN_WIDTH, 0.1, 1.5);
  text.height = clamp(fittedHeight / OUTPUT_HEIGHT, 0.045, 1.5);
  if (mode !== "height") {
    if (horizontalAnchor === "right") text.x = right - text.width;
    else if (horizontalAnchor === "center") text.x = centerX - text.width / 2;
  }
  text.y = centerY - text.height / 2;
  return {
    id: text.id,
    previous,
    fitted: { x: text.x, y: text.y, width: text.width, height: text.height },
    lineCount: lines.length,
  };
}

function agentAutoFitTextBox(text, project = agentProject()) {
  text.width = clamp(text.width, 0.1, 1);
  text.x = clamp(text.x, 0, 1 - text.width);
  const requestedTop = text.y;
  const result = agentFitTextBox(text, "height", project);
  if (text.height > 1) {
    throw new Error(`Text requires ${result.lineCount} lines and cannot fit on one slide at this width and font size. Shorten it, widen it, reduce it within the role range, or split it across slides.`);
  }
  text.y = clamp(requestedTop, 0, 1 - text.height);
  result.fitted = { x: text.x, y: text.y, width: text.width, height: text.height };
  result.automatic = true;
  return result;
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

async function agentRender(project, slide, { width = 540, format = "png", quality = 0.9 } = {}) {
  const safeWidth = Math.round(clamp(Number(width) || 540, 180, OUTPUT_WIDTH));
  const safeHeight = Math.round(safeWidth * OUTPUT_HEIGHT / OUTPUT_WIDTH);
  const canvas = await renderSlideCanvas(slide, safeWidth, safeHeight, project);
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

async function executeCarouselBotAgentOperation(operation) {
  if (!operation || typeof operation.type !== "string") throw new Error("Operation type is required.");

  // Agent reads and mutations reload their target from IndexedDB. Flush a
  // visible project's debounced UI edit first so that reload cannot replace it
  // with the previous stored revision.
  if (operation.projectId) await flushPendingSave();

  if (operation.type === "editor.inspect") {
    if (operation.projectId) await reloadProjectFromDb(operation.projectId, { render: false });
    const project = state.projects.find((item) => item.id === (operation.projectId || state.activeProjectId));
    if (project) await ensureProjectFontsLoaded(project).catch(() => {});
    return agentInspect(operation);
  }
  if (operation.type === "ui.notify") {
    window.carouselBotLocalMcpBridge?.notify(operation.message, operation.tone);
    return { shown: true, message: String(operation.message) };
  }

  if (operation.type !== "project.create" && operation.projectId) await reloadProjectFromDb(operation.projectId, { render: false });

  if (operation.expectedRevision != null && operation.type !== "project.create") {
    const project = agentProject(operation.projectId);
    const actual = Number(project.revision) || 0;
    if (actual !== Number(operation.expectedRevision)) throw new Error(`Project revision changed: expected ${operation.expectedRevision}, current ${actual}. Inspect the editor and retry with current IDs and state.`);
  }

  if (operation.type === "project.create") {
    const dashboardVisible = !state.activeProjectId && Boolean(app.querySelector(".dashboard"));
    const now = Date.now();
    const folderPath = normalizeFolderPath(operation.folderPath);
    if (operation.folderPath != null && String(operation.folderPath).trim() && !folderPath) {
      throw new Error("Folder paths need a name after the slash and cannot be /. or /..");
    }
    const project = {
      id: uid(), name: String(operation.name || "New Project").slice(0, 160), createdAt: now,
      folderPath, updatedAt: now, revision: 1, slides: [], assets: [], fonts: [],
    };
    state.projects.push(project);
    await putProject(project);
    if (dashboardVisible || !state.activeProjectId) {
      renderDashboard();
      bindGlobalActions();
    }
    await agentNextFrame();
    toast("AI agent created a project");
    return { projectId: project.id, name: project.name, folderPath: project.folderPath, revision: project.revision, opened: false, visibleProjectId: state.activeProjectId };
  }

  if (operation.type === "project.move") {
    const project = agentProject(operation.projectId);
    const slide = project.slides.find((item) => item.id === state.activeSlideId) || project.slides[0] || null;
    const folderPath = normalizeFolderPath(operation.folderPath);
    if (operation.folderPath != null && String(operation.folderPath).trim() && !folderPath) {
      throw new Error("Folder paths need a name after the slash and cannot be /. or /..");
    }
    const result = await agentCommit(project, slide, () => {
      project.folderPath = folderPath;
      return { folderPath };
    }, folderPath ? `AI agent moved the project to ${folderPath}` : "AI agent moved the project to the home screen");
    if (state.activeFolderPath && !state.projects.some((item) => item.folderPath === state.activeFolderPath)) {
      state.activeFolderPath = null;
    }
    return result;
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
    const targetIsVisible = state.activeProjectId === project.id;
    const expectedRevision = Number(project.revision) || 0;
    await deleteProjectFromDb(project.id, { expectedRevision });
    state.projects = state.projects.filter((item) => item.id !== project.id);
    project.slides.forEach((slide) => clearSlideThumbnail(slide.id, project.id));
    clearProjectCover(project.id);
    if (state.activeFolderPath && !state.projects.some((item) => item.folderPath === state.activeFolderPath)) {
      state.activeFolderPath = null;
      updateBrowserRoute("/", "replace");
    }
    if (targetIsVisible) {
      state.activeFolderPath = null;
      state.activeProjectId = null;
      state.activeSlideId = null;
      clearLayerSelection();
      updateBrowserRoute("/", "push");
      renderDashboard();
      bindGlobalActions();
    } else if (!state.activeProjectId) {
      renderDashboard();
      bindGlobalActions();
    }
    toast("AI agent deleted a project");
    return { deletedProjectId: project.id, visibleProjectId: state.activeProjectId, viewChanged: targetIsVisible };
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
      clearSlideThumbnail(slide.id, project.id);
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
      clearSlideThumbnail(slide.id, project.id);
      state.activeSlideId = project.slides[index]?.id || project.slides[index - 1]?.id || null;
      return { deletedSlideId: slide.id };
    }, "AI agent deleted a slide");
  }

  if (operation.type === "font.list") {
    const project = agentProject(operation.projectId);
    await ensureProjectFontsLoaded(project).catch(() => {});
    return {
      projectId: project.id,
      revision: Number(project.revision) || 0,
      fonts: (project.fonts || []).map((font) => publicProjectFont(project, font)),
    };
  }

  if (operation.type === "font.import") {
    const project = agentProject(operation.projectId);
    const current = project.slides.find((item) => item.id === state.activeSlideId) || project.slides[0] || null;
    const existing = (project.fonts || []).find((font) => font.localFontId === operation.localFontId);
    if (existing) {
      try {
        await ensureProjectFontsLoaded(project, [{ fontId: existing.id }]);
        return {
          projectId: project.id,
          fontId: existing.id,
          localFontId: existing.localFontId,
          family: existing.family,
          subfamily: existing.subfamily,
          weight: existing.weight,
          italic: existing.italic,
          revision: Number(project.revision) || 0,
          existing: true,
          repaired: false,
        };
      } catch (error) {
        if (error?.code !== "FONT_UNAVAILABLE") throw error;
      }
    }
    if (!operation.fontMediaId || !operation.font?.localFontId) throw new Error("The local font transfer is incomplete. List the font again and retry import_font.");
    if (operation.font.localFontId !== operation.localFontId) throw new Error("The selected local font no longer matches the prepared transfer. List fonts and retry.");
    const transfer = await window.carouselBotLocalMcpBridge.fetchFontMedia(operation.fontMediaId);
    const source = transfer?.file instanceof Blob
      ? transfer.file
      : transfer instanceof Blob
        ? transfer
        : new Blob([transfer?.arrayBuffer || transfer?.buffer || transfer], { type: transfer?.mimeType || "font/otf" });
    const fontData = await fileToDataUrl(source);
    const font = createProjectFont(operation.font, fontData, existing
      ? { id: existing.id, addedAt: existing.addedAt }
      : undefined);
    const candidateFonts = existing
      ? (project.fonts || []).map((item) => item.id === existing.id ? font : item)
      : [...(project.fonts || []), font];
    const candidate = { ...project, fonts: candidateFonts };
    await ensureProjectFontsLoaded(candidate, [{ fontId: font.id }]);
    return agentCommit(project, current, () => {
      project.fonts ||= [];
      if (existing) project.fonts.splice(project.fonts.findIndex((item) => item.id === existing.id), 1, font);
      else project.fonts.push(font);
      return {
        fontId: font.id,
        localFontId: font.localFontId,
        family: font.family,
        subfamily: font.subfamily,
        weight: font.weight,
        italic: font.italic,
        existing: Boolean(existing),
        repaired: Boolean(existing),
      };
    }, existing ? "AI agent repaired a local font" : "AI agent added a local font");
  }

  if (operation.type === "text.add") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    const role = agentTextRole(operation.text, operation.role);
    const text = agentApplyTextPatch({
      id: uid(), text: "Your text", x: 0.12, y: 0.4, width: 0.76, height: 0.12,
      role, size: AGENT_TEXT_ROLE_SIZES[role], style: "plain", outlineWidth: DEFAULT_OUTLINE_WIDTH, color: "#FFFFFF",
      fontFamily: DEFAULT_FONT_FAMILY, fontWeight: DEFAULT_FONT_WEIGHT, fontStyle: "normal",
      background: "black", backgroundShape: "lines", align: "center", rotation: 0,
      z: nextLayerZ(slide),
    }, operation, project);
    await ensureProjectFontsLoaded(project, [text]);
    const fittedTextBox = agentAutoFitTextBox(text, project);
    const result = await agentCommit(project, slide, () => {
      slide.texts.push(text);
      selectOnlyLayer("text", text.id);
      return { createdTextId: text.id, fittedTextBox };
    }, "AI agent added text");
    if (operation.fontId) await agentMarkFontsUsed(project, [text]);
    return result;
  }

  if (operation.type === "text.update") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    const candidates = operation.updates.map(({ id, ...patch }) => {
      const text = slide.texts.find((item) => item.id === id);
      if (!text) throw new Error(`Text layer not found: ${id}`);
      return {
        text,
        next: agentApplyTextPatch({ ...text }, patch, project),
        appliesFont: Object.hasOwn(patch, "fontId") && Boolean(patch.fontId),
      };
    });
    await ensureProjectFontsLoaded(project, candidates.map(({ next }) => next));
    const result = await agentCommit(project, slide, () => {
      const fittedTextBoxes = candidates.map(({ text, next }) => {
        const fitted = agentAutoFitTextBox(next, project);
        Object.assign(text, next);
        return fitted;
      });
      const updated = fittedTextBoxes.map(({ id }) => id);
      if (updated.length === 1) selectOnlyLayer("text", updated[0]);
      return { updatedTextIds: updated, fittedTextBoxes };
    }, "AI agent updated text");
    await agentMarkFontsUsed(project, candidates.filter(({ appliesFont }) => appliesFont).map(({ next }) => next));
    return result;
  }

  if (operation.type === "text.fit") {
    const project = agentProject(operation.projectId);
    const slide = agentSlide(project, operation.slideId);
    const textLayers = operation.textIds.map((id) => {
      const text = slide.texts.find((item) => item.id === id);
      if (!text) throw new Error(`Text layer not found: ${id}`);
      return text;
    });
    await ensureProjectFontsLoaded(project, textLayers);
    return agentCommit(project, slide, () => ({
      fittedTextBoxes: operation.textIds.map((id) => {
        const text = slide.texts.find((item) => item.id === id);
        if (!text) throw new Error(`Text layer not found: ${id}`);
        return agentFitTextBox(text, operation.mode, project);
      }),
    }), "AI agent fitted text boxes to their content");
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
        const asset = (project.assets || []).find((item) => item.id === image.assetId);
        agentApplyImagePatch(image, patch, asset);
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
    await (operation.type === "history.undo" ? undo() : redo());
    await agentNextFrame();
    const updated = activeProject();
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
    return agentRender(project, slide, operation);
  }

  throw new Error(`Unsupported agent operation: ${operation.type}`);
}

export function installAgentGlobals() {
  const agent = {
    protocolVersion: CAROUSELBOT_AGENT_PROTOCOL,
    execute: executeCarouselBotAgentOperation,
    inspect: agentInspect,
  };
  window.carouselBotAgent = agent;
  window.slideStudioAgent = agent;
  return agent;
}
