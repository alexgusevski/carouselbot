import { normalizeFolderPath, movedFolderPath, folderContains } from '../src/editor-model.mjs';
import { fail } from './core.mjs';
import { statement } from './store.mjs';
function validPath(value, optional = false) {
  if (optional && value == null) return null;
  const normalized = normalizeFolderPath(value);
  if (!normalized || String(value).length > 160 || normalized.length > 160) fail(400, 'INVALID_FOLDER', 'Use at most two folder levels and 160 characters.');
  return normalized;
}
export async function folders(env, userId) {
  const result = await statement(env, 'SELECT path,updated_at AS updatedAt FROM folders WHERE user_id=? ORDER BY path', userId).all();
  return result.results;
}
export async function createFolder(env, userId, input) {
  const path = validPath(input.path);
  await statement(env, `INSERT OR IGNORE INTO folders(user_id,path,updated_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM folders WHERE user_id=?)<100`, userId, path, Date.now(), userId).run();
  return folders(env, userId);
}
export async function moveFolder(env, userId, input) {
  const source = validPath(input.sourceFolderPath); const destination = validPath(input.destinationFolderPath, true);
  if (source === destination) return { folders: await folders(env, userId), projects: [] };
  if (destination && folderContains(source, destination)) fail(400, 'INVALID_FOLDER', 'A folder cannot be moved inside itself.');
  const currentFolders = await folders(env, userId);
  const all = await statement(env, 'SELECT document FROM projects WHERE user_id=?', userId).all();
  for (const item of [...currentFolders.map((folder) => folder.path), ...all.results.map((row) => JSON.parse(row.document).folderPath)]) {
    try { movedFolderPath(item, source, destination); } catch { fail(400, 'INVALID_FOLDER', 'Moving this folder would exceed two levels.'); }
  }
  if (destination && currentFolders.some((folder) => folderContains(destination, folder.path) && !folderContains(source, folder.path))) fail(409, 'FOLDER_EXISTS', 'The destination folder already exists.');
  const now = Date.now();
  const condition = "(json_extract(document,'$.folderPath')=? OR substr(json_extract(document,'$.folderPath'),1,?)=?)";
  const prefix = `${source}/`;
  const queries = [statement(env, `UPDATE projects SET revision=revision+1,updated_at=?,document=json_set(document,'$.revision',revision+1,'$.updatedAt',?,'$.folderPath',CASE WHEN ? IS NULL THEN NULL ELSE ? || substr(json_extract(document,'$.folderPath'),?) END) WHERE user_id=? AND ${condition}`, now, now, destination, destination, source.length + 1, userId, source, prefix.length, prefix)];
  if (destination) queries.push(statement(env, "UPDATE folders SET path=? || substr(path,?),updated_at=? WHERE user_id=? AND (path=? OR substr(path,1,?)=?)", destination, source.length + 1, now, userId, source, prefix.length, prefix));
  else queries.push(statement(env, 'DELETE FROM folders WHERE user_id=? AND (path=? OR substr(path,1,?)=?)', userId, source, prefix.length, prefix));
  try { await env.DB.batch(queries); } catch (error) { if (String(error).includes('UNIQUE constraint')) fail(409, 'FOLDER_EXISTS', 'The destination folder already exists.'); throw error; }
  const result = await statement(env, 'SELECT document FROM projects WHERE user_id=?', userId).all();
  return { folders: await folders(env, userId), projects: result.results.map((row) => JSON.parse(row.document)) };
}
