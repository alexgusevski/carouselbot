import type { Project } from './types';
const key = (userId: string, projectId: string) => `carousel-draft:${userId}:${projectId}`;
export function saveDraft(userId: string, project: Project, baseRevision: number) {
  localStorage.setItem(key(userId, project.id), JSON.stringify({ project, baseRevision }));
}
export async function loadDraft(
  userId: string,
  projectId: string,
): Promise<{ project: Project; baseRevision: number } | null> {
  try {
    return JSON.parse(localStorage.getItem(key(userId, projectId)) || 'null');
  } catch {
    return null;
  }
}
export function clearDraft(userId: string, projectId: string) {
  localStorage.removeItem(key(userId, projectId));
}
export function clearAccountDrafts(userId: string) {
  for (const entry of Object.keys(localStorage))
    if (entry.startsWith(`carousel-draft:${userId}:`)) localStorage.removeItem(entry);
}
