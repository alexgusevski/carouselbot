import { fail, money, dollars, publicJob } from './core.mjs';
import { statement, account, jobBudget, getProject, saveProject, eventsForProject } from './store.mjs';
export async function emit(env, jobId, type, data, id = crypto.randomUUID()) {
  if (type === 'project' && data.project) data = { revision: data.project.revision, projectId: data.project.id };
  await statement(env, 'INSERT OR IGNORE INTO job_events(job_id,id,type,data,created_at) VALUES(?,?,?,?,?)', jobId, id, type, JSON.stringify(data), Date.now()).run();
}
export async function browserSessionForJob(env, jobId) {
  const event = await statement(env, "SELECT data FROM job_events WHERE job_id=? AND type='browser_session' ORDER BY created_at DESC,rowid DESC LIMIT 1", jobId).first();
  return event ? JSON.parse(event.data).sessionId || null : null;
}
export async function startJob(env, row) {
  const now = Date.now();
  await env.DB.batch([
    statement(env, "UPDATE jobs SET status='running',updated_at=? WHERE id=? AND stopped=0 AND status='queued'", now, row.id),
    // Capture canonical state and its asset references in the same transaction,
    // before any agent edit. Retain only the latest job's private Undo snapshot.
    statement(env, `INSERT OR IGNORE INTO job_events(job_id,id,type,data,created_at)
      SELECT j.id,'undo','undo_snapshot',json_object('project',json(p.document),'afterRevision',p.revision),?
      FROM jobs j JOIN projects p ON p.user_id=j.user_id AND p.id=j.project_id WHERE j.id=? AND j.status='running' AND j.stopped=0`, now, row.id),
    statement(env, `INSERT OR IGNORE INTO job_assets(job_id,user_id,asset_id) SELECT j.id,p.user_id,p.asset_id FROM jobs j JOIN project_assets p ON p.user_id=j.user_id AND p.project_id=j.project_id
      WHERE j.id=? AND j.status='running' AND j.stopped=0`, row.id),
    statement(env, `DELETE FROM job_events WHERE type='undo_snapshot' AND job_id IN(SELECT id FROM jobs WHERE user_id=? AND project_id=? AND id<>?)
      AND EXISTS(SELECT 1 FROM job_events WHERE job_id=? AND id='undo' AND type='undo_snapshot')`, row.user_id, row.project_id, row.id, row.id),
  ]);
}
export async function canUndoJob(env, row) {
  if (!row || !['completed', 'failed', 'stopped'].includes(row.status)) return false;
  return Boolean(await statement(env, `SELECT 1 FROM job_events e JOIN projects p ON p.user_id=? AND p.id=? WHERE e.job_id=? AND e.id='undo' AND e.type='undo_snapshot'
    AND json_extract(e.data,'$.afterRevision')=p.revision AND COALESCE(json_extract(e.data,'$.used'),0)=0
    AND json_extract(e.data,'$.afterRevision')>json_extract(e.data,'$.project.revision')
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND project_id=? AND status IN ('queued','running'))
    AND (SELECT id FROM jobs WHERE user_id=? AND project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)=?`, row.user_id, row.project_id, row.id, row.user_id, row.project_id, row.user_id, row.project_id, row.id).first());
}
export async function jobWithUndo(env, row) {
  return row ? { ...publicJob(row), canUndo: await canUndoJob(env, row) } : null;
}
export async function undoJob(env, userId, row, expectedRevision) {
  if (!row || row.user_id !== userId) fail(404, 'NOT_FOUND', 'Agent request not found.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail(400, 'INVALID_REVISION', 'Expected revision is required.');
  const project = await getProject(env, userId, row.project_id);
  if (await statement(env, "SELECT id FROM jobs WHERE user_id=? AND project_id=? AND status IN ('queued','running')", userId, row.project_id).first()) fail(409, 'JOB_ACTIVE', 'Stop the agent before undoing.');
  const snapshot = await statement(env, "SELECT data FROM job_events WHERE job_id=? AND id='undo' AND type='undo_snapshot'", row.id).first();
  if (!snapshot) fail(409, 'UNDO_UNAVAILABLE', 'Only the latest agent request can be undone.');
  const before = JSON.parse(snapshot.data);
  if (project.revision !== expectedRevision || project.revision !== before.afterRevision) fail(409, 'STALE_PROJECT', 'The carousel changed after this request. Your newer edits were kept.', { project, actualRevision: project.revision });
  if (!await canUndoJob(env, row)) fail(409, 'UNDO_UNAVAILABLE', 'This agent request can no longer be undone.');
  const restored = await saveProject(env, userId, row.project_id, before.project, expectedRevision, { undoJobId: row.id });
  return { project: restored, job: { ...publicJob(row), canUndo: false } };
}
export async function createJob(env, userId, projectId, input) {
  if (!env.OPENROUTER_API_KEY || !env.AGENT_WORKFLOW || !env.BROWSER) fail(503, 'NOT_CONFIGURED', 'The hosted agent is not configured.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) fail(400, 'INVALID_PROMPT', 'Enter a prompt up to 12,000 characters.');
  const requestId = typeof input.requestId === 'string' ? input.requestId : crypto.randomUUID();
  if (requestId.length > 160) fail(400, 'INVALID_REQUEST', 'Invalid request ID.');
  const previous = await statement(env, 'SELECT * FROM jobs WHERE user_id=? AND request_id=?', userId, requestId).first();
  if (previous) {
    if (previous.project_id !== projectId || previous.prompt !== input.prompt.trim()) fail(409, 'REQUEST_CONFLICT', 'This request ID was already used.');
    if (previous.status === 'queued') await dispatchJob(env, previous);
    return publicJob(previous);
  }
  const project = await getProject(env, userId, projectId);
  if (input.expectedRevision !== project.revision) fail(409, 'STALE_PROJECT', 'Project changed. Reload before generating.', { project, actualRevision: project.revision });
  const suppliedAttachments = input.attachmentIds || input.attachments || [];
  if (!Array.isArray(suppliedAttachments) || suppliedAttachments.length > 8 || suppliedAttachments.some((id) => typeof id !== 'string')) fail(400, 'INVALID_ATTACHMENTS', 'Attach up to eight images.');
  const attachments = [...new Set(suppliedAttachments)];
  for (const id of attachments) if (!await statement(env, 'SELECT id FROM assets WHERE user_id=? AND id=?', userId, id).first()) fail(404, 'NOT_FOUND', 'Attached image not found.');
  const info = await account(env, userId);
  if (!info.billing.active) fail(402, 'SUBSCRIPTION_REQUIRED', 'Subscribe to use the hosted agent.');
  const budget = jobBudget(env); const now = Date.now(); const id = crypto.randomUUID();
  let results;
  try {
    results = await env.DB.batch([
      statement(env, `INSERT INTO jobs(id,user_id,project_id,request_id,prompt,attachments,period_start,budget,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM allowances WHERE user_id=? AND period_start=? AND allowance-spent-reserved>=?)
        AND EXISTS(SELECT 1 FROM projects WHERE user_id=? AND id=? AND revision=?)
        AND EXISTS(SELECT 1 FROM subscriptions WHERE user_id=? AND id=? AND period_start=? AND period_end>? AND status IN ('active','trialing'))`, id, userId, projectId, requestId, input.prompt.trim(), JSON.stringify(attachments), info.periodStart, budget, now, now, userId, info.periodStart, budget, userId, projectId, input.expectedRevision, userId, info.subscriptionId, info.periodStart, now),
      statement(env, 'UPDATE allowances SET reserved=reserved+? WHERE user_id=? AND period_start=? AND EXISTS(SELECT 1 FROM jobs WHERE id=?)', budget, userId, info.periodStart, id),
      ...attachments.map(assetId => statement(env, 'INSERT INTO job_assets(job_id,user_id,asset_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=?)', id, userId, assetId, id)),
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) {
      const duplicate = await statement(env, 'SELECT * FROM jobs WHERE user_id=? AND request_id=?', userId, requestId).first();
      if (duplicate && duplicate.project_id === projectId && duplicate.prompt === input.prompt.trim()) {
        if (duplicate.status === 'queued') await dispatchJob(env, duplicate);
        return publicJob(duplicate);
      }
      fail(409, 'JOB_ACTIVE', 'An agent is already editing this carousel.');
    }
    throw error;
  }
  if (!results[0].meta.changes) {
    const current = await getProject(env, userId, projectId);
    if (current.revision !== input.expectedRevision) fail(409, 'STALE_PROJECT', 'Project changed. Reload and retry.', { project: current, actualRevision: current.revision });
    fail(402, 'QUOTA_EXCEEDED', 'Your agent allowance has been used.');
  }
  const row = await statement(env, 'SELECT * FROM jobs WHERE id=?', id).first();
  await emit(env, id, 'message', { message: { role: 'user', content: input.prompt.trim() } }, 'prompt');
  try { await dispatchJob(env, row); }
  catch (error) {
    // A lost create/status response does not prove the Workflow failed to start.
    // Keep its reservation; polling can safely retry the same Workflow ID.
    console.error('Agent dispatch will retry', { jobId: id, message: error.message });
  }
  return publicJob(row);
}
export async function dispatchJob(env, row) {
  try { await env.AGENT_WORKFLOW.create({ id: row.id, params: { jobId: row.id } }); }
  catch (error) {
    // A retry after a lost HTTP response may find the same workflow already started.
    try { const workflow = await env.AGENT_WORKFLOW.get(row.id); await workflow.status(); }
    catch { throw error; }
  }
}
export async function recordUsage(env, row, usage) {
  if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost)) fail(502, 'UNKNOWN_USAGE', 'The model did not report a valid cost.');
  const cost = money(usage.cost);
  if (!Number.isSafeInteger(cost) || cost < 0) fail(502, 'UNKNOWN_USAGE', 'The model did not report a valid cost.');
  const eventId = `usage:${usage.id || usage.generationId || ''}`;
  if (eventId === 'usage:') fail(502, 'UNKNOWN_USAGE', 'The model did not report a generation ID.');
  // Generation IDs make debits idempotent if a Workflow step is retried.
  const result = await env.DB.batch([
    statement(env, 'UPDATE jobs SET spent=spent+?,updated_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM job_events WHERE job_id=? AND id=?)', cost, Date.now(), row.id, row.id, eventId),
    statement(env, 'INSERT OR IGNORE INTO job_events(job_id,id,type,data,created_at) VALUES(?,?,?,?,?)', row.id, eventId, 'usage', JSON.stringify(usage), Date.now()),
  ]);
  const job = await statement(env, 'SELECT spent,budget FROM jobs WHERE id=?', row.id).first();
  const remaining = dollars(job.budget - job.spent);
  if (remaining < 0) fail(402, 'QUOTA_EXCEEDED', 'This request reached its agent budget.');
  return remaining;
}
export async function finishJob(env, row, status, error = null, { uncertainUsage = false } = {}) {
  await env.DB.batch([
    // A provider may have billed us before its usage write failed. Keep the
    // reservation charged in that case; retries cannot charge a settled job.
    ...(uncertainUsage ? [statement(env, "UPDATE jobs SET spent=MAX(spent,budget) WHERE id=? AND status IN ('queued','running')", row.id)] : []),
    statement(env, `UPDATE allowances SET reserved=MAX(0,reserved-?),spent=spent+(SELECT spent FROM jobs WHERE id=?) WHERE user_id=? AND period_start=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status IN ('queued','running'))`, row.budget, row.id, row.user_id, row.period_start, row.id),
    statement(env, "UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('queued','running')", status, error, Date.now(), row.id),
  ]);
}
export async function history(env, row) {
  const events = await eventsForProject(env, row.user_id, row.project_id);
  // The current user prompt is supplied in job.prompt by the agent.
  return events.filter((event) => event.type === 'message' && event.job_id !== row.id).map((event) => event.data.message).filter(Boolean).slice(-80);
}
