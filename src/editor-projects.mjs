import {
  DEFAULT_OUTLINE_WIDTH,
  HISTORY_LIMIT,
  cloneProject,
  uid,
  projectPath,
  folderRoutePath,
  routeFromPathname,
  escapeHtml,
  normalizeAspectRatio,
  normalizeFolderPath,
  normalizeHexColor,
  slideCanvasDimensions,
  textColor,
  overlayCrop,
  clamp,
  isEditingTextTarget,
} from "./editor-model.mjs";
import {
  state,
  history,
  app,
  activeProject,
  selectedLayerKeys,
  setLayerSelection,
} from "./editor-state.mjs";
import { icon } from "./editor-view.mjs";
import {
  STORE_NAME,
  PROJECT_SYNC_STORAGE_KEY,
  projectChannel,
  projectChannelSource,
  getAllProjects,
  getProjectFromDb,
  announceProjectChange,
  putProject,
  deleteProjectFromDb,
  moveProjectsFromFolderInDb,
} from "./project-store.mjs";
import { normalizeProjectFonts, ensureProjectFontsLoaded } from "./project-fonts.mjs";
import { canonicalSolidBackgroundColor } from "./slide-background.mjs";

export function normalizeLoadedProjects(projects) {
  projects.forEach((project) => {
    normalizeProjectFonts(project);
    if (!Number.isFinite(Number(project.revision))) project.revision = 0;
    project.aspectRatio = normalizeAspectRatio(project.aspectRatio);
    project.folderPath = normalizeFolderPath(project.folderPath);
    if (!Array.isArray(project.assets)) project.assets = [];
    if (!Array.isArray(project.slides)) project.slides = [];
    project.slides.forEach((slide) => {
      slide.aspectRatio = normalizeAspectRatio(slide.aspectRatio, project.aspectRatio);
      const canvas = slideCanvasDimensions(project, slide);
      if (slide.imageScale == null) slide.imageScale = 1;
      if (slide.imageX == null) slide.imageX = 0;
      if (slide.imageY == null) slide.imageY = 0;
      if (slide.backgroundColor != null) {
        const backgroundColor = canonicalSolidBackgroundColor(slide, project);
        if (backgroundColor) slide.backgroundColor = backgroundColor;
        else delete slide.backgroundColor;
      }
      if (!Array.isArray(slide.overlays)) slide.overlays = [];
      slide.overlays.forEach((overlay, index) => {
        const asset = project.assets.find((item) => item.id === overlay.assetId);
        if (overlay.height == null && asset) {
          const crop = overlayCrop(overlay);
          overlay.height = overlay.width * (canvas.width / canvas.height) * ((asset.height * crop.h) / (asset.width * crop.w));
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
  return projects;
}

export function createEditorProjects({
  domainMigration,
  renderDashboard,
  renderEditor,
  clearLayerSelection,
  toast,
  scheduleThumbnailRefresh,
  clearProjectCover,
  clearSlideThumbnail,
  pruneSlideThumbnails,
}) {
  let migrationModalDismissed = false;
  let dashboardRefreshPromise = null;
  let dashboardPreviewResizeObserver = null;
  let dashboardPreviewResizeHandler = null;
  let pendingSaveProject = null;
  let saveInFlight = null;
  const dirtySaveProjects = new Map();

  function projectsInFolder(folderPath) {
    return state.projects.filter((project) => project.folderPath === folderPath);
  }

  function folderExists(folderPath) {
    return Boolean(folderPath && projectsInFolder(folderPath).length);
  }

  function clearProjectHistory(projectIds) {
    const ids = new Set(projectIds);
    history.past = history.past.filter((snapshot) => !ids.has(snapshot.id));
    history.future = history.future.filter((snapshot) => !ids.has(snapshot.id));
  }

  function replaceMovedProjects(movedProjects) {
    const byId = new Map(normalizeLoadedProjects(movedProjects).map((project) => [project.id, project]));
    state.projects = state.projects.map((project) => byId.get(project.id) || project);
    clearProjectHistory(byId.keys());
  }

  function leaveMissingActiveFolder({ notify = false } = {}) {
    if (!state.activeFolderPath || folderExists(state.activeFolderPath)) return false;
    state.activeFolderPath = null;
    updateBrowserRoute("/", "replace");
    if (notify) toast("That folder is empty now, so it was removed.");
    return true;
  }

  function recordHistory(project = activeProject()) {
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
    normalizeLoadedProjects([state.projects[index]]);
    state.activeProjectId = snapshot.id;
    if (!state.projects[index].slides.some((slide) => slide.id === state.activeSlideId)) {
      state.activeSlideId = state.projects[index].slides[0]?.id || null;
    }
    setLayerSelection(selectedLayerKeys());
    state.croppingOverlayId = null;
    await ensureProjectFontsLoaded(state.projects[index]).catch(() => {});
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

  function undo() {
    if (isEditingTextTarget(document.activeElement)) return;
    const project = activeProject();
    if (!project) return;
    const snapshot = takeProjectHistorySnapshot(history.past, project.id);
    if (!snapshot) return;
    history.future.push(cloneProject(project));
    return applyHistorySnapshot(snapshot);
  }

  function redo() {
    if (isEditingTextTarget(document.activeElement)) return;
    const project = activeProject();
    if (!project) return;
    const snapshot = takeProjectHistorySnapshot(history.future, project.id);
    if (!snapshot) return;
    history.past.push(cloneProject(project));
    return applyHistorySnapshot(snapshot);
  }

  function updateBrowserRoute(path, historyMode) {
    if (historyMode === "none" || window.location.pathname === path) return;
    window.history[historyMode === "replace" ? "replaceState" : "pushState"]({}, "", `${path}${window.location.search}${window.location.hash}`);
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
        if (outcome !== "skipped") {
          normalizeLoadedProjects([incoming]);
          store.put(incoming);
        }
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

  async function reloadProjectFromDb(projectId, { render = true } = {}) {
    const latest = await getProjectFromDb(projectId);
    if (pendingSaveProject?.id === projectId) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
      pendingSaveProject = null;
    }
    dirtySaveProjects.delete(projectId);
    if (latest) normalizeLoadedProjects([latest]);
    const index = state.projects.findIndex((project) => project.id === projectId);
    const previous = index >= 0 ? state.projects[index] : null;
    if (!latest) {
      previous?.slides.forEach((slide) => clearSlideThumbnail(slide.id, projectId));
      if (index >= 0) state.projects.splice(index, 1);
      clearProjectCover(projectId);
      if (state.activeProjectId === projectId) {
        state.activeFolderPath = null;
        state.activeProjectId = null;
        state.activeSlideId = null;
        updateBrowserRoute("/", "replace");
      }
    } else if (index >= 0) {
      const latestSlideIds = new Set(latest.slides.map((slide) => slide.id));
      previous.slides.filter((slide) => !latestSlideIds.has(slide.id)).forEach((slide) => clearSlideThumbnail(slide.id, projectId));
      state.projects[index] = latest;
      if (state.activeProjectId === projectId && !latest.slides.some((slide) => slide.id === state.activeSlideId)) state.activeSlideId = latest.slides[0]?.id || null;
    } else state.projects.push(latest);
    if (!state.activeProjectId) leaveMissingActiveFolder();
    if (render) {
      if (!state.activeProjectId) renderDashboard();
      else if (state.activeProjectId === projectId) {
        await ensureProjectFontsLoaded(latest).catch(() => {});
        renderEditor();
      }
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

  async function persistScheduledProject(project) {
    const baseRevision = Number(project.revision) || 0;
    try {
      project.revision = baseRevision + 1;
      await putProject(project, { expectedRevision: baseRevision });
      if (dirtySaveProjects.get(project.id)?.project === project) dirtySaveProjects.delete(project.id);
    } catch (error) {
      // A failed transaction did not advance the stored revision. Keep the
      // in-memory edit retryable and let explicit folder/agent operations abort
      // instead of continuing from an older database record.
      project.revision = baseRevision;
      console.error(error);
      if (error.code === "STALE_PROJECT") {
        dirtySaveProjects.delete(project.id);
        await reloadProjectFromDb(project.id);
        toast("This project changed in another tab. Reloaded the latest version.");
      } else {
        dirtySaveProjects.set(project.id, { project, error });
        toast("Couldn’t save this project in your browser.");
      }
      throw error;
    }
  }

  function startScheduledSave(project) {
    const previousSave = saveInFlight;
    const request = (previousSave || Promise.resolve())
      .catch(() => {})
      .then(() => persistScheduledProject(project));
    saveInFlight = request;
    const clearSave = () => {
      if (saveInFlight === request) saveInFlight = null;
    };
    request.then(clearSave, clearSave);
    return request;
  }

  async function flushPendingSave() {
    const requests = saveInFlight ? [saveInFlight] : [];
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const projects = new Map([...dirtySaveProjects].map(([projectId, entry]) => [projectId, entry.project]));
    if (pendingSaveProject) projects.set(pendingSaveProject.id, pendingSaveProject);
    pendingSaveProject = null;
    projects.forEach((project) => requests.push(startScheduledSave(project)));
    const results = await Promise.allSettled(requests);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    if (dirtySaveProjects.size) throw dirtySaveProjects.values().next().value.error;
  }

  function scheduleSave() {
    const project = activeProject();
    if (!project) return;
    project.updatedAt = Date.now();
    scheduleThumbnailRefresh();
    state.shareAllCache = null;
    pendingSaveProject = project;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      const scheduledProject = pendingSaveProject;
      pendingSaveProject = null;
      if (scheduledProject) startScheduledSave(scheduledProject);
    }, 180);
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

  function enableLayerMenuKeyboard(menu, trigger) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    menu.addEventListener("keydown", (event) => {
      const index = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeLayerMenu();
        trigger?.focus({ preventScroll: true });
        return;
      }
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : event.key === "ArrowUp"
              ? (index - 1 + items.length) % items.length
              : null;
      if (nextIndex == null) return;
      event.preventDefault();
      items[nextIndex]?.focus();
    });
    items[0]?.focus({ preventScroll: true });
  }

  function closeFolderDialog() {
    document.querySelector(".folder-dialog")?.remove();
  }

  async function moveProjectToFolder(projectId, requestedFolderPath) {
    await flushPendingSave();
    const index = state.projects.findIndex((project) => project.id === projectId);
    if (index < 0) throw new Error(`Project not found: ${projectId}`);
    const project = state.projects[index];
    const folderPath = normalizeFolderPath(requestedFolderPath);
    if (requestedFolderPath != null && String(requestedFolderPath).trim() && !folderPath) {
      throw new Error("Folder paths need a name after the slash and cannot be /. or /..");
    }
    if (project.folderPath === folderPath) return project;
    const baseRevision = Number(project.revision) || 0;
    const updated = {
      ...project,
      folderPath,
      revision: baseRevision + 1,
      updatedAt: Date.now(),
    };
    try {
      await putProject(updated, { expectedRevision: baseRevision });
      state.projects[index] = updated;
      clearProjectHistory([projectId]);
      leaveMissingActiveFolder();
      renderDashboard();
      toast(folderPath ? `Moved to ${folderPath}` : "Moved to all projects");
      return updated;
    } catch (error) {
      if (error.code === "STALE_PROJECT") await reloadProjectFromDb(projectId);
      throw error;
    }
  }

  async function moveFolderProjects(sourceFolderPath, requestedDestinationFolderPath) {
    const destinationFolderPath = normalizeFolderPath(requestedDestinationFolderPath);
    if (requestedDestinationFolderPath != null && String(requestedDestinationFolderPath).trim() && !destinationFolderPath) {
      throw new Error("Folder paths need a name after the slash and cannot be /. or /..");
    }
    if (sourceFolderPath === destinationFolderPath) return [];
    // A project can reach the dashboard before its debounced editor save fires.
    // Persist that edit before the folder transaction reads and rewrites records.
    await flushPendingSave();
    const moved = await moveProjectsFromFolderInDb(sourceFolderPath, destinationFolderPath);
    replaceMovedProjects(moved);
    if (state.activeFolderPath === sourceFolderPath) {
      state.activeFolderPath = destinationFolderPath;
      updateBrowserRoute(destinationFolderPath ? folderRoutePath(destinationFolderPath) : "/", "replace");
    }
    leaveMissingActiveFolder();
    renderDashboard();
    return moved;
  }

  function showProjectMoveDialog(projectId, returnFocus = null) {
    closeFolderDialog();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    const folderPaths = [...new Set(state.projects.map((item) => item.folderPath).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop folder-dialog";
    backdrop.innerHTML = `
      <form class="modal" data-folder-move-form role="dialog" aria-modal="true" aria-labelledby="folder-move-title" aria-describedby="folder-move-description">
        <h2 id="folder-move-title">Move project</h2>
        <p id="folder-move-description">Enter a folder path such as <strong>/my-folder</strong>. Leave it empty to show the project on the home screen.</p>
        <input name="folderPath" value="${escapeHtml(project.folderPath || "")}" placeholder="/my-folder" maxlength="160" list="folder-path-options" autocomplete="off" aria-label="Folder path" />
        <datalist id="folder-path-options">
          ${folderPaths.map((folderPath) => `<option value="${escapeHtml(folderPath)}"></option>`).join("")}
        </datalist>
        <p class="folder-path-hint">A new path creates the folder automatically.</p>
        <div class="modal-actions">
          <button class="button button--quiet" type="button" data-action="cancel-folder-dialog">Cancel</button>
          <button class="button button--primary" type="submit">Move project</button>
        </div>
      </form>
    `;
    const form = backdrop.querySelector("[data-folder-move-form]");
    const input = form.elements.folderPath;
    const cancelButton = backdrop.querySelector('[data-action="cancel-folder-dialog"]');
    const close = () => {
      closeFolderDialog();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    cancelButton.addEventListener("click", close);
    backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop) close(); });
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    input.addEventListener("input", () => input.setCustomValidity(""));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const folderPath = normalizeFolderPath(input.value);
      if (input.value.trim() && !folderPath) {
        input.setCustomValidity("Enter a folder name after the slash. /. and /.. are not folder names.");
        input.reportValidity();
        return;
      }
      const submitButton = form.querySelector('[type="submit"]');
      cancelButton.disabled = true;
      submitButton.disabled = true;
      submitButton.textContent = "Moving…";
      try {
        await moveProjectToFolder(projectId, folderPath);
        close();
      } catch (error) {
        console.error(error);
        cancelButton.disabled = false;
        submitButton.disabled = false;
        submitButton.textContent = "Move project";
        toast("Couldn’t move this project in your browser.");
      }
    });
    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  }

  function showFolderRenameDialog(sourceFolderPath, returnFocus = null) {
    closeFolderDialog();
    if (!folderExists(sourceFolderPath)) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop folder-dialog";
    backdrop.innerHTML = `
      <form class="modal" data-folder-rename-form role="dialog" aria-modal="true" aria-labelledby="folder-rename-title" aria-describedby="folder-rename-description">
        <h2 id="folder-rename-title">Rename folder</h2>
        <p id="folder-rename-description">Changing the path moves every project in <strong>${escapeHtml(sourceFolderPath)}</strong> together.</p>
        <input name="folderPath" value="${escapeHtml(sourceFolderPath)}" placeholder="/my-folder" maxlength="160" autocomplete="off" aria-label="Folder path" required />
        <p class="folder-path-hint">Using an existing path merges the two folders.</p>
        <div class="modal-actions">
          <button class="button button--quiet" type="button" data-action="cancel-folder-dialog">Cancel</button>
          <button class="button button--primary" type="submit">Rename folder</button>
        </div>
      </form>
    `;
    const form = backdrop.querySelector("[data-folder-rename-form]");
    const input = form.elements.folderPath;
    const cancelButton = backdrop.querySelector('[data-action="cancel-folder-dialog"]');
    const close = () => {
      closeFolderDialog();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    cancelButton.addEventListener("click", close);
    backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop) close(); });
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    input.addEventListener("input", () => input.setCustomValidity(""));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const folderPath = normalizeFolderPath(input.value);
      if (!folderPath) {
        input.setCustomValidity("Enter a folder name after the slash. /. and /.. are not folder names.");
        input.reportValidity();
        return;
      }
      input.setCustomValidity("");
      const submitButton = form.querySelector('[type="submit"]');
      cancelButton.disabled = true;
      submitButton.disabled = true;
      submitButton.textContent = "Renaming…";
      try {
        const moved = await moveFolderProjects(sourceFolderPath, folderPath);
        close();
        toast(`Moved ${moved.length} ${moved.length === 1 ? "project" : "projects"} to ${folderPath}`);
      } catch (error) {
        console.error(error);
        cancelButton.disabled = false;
        submitButton.disabled = false;
        submitButton.textContent = "Rename folder";
        toast("Couldn’t rename this folder in your browser.");
      }
    });
    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  }

  function showFolderUnfileConfirmation(folderPath, returnFocus = null) {
    closeFolderDialog();
    const projectCount = projectsInFolder(folderPath).length;
    if (!projectCount) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop folder-dialog";
    backdrop.innerHTML = `
      <section class="modal modal--confirm" role="alertdialog" aria-modal="true" aria-labelledby="unfile-folder-title" aria-describedby="unfile-folder-description">
        <h2 id="unfile-folder-title">Move projects out?</h2>
        <p id="unfile-folder-description">${projectCount} ${projectCount === 1 ? "project" : "projects"} will return to the home screen. No projects or slides will be deleted.</p>
        <div class="modal-actions">
          <button class="button button--quiet" type="button" data-action="cancel-folder-dialog">Cancel</button>
          <button class="button button--primary" type="button" data-action="confirm-folder-unfile">Move projects out</button>
        </div>
      </section>
    `;
    const cancelButton = backdrop.querySelector('[data-action="cancel-folder-dialog"]');
    const confirmButton = backdrop.querySelector('[data-action="confirm-folder-unfile"]');
    const close = () => {
      closeFolderDialog();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    cancelButton.addEventListener("click", close);
    backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop) close(); });
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    confirmButton.addEventListener("click", async () => {
      cancelButton.disabled = true;
      confirmButton.disabled = true;
      confirmButton.textContent = "Moving…";
      try {
        const moved = await moveFolderProjects(folderPath, null);
        close();
        toast(`Moved ${moved.length} ${moved.length === 1 ? "project" : "projects"} to the home screen`);
      } catch (error) {
        console.error(error);
        cancelButton.disabled = false;
        confirmButton.disabled = false;
        confirmButton.textContent = "Move projects out";
        toast("Couldn’t move these projects in your browser.");
      }
    });
    document.body.appendChild(backdrop);
    cancelButton.focus();
  }

  function showProjectMenu(event, projectId) {
    event.preventDefault();
    event.stopPropagation();
    closeLayerMenu();

    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    const trigger = event.currentTarget;

    const menu = document.createElement("div");
    menu.className = "layer-menu layer-menu--confirm";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Actions for ${project.name}`);

    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.className = "layer-menu-item";
    moveButton.setAttribute("role", "menuitem");
    moveButton.setAttribute("aria-label", `Move ${project.name} to a folder`);
    moveButton.innerHTML = `${icon("move")}<span>Move to folder…</span>`;
    moveButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      closeLayerMenu();
      showProjectMoveDialog(projectId, trigger);
    });
    menu.appendChild(moveButton);

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

    const triggerRect = trigger.getBoundingClientRect();
    const clientX = event.clientX || triggerRect.left + triggerRect.width / 2;
    const clientY = event.clientY || triggerRect.top + triggerRect.height / 2;
    positionLayerMenu(menu, clientX, clientY);
    enableLayerMenuKeyboard(menu, trigger);
  }

  function showFolderMenu(event, folderPath) {
    event.preventDefault();
    event.stopPropagation();
    closeLayerMenu();
    if (!folderExists(folderPath)) return;
    const trigger = event.currentTarget;

    const menu = document.createElement("div");
    menu.className = "layer-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Actions for ${folderPath}`);

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "layer-menu-item";
    renameButton.setAttribute("role", "menuitem");
    renameButton.innerHTML = `${icon("edit")}<span>Rename folder…</span>`;
    renameButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      closeLayerMenu();
      showFolderRenameDialog(folderPath, trigger);
    });
    menu.appendChild(renameButton);

    const unfileButton = document.createElement("button");
    unfileButton.type = "button";
    unfileButton.className = "layer-menu-item";
    unfileButton.setAttribute("role", "menuitem");
    unfileButton.innerHTML = `${icon("back")}<span>Move projects out…</span>`;
    unfileButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      closeLayerMenu();
      showFolderUnfileConfirmation(folderPath, trigger);
    });
    menu.appendChild(unfileButton);
    document.body.appendChild(menu);

    const triggerRect = trigger.getBoundingClientRect();
    const clientX = event.clientX || triggerRect.left + triggerRect.width / 2;
    const clientY = event.clientY || triggerRect.top + triggerRect.height / 2;
    positionLayerMenu(menu, clientX, clientY);
    enableLayerMenuKeyboard(menu, trigger);
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
        await flushPendingSave();
        await deleteProjectFromDb(projectId, { expectedRevision: Number(project.revision) || 0 });
        project.slides.forEach((slide) => clearSlideThumbnail(slide.id, project.id));
        clearProjectCover(projectId);
        state.slideRailScrollPositions.delete(projectId);
        state.projects = state.projects.filter((item) => item.id !== projectId);
        leaveMissingActiveFolder();
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

  function openFolder(requestedFolderPath, { historyMode = "push" } = {}) {
    const folderPath = normalizeFolderPath(requestedFolderPath);
    if (!folderExists(folderPath)) return false;
    updateBrowserRoute(folderRoutePath(folderPath), historyMode);
    state.activeFolderPath = folderPath;
    state.activeProjectId = null;
    state.activeSlideId = null;
    clearLayerSelection();
    state.photoAdjustMode = false;
    renderDashboard();
    return true;
  }

  function openDashboard({ historyMode = "push" } = {}) {
    state.activeFolderPath = null;
    updateBrowserRoute("/", historyMode);
    renderDashboard();
  }

  function renderCurrentRoute() {
    const route = routeFromPathname();
    if (route.view === "project" && openProject(route.projectId, { historyMode: "none" })) return;
    if (route.view === "folder" && openFolder(route.folderPath, { historyMode: "none" })) return;
    const missingProject = route.view === "project";
    const missingFolder = route.view === "folder";
    state.activeFolderPath = null;
    updateBrowserRoute("/", "replace");
    renderDashboard();
    if (missingProject) toast("This project isn’t available in this browser.");
    else if (missingFolder) toast("This folder isn’t available in this browser.");
  }

  function createProject({ aspectRatio } = {}) {
    const now = Date.now();
    const project = {
      id: uid(),
      name: "New Project",
      aspectRatio: normalizeAspectRatio(aspectRatio),
      folderPath: state.activeFolderPath,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      slides: [],
      assets: [],
      fonts: [],
    };
    state.projects.push(project);
    openProject(project.id);
    putProject(project).catch((error) => {
      console.error(error);
      toast("Couldn’t save this project in your browser.");
    });
  }

  function clearDashboardPreviewResizeTracking() {
    dashboardPreviewResizeObserver?.disconnect();
    dashboardPreviewResizeObserver = null;
    if (dashboardPreviewResizeHandler) window.removeEventListener("resize", dashboardPreviewResizeHandler);
    dashboardPreviewResizeHandler = null;
  }

  function bindDashboardEvents() {
    bindGlobalActions();
    clearDashboardPreviewResizeTracking();

    const previewStrips = [...app.querySelectorAll("[data-project-preview-strip]")];
    const syncPreviewControls = (strip) => {
      const shell = strip.closest(".project-card-shell");
      if (!shell) return;
      const maxScrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
      const edgeTolerance = 2;
      const previous = shell.querySelector('[data-project-preview-direction="previous"]');
      const next = shell.querySelector('[data-project-preview-direction="next"]');
      const focusedControl = document.activeElement === previous || document.activeElement === next
        ? document.activeElement
        : null;
      if (previous) previous.hidden = maxScrollLeft <= edgeTolerance || strip.scrollLeft <= edgeTolerance;
      if (next) next.hidden = maxScrollLeft <= edgeTolerance || strip.scrollLeft >= maxScrollLeft - edgeTolerance;
      if (focusedControl?.hidden) {
        const fallback = focusedControl === previous ? next : previous;
        (fallback && !fallback.hidden ? fallback : shell.querySelector(".project-card"))?.focus({ preventScroll: true });
      }
    };
    previewStrips.forEach((strip) => {
      strip.scrollLeft = 0;
      strip.addEventListener("scroll", () => syncPreviewControls(strip), { passive: true });
      syncPreviewControls(strip);
    });
    app.querySelectorAll("[data-project-preview-direction]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const strip = button.closest(".project-card-shell")?.querySelector("[data-project-preview-strip]");
        if (!strip) return;
        const direction = button.dataset.projectPreviewDirection === "previous" ? -1 : 1;
        const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        strip.scrollBy({ left: direction * Math.max(80, strip.clientWidth - 32), behavior });
      });
    });
    if (typeof ResizeObserver === "function") {
      dashboardPreviewResizeObserver = new ResizeObserver((entries) => {
        entries.forEach((entry) => syncPreviewControls(entry.target));
      });
      previewStrips.forEach((strip) => dashboardPreviewResizeObserver.observe(strip));
    } else {
      dashboardPreviewResizeHandler = () => previewStrips.forEach(syncPreviewControls);
      window.addEventListener("resize", dashboardPreviewResizeHandler, { passive: true });
    }

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
    app.querySelector('[data-action="open-dashboard-root"]')?.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openDashboard();
    });
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
    app.querySelectorAll("[data-folder-path]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openFolder(link.dataset.folderPath);
      });
      link.addEventListener("contextmenu", (event) => {
        if (event.ctrlKey) {
          event.preventDefault();
          event.stopPropagation();
          window.open(link.href, "_blank", "noopener");
          return;
        }
        showFolderMenu(event, link.dataset.folderPath);
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

  function bindGlobalActions() {
    if (!app.querySelector(".dashboard")) clearDashboardPreviewResizeTracking();
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

  function refreshDashboardProjects() {
    if (!state.db || state.activeProjectId) return Promise.resolve();
    if (dashboardRefreshPromise) return dashboardRefreshPromise;
    dashboardRefreshPromise = flushPendingSave()
      .then(() => getAllProjects())
      .then((projects) => {
        if (state.activeProjectId) return;
        const refreshedProjects = normalizeLoadedProjects(projects);
        pruneSlideThumbnails(refreshedProjects);
        state.projects = refreshedProjects;
        leaveMissingActiveFolder();
        renderDashboard();
      })
      .catch((error) => console.error("Could not refresh dashboard projects", error))
      .finally(() => { dashboardRefreshPromise = null; });
    return dashboardRefreshPromise;
  }

  return {
    domainMigration,
    recordHistory,
    undo,
    redo,
    updateBrowserRoute,
    importMigratedProject,
    reloadProjectFromDb,
    handleExternalProjectEvent,
    scheduleSave,
    flushPendingSave,
    showProjectMenu,
    showFolderMenu,
    closeProjectDeleteConfirmation,
    showProjectDeleteConfirmation,
    openProject,
    openFolder,
    openDashboard,
    renderCurrentRoute,
    createProject,
    bindDashboardEvents,
    migrateLegacyProjects,
    bindGlobalActions,
    refreshDashboardProjects,
    isMigrationModalDismissed: () => migrationModalDismissed,
  };
}
