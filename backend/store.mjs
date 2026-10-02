import { fail, validateProject, identifier, money, dollars, IMAGE_TYPES, MEDIA_TYPES, MAX_ASSET_BYTES, normalizedSubscription } from './core.mjs';
import { revenueCatProduct } from './core.mjs';
export const statement = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);
export async function getProject(env, userId, id) {
  const row = await statement(env, 'SELECT document FROM projects WHERE user_id=? AND id=?', userId, id).first();
  if (!row) fail(404, 'NOT_FOUND', 'Project not found.');
  return JSON.parse(row.document);
}
export async function saveProject(env, userId, id, project, expectedRevision, { jobId = null, undoJobId = null } = {}) {
  validateProject(project, id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(400, 'INVALID_REVISION', 'Expected revision is required.');
  const current = await statement(env, 'SELECT revision FROM projects WHERE user_id=? AND id=?', userId, id).first();
  if ((current?.revision || 0) !== expectedRevision) {
    const latest = current ? await getProject(env, userId, id) : null;
    fail(409, 'STALE_PROJECT', 'Project changed. Reload and retry.', { project: latest, actualRevision: current?.revision || 0 });
  }
  const document = structuredClone(project);
  const assetIds = new Set();
  // Images live in R2 so a project document stays below D1's 2 MB row limit.
  for (const item of [...document.assets, ...document.slides, ...(document.fonts || [])]) for (const field of ['imageData', 'videoData', 'fontData']) {
    if (typeof item[field] !== 'string') continue;
    if (field === 'imageData' && item[field].startsWith('data:image/svg+xml') && item[field].length < 2048) continue;
    const inline = /^data:([a-z0-9.+/-]*);base64,([A-Za-z0-9+/=]+)$/.exec(item[field]);
    if (inline) {
      let decoded;
      try { decoded = Uint8Array.from(atob(inline[2]), character => character.charCodeAt(0)); }
      catch { fail(400, 'INVALID_IMAGE', 'Image data is invalid.'); }
      const mimeType = field === 'fontData' && !MEDIA_TYPES.has(inline[1]) ? 'application/octet-stream' : inline[1];
      const asset = await saveAsset(env, userId, { body: decoded, mimeType, name: item.name || 'Project media', allowMedia: field !== 'imageData' });
      item[field] = asset.url;
    } else if (item[field].startsWith('/api/assets/')) {
      const assetId = identifier(item[field].slice('/api/assets/'.length), 'asset ID');
      if (!await statement(env, 'SELECT id FROM assets WHERE user_id=? AND id=?', userId, assetId).first()) fail(404, 'NOT_FOUND', 'Project image not found.');
    } else if (item[field]) fail(400, 'INVALID_IMAGE', 'Project media must be uploaded or embedded.');
    if (item[field].startsWith('/api/assets/')) assetIds.add(item[field].slice('/api/assets/'.length));
    delete item.cloudImageUrl; delete item.cloudVideoUrl; delete item.cloudFontUrl;
  }
  const saved = { ...document, revision: expectedRevision + 1, updatedAt: Date.now() };
  if (new TextEncoder().encode(JSON.stringify(saved)).length > 1_800_000) fail(413, 'PROJECT_TOO_LARGE', 'Project document is too large.');
  const token = crypto.randomUUID();
  const undoCondition = undoJobId ? ` AND EXISTS(SELECT 1 FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE e.job_id=? AND e.id='undo' AND e.type='undo_snapshot' AND j.user_id=? AND j.project_id=? AND j.status IN ('completed','failed','stopped') AND json_extract(e.data,'$.afterRevision')=? AND COALESCE(json_extract(e.data,'$.used'),0)=0)
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND project_id=? AND status IN ('queued','running'))
    AND (SELECT id FROM jobs WHERE user_id=? AND project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)=?` : '';
  const mutation = current
    ? statement(env, `UPDATE projects SET revision=?,document=?,updated_at=?,save_token=? WHERE user_id=? AND id=? AND revision=?${undoCondition}`, saved.revision, JSON.stringify(saved), saved.updatedAt, token, userId, id, expectedRevision, ...(undoJobId ? [undoJobId, userId, id, expectedRevision, userId, id, userId, id, undoJobId] : []))
    : statement(env, `INSERT OR IGNORE INTO projects(user_id,id,revision,document,updated_at,save_token)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM projects WHERE user_id=?)<100`, userId, id, saved.revision, JSON.stringify(saved), saved.updatedAt, token, userId);
  const queries = [mutation, statement(env, 'DELETE FROM project_assets WHERE user_id=? AND project_id=? AND EXISTS(SELECT 1 FROM projects WHERE user_id=? AND id=? AND save_token=?)', userId, id, userId, id, token)];
  for (const assetId of assetIds) queries.push(statement(env, 'INSERT INTO project_assets(user_id,project_id,asset_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM projects WHERE user_id=? AND id=? AND save_token=?)', userId, id, assetId, userId, id, token));
  if (jobId || undoJobId) queries.push(statement(env, `UPDATE job_events SET data=json_set(data,'$.afterRevision',?${undoJobId ? ",'$.used',json('true')" : ''}) WHERE job_id=? AND id='undo' AND type='undo_snapshot' AND EXISTS(SELECT 1 FROM projects WHERE user_id=? AND id=? AND save_token=?)`, saved.revision, jobId || undoJobId, userId, id, token));
  let results;
  try { results = await env.DB.batch(queries); }
  catch (error) { if (String(error).includes('FOREIGN KEY constraint')) fail(409, 'ASSET_CHANGED', 'A project image changed while saving. Retry your save.'); throw error; }
  if (!results[0].meta.changes) {
    const row = await statement(env, 'SELECT document,revision FROM projects WHERE user_id=? AND id=?', userId, id).first();
    if (!row && expectedRevision === 0) fail(403, 'PROJECT_LIMIT', 'Your account has reached the project limit.');
    fail(409, 'STALE_PROJECT', 'Project changed. Reload and retry.', { project: row ? JSON.parse(row.document) : null, actualRevision: row?.revision ?? 0 });
  }
  return saved;
}
export async function saveAsset(env, userId, { body, mimeType, name = 'Image', allowMedia = false, jobId = null }) {
  if (!(allowMedia ? MEDIA_TYPES : IMAGE_TYPES).has(mimeType)) fail(415, 'INVALID_IMAGE', 'Unsupported media format.');
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) fail(413, 'ASSET_TOO_LARGE', 'Image exceeds 20 MB.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  // Tenant-specific IDs avoid revealing whether another customer's image exists.
  const tenantDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${mimeType}:${hash}`)));
  const id = Array.from(tenantDigest, byte => byte.toString(16).padStart(2, '0')).join(''); const key = `${userId}/${id}/${crypto.randomUUID()}`;
  const cleanName = String(name).slice(0, 200);
  const existing = await statement(env, 'SELECT id,object_key FROM assets WHERE user_id=? AND id=?', userId, id).first();
  if (existing) {
    if (jobId) await statement(env, 'INSERT OR IGNORE INTO job_assets(job_id,user_id,asset_id) VALUES(?,?,?)', jobId, userId, id).run();
    return { id, url: `/api/assets/${id}`, mimeType, name: cleanName };
  }
  // D1 reserves quota before the R2 write; failed writes roll back the reservation.
  const reserved = await statement(env, `INSERT OR IGNORE INTO assets(id,user_id,object_key,name,mime_type,bytes,created_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(bytes),0) FROM assets WHERE user_id=?) + ? <= 262144000`, id, userId, key, cleanName, mimeType, bytes.length, Date.now(), userId, bytes.length).run();
  if (!reserved.meta.changes) {
    if (!await statement(env, 'SELECT id FROM assets WHERE user_id=? AND id=?', userId, id).first()) fail(403, 'STORAGE_LIMIT', 'Image storage limit reached.');
    if (jobId) await statement(env, 'INSERT OR IGNORE INTO job_assets(job_id,user_id,asset_id) VALUES(?,?,?)', jobId, userId, id).run();
    return { id, url: `/api/assets/${id}`, mimeType, name: cleanName };
  }
  try { await env.ASSETS_BUCKET.put(key, bytes, { httpMetadata: { contentType: mimeType } });
    if (jobId) await statement(env, 'INSERT OR IGNORE INTO job_assets(job_id,user_id,asset_id) VALUES(?,?,?)', jobId, userId, id).run();
  }
  catch (error) { await statement(env, 'DELETE FROM assets WHERE id=? AND user_id=? AND object_key=?', id, userId, key).run(); throw error; }
  const persisted = await statement(env, 'SELECT id FROM assets WHERE id=? AND user_id=? AND object_key=?', id, userId, key).first();
  if (!persisted) { await env.ASSETS_BUCKET.delete(key); fail(409, 'ASSET_CHANGED', 'Image changed while uploading. Retry your upload.'); }
  return { id, url: `/api/assets/${id}`, mimeType, name: cleanName };
}
export async function loadAsset(env, userId, id) {
  identifier(id, 'asset ID');
  const asset = await statement(env, 'SELECT * FROM assets WHERE id=? AND user_id=?', id, userId).first();
  if (!asset) fail(404, 'NOT_FOUND', 'Image not found.');
  const object = await env.ASSETS_BUCKET.get(asset.object_key);
  if (!object) fail(404, 'NOT_FOUND', 'Image not found.');
  return { body: new Uint8Array(await object.arrayBuffer()), mimeType: asset.mime_type, name: asset.name };
}
export async function account(env, userId) {
  const now = Date.now();
  const subscription = await statement(env, `SELECT * FROM subscriptions WHERE user_id=? AND ((provider='polar' AND product_id=?) OR (provider='revenuecat' AND product_id=?)) AND status IN ('active','trialing') AND period_start<=? AND period_end>? ORDER BY period_start DESC LIMIT 1`, userId, env.POLAR_PRODUCT_ID || '', revenueCatProduct(env), now, now).first();
  const allowance = subscription ? await statement(env, 'SELECT * FROM allowances WHERE user_id=? AND period_start=?', userId, subscription.period_start).first() : null;
  const remainingUnits = Math.max(0, (allowance?.allowance || 0) - (allowance?.spent || 0) - (allowance?.reserved || 0));
  const remaining = dollars(remainingUnits);
  return { userId, credits: Math.floor(remainingUnits / 10000), canGenerate: Boolean(subscription && remainingUnits >= jobBudget(env) && env.OPENROUTER_API_KEY && env.AGENT_WORKFLOW), billing: { active: Boolean(subscription), remaining, allowance: dollars(allowance?.allowance), periodEnd: subscription?.period_end ?? null, provider: subscription?.provider || null, store: subscription?.store || null }, periodStart: subscription?.period_start, subscriptionId: subscription?.id };
}
export function jobBudget(env) {
  const budget = money(env.JOB_BUDGET_USD || 0.5);
  if (!Number.isSafeInteger(budget) || budget <= 0) fail(503, 'NOT_CONFIGURED', 'Agent budget is not configured.');
  return budget;
}
export async function acceptWebhook(env, eventId, event) {
  const subscription = normalizedSubscription(event, env.POLAR_PRODUCT_ID);
  const statements = [statement(env, 'INSERT OR IGNORE INTO webhooks(id,type,created_at) VALUES(?,?,?)', eventId, event.type, Date.now())];
  if (subscription && !await statement(env, 'SELECT user_id FROM deleted_accounts WHERE user_id=?', subscription.userId).first()) {
    const s = subscription;
    statements.push(statement(env, `INSERT INTO subscriptions(id,user_id,product_id,status,period_start,period_end,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,updated_at=excluded.updated_at WHERE excluded.updated_at>subscriptions.updated_at`, s.id, s.userId, s.productId, s.status, s.periodStart, s.periodEnd, s.updatedAt));
    statements.push(statement(env, `INSERT OR IGNORE INTO allowances(user_id,period_start,period_end,allowance) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND status IN ('active','trialing') AND period_start=?)`, s.userId, s.periodStart, s.periodEnd, money(env.AGENT_ALLOWANCE_USD || 5), s.id, s.periodStart));
  }
  await env.DB.batch(statements);
}
export async function eventsForProject(env, userId, projectId) {
  const result = await statement(env, `SELECT e.* FROM job_events e JOIN jobs j ON j.id=e.job_id WHERE j.user_id=? AND j.project_id=? ORDER BY e.created_at DESC,e.rowid DESC LIMIT 2000`, userId, projectId).all();
  return result.results.reverse().map((event) => ({ ...event, data: JSON.parse(event.data) }));
}
export function displayMessages(events) {
  return events.filter((event) => event.type === 'message' && ['user','assistant'].includes(event.data.message?.role) && typeof event.data.message?.content === 'string' && event.data.message.content).map((event) => ({ id: event.id, createdAt: event.created_at, role: event.data.message.role, content: event.data.message.content }));
}

export async function deleteAsset(env, userId, id, { drain = true } = {}) {
  identifier(id, 'asset ID');
  const asset = await statement(env, 'SELECT * FROM assets WHERE user_id=? AND id=?', userId, id).first();
  if (!asset) return false;
  try {
    const result = await env.DB.batch([
      statement(env, 'INSERT OR IGNORE INTO asset_deletions(object_key,created_at) VALUES(?,?)', asset.object_key, Date.now()),
      statement(env, 'DELETE FROM assets WHERE user_id=? AND id=? AND object_key=?', userId, id, asset.object_key),
    ]);
    if (drain) await drainAssetDeletions(env, userId);
    return Boolean(result[1].meta.changes);
  } catch (error) {
    if (String(error).includes('FOREIGN KEY constraint')) fail(409, 'ASSET_IN_USE', 'This image is still used by a carousel or its chat.');
    throw error;
  }
}
export async function deleteProject(env, userId, id, expectedRevision) {
  const candidates = await statement(env, `SELECT asset_id FROM project_assets WHERE user_id=? AND project_id=? UNION SELECT a.asset_id FROM job_assets a JOIN jobs j ON a.job_id=j.id WHERE j.user_id=? AND j.project_id=? LIMIT 5`, userId, id, userId, id).all();
  const deleted = await statement(env, "DELETE FROM projects WHERE user_id=? AND id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND project_id=? AND status IN ('queued','running'))", userId, id, expectedRevision, userId, id).run();
  if (!deleted.meta.changes) {
    if (await statement(env, "SELECT id FROM jobs WHERE user_id=? AND project_id=? AND status IN ('queued','running')", userId, id).first()) fail(409, 'JOB_ACTIVE', 'Stop the agent before deleting this project.');
    const project = await getProject(env, userId, id); fail(409, 'STALE_PROJECT', 'Project changed. Reload and retry.', { project, actualRevision: project.revision });
  }
  for (const { asset_id: assetId } of candidates.results) {
    try { await deleteAsset(env, userId, assetId, { drain: false }); }
    catch (error) { if (error.code !== 'ASSET_IN_USE') console.error('Could not clean up unused asset', { id: assetId, message: error.message }); }
  }
  await drainAssetDeletions(env, userId);
}

export async function drainAssetDeletions(env, userId = null) {
  const prefix = userId ? `${userId}/` : null;
  const pending = await statement(env, 'SELECT object_key FROM asset_deletions WHERE (? IS NULL OR substr(object_key,1,?)=?) LIMIT 10', prefix, prefix?.length || 0, prefix).all();
  for (const { object_key: key } of pending.results) {
    try {
      // A deduplicated object can have been uploaded again since its deletion was queued.
      if (!await statement(env, 'SELECT id FROM assets WHERE object_key=?', key).first()) await env.ASSETS_BUCKET.delete(key);
      await statement(env, 'DELETE FROM asset_deletions WHERE object_key=?', key).run();
    } catch (error) { console.error('R2 asset cleanup deferred', { message: error.message }); }
  }
}
export async function cleanupUnusedAssets(env, userId = null) {
  const candidates = await statement(env, `SELECT id,user_id FROM assets a WHERE (? IS NULL OR user_id=?) AND created_at<? AND NOT EXISTS(SELECT 1 FROM project_assets p WHERE p.asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM job_assets j WHERE j.asset_id=a.id) LIMIT 5`, userId, userId, Date.now() - 7 * 86400000).all();
  for (const row of candidates.results) try { await deleteAsset(env, row.user_id, row.id, { drain: false }); } catch (error) { if (error.code !== 'ASSET_IN_USE') console.error('Asset cleanup deferred', { message: error.message }); }
  await drainAssetDeletions(env, userId);
}
