import { File, Paths, Directory } from 'expo-file-system';
import type { Project } from './types';
const directory = () => {
  const d = new Directory(Paths.document, 'carousel-drafts');
  if (!d.exists) d.create();
  return d;
};
export function saveDraft(userId: string, project: Project, baseRevision: number) {
  const file = new File(directory(), `${userId}-${project.id}.json`);
  if (!file.exists) file.create();
  file.write(JSON.stringify({ project, baseRevision }));
}
export async function loadDraft(
  userId: string,
  projectId: string,
): Promise<{ project: Project; baseRevision: number } | null> {
  const file = new File(directory(), `${userId}-${projectId}.json`);
  if (!file.exists) return null;
  try {
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}
export function clearDraft(userId: string, projectId: string) {
  const file = new File(directory(), `${userId}-${projectId}.json`);
  if (file.exists) file.delete();
}
export function clearAccountDrafts(userId: string) {
  for (const item of directory().list())
    if (item instanceof File && item.name.startsWith(`${userId}-`)) item.delete();
}
