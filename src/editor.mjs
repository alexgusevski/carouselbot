import { isEditingTextTarget } from "./editor-model.mjs";
import { state, app, selectedLayerKeys } from "./editor-state.mjs";
import { openDatabase, getAllProjects } from "./project-store.mjs";
import { createEditorActions } from "./editor-actions.mjs";
import { createEditorOutput } from "./editor-output.mjs";
import { createEditorProjects, normalizeLoadedProjects } from "./editor-projects.mjs";
import { createEditorUI } from "./editor-ui.mjs";

const APP_CONFIG = window.CAROUSELBOT_CONFIG;

export const domainMigration = window.CarouselBotDomainMigration.createController(window, APP_CONFIG);

const DB_NAME = domainMigration.isLegacyOrigin ? "slide-studio-db" : "carouselbot-db";

let editorUI;
let editorActions;

const editorOutput = createEditorOutput({
  toast: (...args) => editorUI.toast(...args),
});

const editorProjects = createEditorProjects({
  domainMigration,
  renderDashboard: (...args) => editorUI.renderDashboard(...args),
  renderEditor: (...args) => editorUI.renderEditor(...args),
  clearLayerSelection: (...args) => editorActions.clearLayerSelection(...args),
  toast: (...args) => editorUI.toast(...args),
  scheduleThumbnailRefresh: editorOutput.scheduleThumbnailRefresh,
  clearProjectCover: editorOutput.clearProjectCover,
  clearSlideThumbnail: editorOutput.clearSlideThumbnail,
});

editorActions = createEditorActions({
  recordHistory: editorProjects.recordHistory,
  scheduleSave: editorProjects.scheduleSave,
  reloadProjectFromDb: editorProjects.reloadProjectFromDb,
  renderEditor: (...args) => editorUI.renderEditor(...args),
  toast: (...args) => editorUI.toast(...args),
  isInlineTextEditing: (...args) => editorUI.isInlineTextEditing(...args),
  clearSlideThumbnail: editorOutput.clearSlideThumbnail,
});

editorUI = createEditorUI({
  projects: editorProjects,
  actions: editorActions,
  output: editorOutput,
});

export const recordHistory = editorProjects.recordHistory;
export const undo = editorProjects.undo;
export const redo = editorProjects.redo;
export const updateBrowserRoute = editorProjects.updateBrowserRoute;
export const reloadProjectFromDb = editorProjects.reloadProjectFromDb;
export const flushPendingSave = editorProjects.flushPendingSave;
export const clearLayerSelection = editorActions.clearLayerSelection;
export const toast = editorUI.toast;
export const renderDashboard = editorUI.renderDashboard;
export const clearProjectCover = editorOutput.clearProjectCover;
export const renderEditor = editorUI.renderEditor;
export const bindGlobalActions = editorProjects.bindGlobalActions;
export const clearSlideThumbnail = editorOutput.clearSlideThumbnail;
export const fileToDataUrl = editorActions.fileToDataUrl;

export async function init() {
  try {
    state.db = await openDatabase(DB_NAME);
    state.projects = await getAllProjects();
    normalizeLoadedProjects(state.projects);
  } catch (error) {
    console.error(error);
    state.projects = [];
    toast("Browser storage is unavailable. Projects won’t persist.");
  }
  window.addEventListener("carouselbot:migration-complete", async (event) => {
    state.projects = normalizeLoadedProjects(await getAllProjects());
    renderDashboard();
    const { imported = 0, updated = 0, skipped = 0 } = event.detail || {};
    toast(`Projects ready: ${imported} copied, ${updated} updated${skipped ? `, ${skipped} already current` : ""}.`);
  });
  try {
    domainMigration.registerImporter(editorProjects.importMigratedProject);
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
  editorProjects.renderCurrentRoute();
  window.addEventListener("popstate", editorProjects.renderCurrentRoute);
  window.addEventListener("pageshow", () => {
    if (!state.activeProjectId) void editorProjects.refreshDashboardProjects();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !state.activeProjectId) void editorProjects.refreshDashboardProjects();
  });
  document.addEventListener("paste", (event) => {
    editorActions.handleClipboardPaste(event);
  });
  document.addEventListener("copy", editorActions.handleLayerCopy);
  document.addEventListener("pointerdown", (event) => {
    const editingBox = editorUI.activeTextEditingBox();
    if (editingBox && event.target.closest(".text-box") !== editingBox) {
      editorUI.endTextEditing(editingBox, { deselect: !event.target.closest(".inspector") });
    }
    const title = document.activeElement;
    if (title?.classList?.contains("project-title-input") && !event.target.closest(".project-title-input")) {
      title.blur();
    }
    if (!event.target.closest(".layer-menu")) editorUI.closeLayerMenu();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      editorUI.closeLayerMenu();
      const editingBox = editorUI.activeTextEditingBox();
      if (editingBox) {
        event.preventDefault();
        editorUI.endTextEditing(editingBox);
        editingBox.focus({ preventScroll: true });
      }
    }
    const slideOffset = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
    }[event.key];
    if (slideOffset
      && !event.defaultPrevented
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !event.shiftKey
      && !isEditingTextTarget(event.target)
      && editorUI.navigateSlides(slideOffset)) {
      event.preventDefault();
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && app.querySelector(".stage")) {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        editorUI.setCanvasZoom(state.canvasZoom * 1.2);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        editorUI.setCanvasZoom(state.canvasZoom / 1.2);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        editorUI.setCanvasZoom(1);
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
        editorActions.deleteSelectedLayers();
      }
    }
  });
}
