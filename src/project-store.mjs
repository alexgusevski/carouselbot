import { uid, folderContains, movedFolderPath, normalizeStoredFolderPath } from "./editor-model.mjs";
import { state } from "./editor-state.mjs";

export const DB_VERSION = 2;

export const STORE_NAME = "projects";

export const PROJECT_CHANNEL_NAME = "carouselbot-projects-v1";

export const PROJECT_SYNC_STORAGE_KEY = "carouselbot:project-change";

export const projectChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel(PROJECT_CHANNEL_NAME) : null;

export const projectChannelSource = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function openDatabase(databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "path" });
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction(STORE_NAME, "readwrite");
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
    const transaction = state.db.transaction(STORE_NAME, "readwrite");
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
    const transaction = state.db.transaction([STORE_NAME, "folders"], "readwrite");
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
    const read = store.getAll();
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const now = Date.now();
      // Validate the entire subtree before issuing any writes.
      try {
        for (const project of read.result || []) movedFolderPath(normalizeStoredFolderPath(project.folderPath), sourceFolderPath, destinationFolderPath);
      } catch (error) {
        reject(error);
        transaction.abort();
        return;
      }
      for (const project of read.result || []) {
        if (!folderContains(sourceFolderPath, normalizeStoredFolderPath(project.folderPath))) continue;
        const updated = {
          ...project,
          folderPath: movedFolderPath(normalizeStoredFolderPath(project.folderPath), sourceFolderPath, destinationFolderPath),
          revision: (Number(project.revision) || 0) + 1,
          updatedAt: now,
        };
        moved.push(updated);
        store.put(updated);
      }
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
