export const MAX_PROJECT_BYTES = 12 * 1024 * 1024;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'video/webm', 'font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'application/font-woff', 'application/x-font-ttf', 'application/x-font-opentype', 'application/octet-stream']);
export class ApiError extends Error {
  constructor(status, code, message, details = {}) { super(message); Object.assign(this, { status, code, details }); }
}
export const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
export const money = (usd) => Math.round(Number(usd) * 1_000_000);
export const dollars = (units) => Number(units || 0) / 1_000_000;
export const revenueCatProduct = env => `revenuecat:${env.REVENUECAT_ENTITLEMENT_ID || 'pro'}`;
export function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value)) fail(400, 'INVALID_ID', `Invalid ${label}.`);
  return value;
}
export function validateProject(project, id) {
  if (!project || typeof project !== 'object' || Array.isArray(project) || project.id !== id || !Array.isArray(project.slides) || !Array.isArray(project.assets)) fail(400, 'INVALID_PROJECT', 'A project with slides and assets is required.');
  if (project.slides.length > 100 || project.assets.length > 200 || typeof project.name !== 'string' || project.name.length > 200) fail(400, 'INVALID_PROJECT', 'Project limits exceeded.');
  if (project.fonts != null && (!Array.isArray(project.fonts) || project.fonts.length > 50)) fail(400, 'INVALID_PROJECT', 'Font limits exceeded.');
  for (const slide of project.slides) {
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) fail(400, 'INVALID_PROJECT', 'Invalid slide.');
    for (const key of ['texts', 'overlays']) if (slide[key] != null && (!Array.isArray(slide[key]) || slide[key].length > 200)) fail(400, 'INVALID_PROJECT', 'Layer limits exceeded.');
  }
  const text = JSON.stringify(project);
  if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES) fail(413, 'PROJECT_TOO_LARGE', 'Project exceeds 12 MB.');
  if (text.includes('blob:')) fail(400, 'INVALID_PROJECT', 'Temporary blob URLs cannot be saved.');
  return project;
}
export async function readBody(request, limit = MAX_PROJECT_BYTES) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) fail(413, 'BODY_TOO_LARGE', 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0; const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', 'Request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export async function readJson(request, limit) {
  try { return JSON.parse(new TextDecoder().decode(await readBody(request, limit))); }
  catch (error) { if (error instanceof ApiError) throw error; fail(400, 'INVALID_JSON', 'Invalid JSON.'); }
}
export function normalizedSubscription(event, productId) {
  const data = event.data;
  if (!event.type?.startsWith('subscription.') || data?.product_id !== productId) return null;
  const userId = data.customer?.external_id;
  if (typeof userId !== 'string' || !/^user_[\w-]+$/.test(userId)) return null;
  const periodStart = Date.parse(data.current_period_start);
  const periodEnd = Date.parse(data.current_period_end);
  const updatedAt = Date.parse(data.modified_at || event.timestamp || data.created_at);
  if (![periodStart, periodEnd, updatedAt].every(Number.isFinite) || periodEnd <= periodStart) fail(400, 'INVALID_WEBHOOK', 'Invalid subscription period.');
  return { id: data.id, userId, productId, status: data.status, periodStart, periodEnd, updatedAt };
}
export function publicJob(row) {
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at, budgetUsd: dollars(row.budget), spentUsd: dollars(row.spent) };
}
