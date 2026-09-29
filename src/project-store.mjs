import { uid, folderContains, movedFolderPath, normalizeStoredFolderPath } from "./editor-model.mjs";
import { projectCatalogEntry } from "./editor-model.mjs";
import { state } from "./editor-state.mjs";

export const DB_VERSION = 3;
export const CATALOG_STORE = "project-catalog";
export const PREVIEW_STORE = "project-previews";

export const STORE_NAME = "projects";

export const PROJECT_CHANNEL_NAME = "carouselbot-projects-v1";

export const PROJECT_SYNC_STORAGE_KEY = "carouselbot:project-change";

export const projectChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(PROJECT_CHANNEL_NAME) : null;

export const projectChannelSource = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function openDatabase(databaseName, { onBlocked = () => {}, beforeVersionChange = async () => {}, onVersionChange = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DB_VERSION);
    // A request queued behind another tab's blocked upgrade receives no blocked event.
    // Surface recovery guidance even when the browser never dispatches that event here.
    const blockedTimer = setTimeout(onBlocked, 1500);
    request.onupgradeneeded = () => {
      clearTimeout(blockedTimer);
      const db = request.result;
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "path" });
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PREVIEW_STORE)) {
        const previews = db.createObjectStore(PREVIEW_STORE, { keyPath: "key" });
        previews.createIndex("projectId", "projectId");
        previews.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(CATALOG_STORE)) {
        const catalog = db.createObjectStore(CATALOG_STORE, { keyPath: "id" });
        // Cursor backfill bounds migration memory to one project, rather than getAll().
        const cursor = request.transaction.objectStore(STORE_NAME).openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          catalog.put(projectCatalogEntry(entry.value));
          entry.continue();
        };
      }
    };
    request.onblocked = () => onBlocked();
    request.onsuccess = () => {
      clearTimeout(blockedTimer);
      const db = request.result;
      db.onversionchange = async () => {
        try {
          await beforeVersionChange();
          db.close();
          onVersionChange();
        } catch (error) {
          // Keep the connection and unsaved edits available if flushing fails.
          console.error("Could not save before updating browser storage", error);
        }
      };
      resolve(db);
    };
    request.onerror = () => { clearTimeout(blockedTimer); reject(request.error); };
  });
}

export async function getAllProjects() {
  state.folders = await getAllFolders();
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getProjectCatalog() {
  state.folders = await getAllFolders();
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(CATALOG_STORE).objectStore(CATALOG_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export function getStoredPreview(key, signature) {
  if (!state.db) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = state.db.transaction(PREVIEW_STORE).objectStore(PREVIEW_STORE).get(key);
    request.onsuccess = () => resolve(request.result?.signature === signature ? request.result.blob : null);
    request.onerror = () => resolve(null);
  });
}

export function storePreview(key, signature, blob, project) {
  if (!state.db) return;
  const tx = state.db.transaction([CATALOG_STORE, PREVIEW_STORE], "readwrite");
  const read = tx.objectStore(CATALOG_STORE).get(project.id);
  read.onsuccess = () => {
    if (read.result && Number(read.result.revision || 0) === Number(project.revision || 0)) {
      const previews = tx.objectStore(PREVIEW_STORE);
      previews.put({ key, signature, blob, projectId: project.id, updatedAt: Date.now() });
      const count = previews.count();
      count.onsuccess = () => {
        let excess = count.result - 128;
        if (excess <= 0) return;
        const oldest = previews.index("updatedAt").openKeyCursor();
        oldest.onsuccess = () => {
          const cursor = oldest.result;
          if (!cursor || excess-- <= 0) return;
          previews.delete(cursor.primaryKey);
          cursor.continue();
        };
      };
    }
  };
  // Previews are disposable. A quota error must never prevent saving originals.
  tx.onerror = (event) => event.preventDefault();
}

export function getAllFolders() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction("folders", "readonly").objectStore("folders").getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export function createFolderInDb(path) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction("folders", "readwrite");
    transaction.objectStore("folders").add({ path, updatedAt: Date.now() });
    transaction.oncomplete = () => {
      announceProjectEvent({ type: "folders.updated", source: projectChannelSource });
      resolve();
    };
    transaction.onabort = () => reject(transaction.error || new Error("Couldn’t create this folder."));
    transaction.onerror = () => {};
  });
}

