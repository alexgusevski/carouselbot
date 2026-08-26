(function initializeCarouselBotDomainMigration(global) {
  "use strict";

  const MESSAGE = Object.freeze({
    ready: "carouselbot:migration-ready",
    project: "carouselbot:migration-project",
    projectImported: "carouselbot:migration-project-imported",
    finish: "carouselbot:migration-finish",
    complete: "carouselbot:migration-complete",
    error: "carouselbot:migration-error",
  });
  const PROTOCOL_VERSION = 1;
  const COMPLETED_STORAGE_KEY = "carouselbot:migration-completed";

  function normalizedOrigin(value) {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  }

  function normalizeConfig(config = {}) {
    const canonicalOrigin = normalizedOrigin(config.canonicalOrigin);
    const legacyOrigins = [...new Set((config.legacyOrigins || []).map(normalizedOrigin).filter(Boolean))];
    if (!canonicalOrigin) throw new Error("CarouselBot migration requires a valid canonical origin.");
    if (!legacyOrigins.length) throw new Error("CarouselBot migration requires at least one legacy origin.");
    return Object.freeze({
      canonicalOrigin,
      legacyOrigins: Object.freeze(legacyOrigins),
      enabled: config.migration?.enabled !== false,
      autoForwardEmptyLegacyStorage: config.migration?.autoForwardEmptyLegacyStorage === true,
      transferQueryParameter: config.migration?.transferQueryParameter || "carouselbotMigration",
      sourceQueryParameter: config.migration?.sourceQueryParameter || "from",
      projectTimeoutMs: Number(config.migration?.projectTimeoutMs) || 30_000,
    });
  }

  function validProject(project) {
    return Boolean(
      project
      && typeof project === "object"
      && typeof project.id === "string"
      && project.id.length > 0
      && project.id.length <= 256
      && typeof project.name === "string"
      && Array.isArray(project.slides)
      && Array.isArray(project.assets || []),
    );
  }

  function migrationResult(existing, incoming) {
    if (!validProject(incoming)) return "invalid";
    if (!existing) return "imported";
    const existingUpdatedAt = Number(existing.updatedAt) || 0;
    const incomingUpdatedAt = Number(incoming.updatedAt) || 0;
    const existingRevision = Number(existing.revision) || 0;
    const incomingRevision = Number(incoming.revision) || 0;
    return incomingUpdatedAt > existingUpdatedAt || (incomingUpdatedAt === existingUpdatedAt && incomingRevision > existingRevision)
      ? "updated"
      : "skipped";
  }

  function createController(browser = global, rawConfig = browser.CAROUSELBOT_CONFIG) {
    const config = normalizeConfig(rawConfig);
    const currentOrigin = normalizedOrigin(browser.location?.origin);
    const isLegacyOrigin = config.legacyOrigins.includes(currentOrigin);
    const isCanonicalOrigin = currentOrigin === config.canonicalOrigin;
    const url = new URL(browser.location.href);
    const receiverToken = url.searchParams.get(config.transferQueryParameter);
    const receiverSourceOrigin = normalizedOrigin(url.searchParams.get(config.sourceQueryParameter));
    let importer = null;
    let receiverSummary = { imported: 0, updated: 0, skipped: 0 };
    let activeTransfer = null;

    function post(target, targetOrigin, message) {
      target.postMessage({ protocolVersion: PROTOCOL_VERSION, ...message }, targetOrigin);
    }

    function messageMatches(event, source, origin, token) {
      return event.source === source
        && event.origin === origin
        && event.data?.protocolVersion === PROTOCOL_VERSION
        && event.data?.token === token;
    }

    function transferUrl(token) {
      const target = new URL("/", config.canonicalOrigin);
      target.searchParams.set(config.transferQueryParameter, token);
      target.searchParams.set(config.sourceQueryParameter, currentOrigin);
      return target.href;
    }

    function completedMigration() {
      if (!isLegacyOrigin) return null;
      try {
        return JSON.parse(browser.localStorage.getItem(COMPLETED_STORAGE_KEY) || "null");
      } catch {
        return null;
      }
    }

    function hasPendingProjects(projects) {
      if (!isLegacyOrigin || !projects.length) return false;
      const completed = completedMigration();
      if (!Array.isArray(completed?.projectVersions)) return true;
      const copied = new Map(completed.projectVersions.map((project) => [project.id, project]));
      return projects.some((project) => {
        const previous = copied.get(project.id);
        return !previous
          || Number(project.updatedAt) !== Number(previous.updatedAt)
          || Number(project.revision || 0) !== Number(previous.revision || 0);
      });
    }

    function rememberCompletedMigration(summary) {
      try {
        browser.localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify({ ...summary, completedAt: new Date().toISOString() }));
      } catch { /* A completed transfer remains valid when localStorage is unavailable. */ }
    }

    function clearProjectTimer() {
      if (!activeTransfer?.timer) return;
      browser.clearTimeout(activeTransfer.timer);
      activeTransfer.timer = null;
    }

    function rejectTransfer(error) {
      if (!activeTransfer) return;
      clearProjectTimer();
      const { reject } = activeTransfer;
      activeTransfer = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    function armProjectTimeout() {
      clearProjectTimer();
      activeTransfer.timer = browser.setTimeout(() => rejectTransfer(new Error("The project transfer timed out. Keep both tabs open and try again.")), config.projectTimeoutMs);
    }

    function sendNextProject() {
      if (!activeTransfer) return;
      const { popup, projects, token, index } = activeTransfer;
      if (popup.closed) {
        rejectTransfer(new Error("The CarouselBot tab was closed before the transfer finished."));
        return;
      }
      if (index >= projects.length) {
        post(popup, config.canonicalOrigin, { type: MESSAGE.finish, token, total: projects.length });
        armProjectTimeout();
        return;
      }
      post(popup, config.canonicalOrigin, {
        type: MESSAGE.project,
        token,
        index,
        total: projects.length,
        project: projects[index],
      });
      armProjectTimeout();
    }

    function handleLegacyMessage(event) {
      if (!activeTransfer || !messageMatches(event, activeTransfer.popup, config.canonicalOrigin, activeTransfer.token)) return;
      if (event.data.type === MESSAGE.ready && activeTransfer.index === 0) {
        sendNextProject();
        return;
      }
      if (event.data.type === MESSAGE.projectImported && event.data.index === activeTransfer.index) {
        clearProjectTimer();
        activeTransfer.results.push({ projectId: event.data.projectId, status: event.data.status });
        activeTransfer.index += 1;
        activeTransfer.onProgress?.({ completed: activeTransfer.index, total: activeTransfer.projects.length, projectId: event.data.projectId, status: event.data.status });
        sendNextProject();
        return;
      }
      if (event.data.type === MESSAGE.complete) {
        clearProjectTimer();
        const { resolve, projects, results, popup } = activeTransfer;
        const summary = {
          projectCount: projects.length,
          results,
          destination: config.canonicalOrigin,
          projectVersions: projects.map(({ id, updatedAt, revision }) => ({ id, updatedAt: Number(updatedAt) || 0, revision: Number(revision) || 0 })),
        };
        rememberCompletedMigration(summary);
        activeTransfer = null;
        popup.focus?.();
        resolve(summary);
        return;
      }
      if (event.data.type === MESSAGE.error) rejectTransfer(new Error(event.data.message || "CarouselBot could not import the project."));
    }

    async function handleCanonicalMessage(event) {
      if (!importer || !receiverToken || !receiverSourceOrigin || !config.legacyOrigins.includes(receiverSourceOrigin)) return;
      if (!messageMatches(event, browser.opener, receiverSourceOrigin, receiverToken)) return;
      if (event.data.type === MESSAGE.project) {
        try {
          if (!validProject(event.data.project)) throw new Error("The legacy project data is invalid.");
          const status = await importer(event.data.project);
          if (!Object.hasOwn(receiverSummary, status)) throw new Error(`Unknown import status: ${status}`);
          receiverSummary[status] += 1;
          post(browser.opener, receiverSourceOrigin, {
            type: MESSAGE.projectImported,
            token: receiverToken,
            index: event.data.index,
            projectId: event.data.project.id,
            status,
          });
        } catch (error) {
          post(browser.opener, receiverSourceOrigin, { type: MESSAGE.error, token: receiverToken, message: error.message });
        }
        return;
      }
      if (event.data.type === MESSAGE.finish) {
        post(browser.opener, receiverSourceOrigin, { type: MESSAGE.complete, token: receiverToken, summary: receiverSummary });
        const cleanUrl = new URL(browser.location.href);
        cleanUrl.searchParams.delete(config.transferQueryParameter);
        cleanUrl.searchParams.delete(config.sourceQueryParameter);
        browser.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
        browser.dispatchEvent(new browser.CustomEvent("carouselbot:migration-complete", { detail: receiverSummary }));
      }
    }

    browser.addEventListener("message", isLegacyOrigin ? handleLegacyMessage : handleCanonicalMessage);

    return Object.freeze({
      config,
      isLegacyOrigin,
      isCanonicalOrigin,
      isMigrationReceiver: Boolean(isCanonicalOrigin && receiverToken && config.legacyOrigins.includes(receiverSourceOrigin)),
      completedMigration,
      hasPendingProjects,
      migrationResult,
      registerImporter(callback) {
        if (!this.isMigrationReceiver) return false;
        if (typeof callback !== "function") throw new TypeError("Migration importer must be a function.");
        if (!browser.opener) throw new Error("The legacy editor tab is no longer available. Start the transfer again from the old domain.");
        importer = callback;
        post(browser.opener, receiverSourceOrigin, { type: MESSAGE.ready, token: receiverToken });
        return true;
      },
      start(projects, { onProgress } = {}) {
        if (!config.enabled || !isLegacyOrigin) return Promise.reject(new Error("Project migration is only available on a configured legacy origin."));
        if (activeTransfer) return Promise.reject(new Error("A project migration is already running."));
        const transferable = projects.filter(validProject);
        if (transferable.length !== projects.length) return Promise.reject(new Error("One or more projects cannot be transferred safely."));
        const token = browser.crypto.randomUUID();
        const popup = browser.open(transferUrl(token), `carouselbot-project-migration-${token}`);
        if (!popup) return Promise.reject(new Error("Your browser blocked the CarouselBot tab. Allow pop-ups for this transfer and try again."));
        return new Promise((resolve, reject) => {
          activeTransfer = { token, popup, projects: transferable, index: 0, results: [], onProgress, resolve, reject, timer: null };
          armProjectTimeout();
        });
      },
    });
  }

  const api = Object.freeze({ MESSAGE, PROTOCOL_VERSION, COMPLETED_STORAGE_KEY, normalizeConfig, validProject, migrationResult, createController });
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.CarouselBotDomainMigration = api;
})(typeof window === "object" ? window : globalThis);