export function getProjectMetadataFromDb(projectId) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(CATALOG_STORE).objectStore(CATALOG_STORE).get(projectId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export function getProjectFromDb(projectId) {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(projectId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export function staleProjectError(projectId, expectedRevision, actualRevision) {
  const error = new Error(`Project ${projectId} changed in another tab (expected revision ${expectedRevision}, current ${actualRevision}). The latest project was reloaded; inspect it and retry with current IDs.`);
  error.code = "STALE_PROJECT";
  error.expectedRevision = expectedRevision;
  error.actualRevision = actualRevision;
  return error;
}

export function announceProjectEvent(event) {
  projectChannel?.postMessage(event);
  try {
    localStorage.setItem(PROJECT_SYNC_STORAGE_KEY, JSON.stringify({ ...event, nonce: uid() }));
  } catch { /* BroadcastChannel remains the primary same-origin sync path. */ }
}

export function announceProjectChange(type, project) {
  announceProjectEvent({ type, source: projectChannelSource, projectId: project.id, revision: Number(project.revision) || 0, updatedAt: Number(project.updatedAt) || 0 });
}

export function putProject(project, { expectedRevision = null, broadcast = true } = {}) {
  if (project.__catalog) return Promise.reject(new Error("Cannot save an unloaded project."));
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction([STORE_NAME, CATALOG_STORE, PREVIEW_STORE], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let conflict = null;
    const read = store.get(project.id);
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const actualRevision = Number(read.result?.revision) || 0;
      if (expectedRevision != null && actualRevision !== Number(expectedRevision)) {
        conflict = staleProjectError(project.id, Number(expectedRevision), actualRevision);
        transaction.abort();
        return;
      }
      store.put(project);
      transaction.objectStore(CATALOG_STORE).put(projectCatalogEntry(project));
    };
    transaction.oncomplete = () => {
      if (broadcast) announceProjectChange("project.updated", project);
      resolve();
    };
    transaction.onerror = () => { if (!conflict) reject(transaction.error); };
    transaction.onabort = () => reject(conflict || transaction.error || new Error("Project save was aborted."));
  });
}

export function deleteProjectFromDb(projectId, { expectedRevision = null, broadcast = true } = {}) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction([STORE_NAME, CATALOG_STORE, PREVIEW_STORE], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let conflict = null;
    const read = store.get(projectId);
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const actualRevision = Number(read.result?.revision) || 0;
      if (expectedRevision != null && actualRevision !== Number(expectedRevision)) {
        conflict = staleProjectError(projectId, Number(expectedRevision), actualRevision);
        transaction.abort();
        return;
      }
      store.delete(projectId);
      transaction.objectStore(CATALOG_STORE).delete(projectId);
      const previews = transaction.objectStore(PREVIEW_STORE).index("projectId").openCursor(projectId);
      previews.onsuccess = () => {
        const cursor = previews.result;
        if (!cursor) return;
        if (cursor.value.projectId === projectId) cursor.delete();
        cursor.continue();
      };
    };
    transaction.oncomplete = () => {
      if (broadcast) announceProjectEvent({ type: "project.deleted", source: projectChannelSource, projectId });
      resolve();
    };
    transaction.onerror = () => { if (!conflict) reject(transaction.error); };
    transaction.onabort = () => reject(conflict || transaction.error || new Error("Project deletion was aborted."));
  });
}

export function moveProjectsFromFolderInDb(sourceFolderPath, destinationFolderPath = null) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction([STORE_NAME, "folders", CATALOG_STORE], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const moved = [];
    const folders = transaction.objectStore("folders");
    const folderRead = folders.getAll();
    folderRead.onsuccess = () => {
      try {
        for (const folder of folderRead.result) {
          const path = movedFolderPath(folder.path, sourceFolderPath, destinationFolderPath);
          if (!folderContains(sourceFolderPath, folder.path)) continue;
          folders.delete(folder.path);
          if (path) folders.put({ ...folder, path, updatedAt: Date.now() });
        }
      } catch { transaction.abort(); }
    };
    const read = store.openCursor();
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const cursor = read.result;
      if (!cursor) return;
      const project = cursor.value;
      try {
        const path = movedFolderPath(normalizeStoredFolderPath(project.folderPath), sourceFolderPath, destinationFolderPath);
        if (folderContains(sourceFolderPath, normalizeStoredFolderPath(project.folderPath))) {
          const updated = { ...project, folderPath: path, revision: (Number(project.revision) || 0) + 1, updatedAt: Date.now() };
          const catalog = projectCatalogEntry(updated);
          moved.push(catalog);
          cursor.update(updated);
          transaction.objectStore(CATALOG_STORE).put(catalog);
        }
        cursor.continue();
      } catch (error) { reject(error); transaction.abort(); }
    };
    transaction.oncomplete = () => {
      announceProjectEvent({ type: "folders.updated", source: projectChannelSource });
      moved.forEach((project) => announceProjectChange("project.updated", project));
      resolve(moved);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Folder move was aborted."));
  });
}
