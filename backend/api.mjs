import { verifyToken } from '@clerk/backend';
import { createPolar, webhooks } from '@polar-sh/sdk/2026-04';
import { ApiError, fail, identifier, readJson, readBody, MAX_ASSET_BYTES, publicJob } from './core.mjs';
import { statement, getProject, saveProject, loadAsset, saveAsset, deleteAsset, deleteProject, cleanupUnusedAssets, account, acceptWebhook, eventsForProject, displayMessages } from './store.mjs';
import { createJob, dispatchJob, jobWithUndo, undoJob } from './jobs.mjs';
import { folders, createFolder, moveFolder } from './folders.mjs';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function authenticate(request, env) {
  if (!env.CLERK_JWT_KEY || !env.CLERK_PUBLISHABLE_KEY || !env.APP_ORIGIN) fail(503, 'NOT_CONFIGURED', 'Sign in is not configured.');
  // Bearer tokens are deliberate: requests cannot inherit another origin's ambient session cookie.
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) fail(401, 'UNAUTHORIZED', 'Sign in to continue.');
  let issuer;
  try {
    const host = atob(env.CLERK_PUBLISHABLE_KEY.split('_')[2]).replace(/\$$/, '');
    if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('Invalid host.');
    issuer = `https://${host}`;
  } catch { fail(503, 'NOT_CONFIGURED', 'Sign in is not configured.'); }
  let claims;
  try {
    claims = await verifyToken(request.headers.get('authorization').slice('Bearer '.length), {
      authorizedParties: [env.APP_ORIGIN],
      jwtKey: env.CLERK_JWT_KEY,
    });
  } catch { fail(401, 'UNAUTHORIZED', 'Sign in to continue.'); }
  if (claims.iss !== issuer || claims.azp !== env.APP_ORIGIN || !/^user_[\w-]+$/.test(claims.sub || '') || !/^sess_[\w-]+$/.test(claims.sid || '') || !Number.isSafeInteger(claims.exp) || claims.sts === 'pending') fail(401, 'UNAUTHORIZED', 'Sign in to continue.');
  return claims.sub;
}
function billingClient(env) {
  if (!env.POLAR_ACCESS_TOKEN || !env.POLAR_PRODUCT_ID) fail(503, 'NOT_CONFIGURED', 'Billing is not configured.');
  return createPolar({ accessToken: env.POLAR_ACCESS_TOKEN, ...(env.POLAR_ENVIRONMENT === 'sandbox' ? { environment: 'sandbox' } : {}) });
}
export async function api(request, env) {
  try {
    const url = new URL(request.url); const path = url.pathname;
    if (path === '/api/config' && request.method === 'GET') return json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || '', ready: Boolean(env.CLERK_JWT_KEY && env.CLERK_PUBLISHABLE_KEY && env.DB), billingAvailable: Boolean(env.POLAR_ACCESS_TOKEN && env.POLAR_PRODUCT_ID), agentAvailable: Boolean(env.OPENROUTER_API_KEY && env.AGENT_WORKFLOW && env.BROWSER), allowanceCredits: Math.floor(Number(env.AGENT_ALLOWANCE_USD || 5) * 100), jobBudgetCredits: Math.floor(Number(env.JOB_BUDGET_USD || .5) * 100) });
    if (path === '/api/billing/webhook' && request.method === 'POST') {
      if (!env.POLAR_WEBHOOK_SECRET) fail(503, 'NOT_CONFIGURED', 'Webhook is not configured.');
      const body = await readBody(request, 1024 * 1024);
      let event;
      try { event = await webhooks.validateEvent(body, Object.fromEntries(request.headers), env.POLAR_WEBHOOK_SECRET); }
      catch { fail(403, 'INVALID_SIGNATURE', 'Invalid webhook signature.'); }
      const id = request.headers.get('webhook-id');
      if (!id || id.length > 200) fail(400, 'INVALID_WEBHOOK', 'Webhook ID is required.');
      await acceptWebhook(env, id, event);
      return json({ received: true });
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== env.APP_ORIGIN) fail(403, 'INVALID_ORIGIN', 'Origin is not permitted.');
    const userId = await authenticate(request, env);
    if (path === '/api/folders' && request.method === 'GET') return json({ folders: await folders(env, userId) });
    if (path === '/api/folders' && request.method === 'POST') return json({ folders: await createFolder(env, userId, await readJson(request, 1000)) });
    if (path === '/api/folders/move' && request.method === 'POST') return json(await moveFolder(env, userId, await readJson(request, 1000)));
    if ((path === '/api/account' || path === '/api/me') && request.method === 'GET') {
      try { await cleanupUnusedAssets(env, userId); }
      catch (error) { console.error('Account asset cleanup deferred', { message: error.message }); }
      const { periodStart, ...info } = await account(env, userId); return json(info);
    }
    if (path === '/api/projects' && request.method === 'GET') {
      const result = await statement(env, 'SELECT document FROM projects WHERE user_id=? ORDER BY updated_at DESC', userId).all();
      return json({ projects: result.results.map((row) => JSON.parse(row.document)) });
    }
    const projectRoute = path.match(/^\/api\/projects\/([^/]+)(?:\/(chat|jobs))?$/);
    if (projectRoute) {
      const id = identifier(projectRoute[1], 'project ID'); const action = projectRoute[2];
      if (action === 'jobs' && request.method === 'POST') return json({ job: await createJob(env, userId, id, await readJson(request, 16000)) }, 202);
      if (action === 'chat' && request.method === 'GET') {
        await getProject(env, userId, id);
        const events = await eventsForProject(env, userId, id);
        const job = await statement(env, 'SELECT * FROM jobs WHERE user_id=? AND project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', userId, id).first();
        return json({ messages: displayMessages(events), job: await jobWithUndo(env, job) });
      }
      if (!action && request.method === 'GET') return json({ project: await getProject(env, userId, id) });
      if (!action && request.method === 'PUT') {
        const input = await readJson(request); return json({ project: await saveProject(env, userId, id, input.project, input.expectedRevision) });
      }
      if (!action && request.method === 'DELETE') {
        const expected = Number(url.searchParams.get('expectedRevision'));
        if (!url.searchParams.has('expectedRevision') || !Number.isSafeInteger(expected)) fail(400, 'INVALID_REVISION', 'Expected revision is required.');
        const active = await statement(env, "SELECT id FROM jobs WHERE user_id=? AND project_id=? AND status IN ('queued','running')", userId, id).first();
        if (active) fail(409, 'JOB_ACTIVE', 'Stop the agent before deleting this project.');
        await deleteProject(env, userId, id, expected);
        return json({ deleted: true });
      }
    }
    if (path === '/api/assets' && request.method === 'POST') return json(await saveAsset(env, userId, { body: await readBody(request, MAX_ASSET_BYTES), mimeType: request.headers.get('content-type')?.split(';')[0], name: decodeURIComponent(request.headers.get('x-file-name') || 'Image') }), 201);
    const assetRoute = path.match(/^\/api\/assets\/([^/]+)$/);
    if (assetRoute && request.method === 'DELETE') { await deleteAsset(env, userId, assetRoute[1]); return json({ deleted: true }); }
    if (assetRoute && request.method === 'GET') {
      const asset = await loadAsset(env, userId, assetRoute[1]);
      return new Response(asset.body, { headers: { 'content-type': asset.mimeType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
    }
    const jobRoute = path.match(/^\/api\/jobs\/([^/]+)(?:\/(stop|undo))?$/);
    if (jobRoute) {
      const id = identifier(jobRoute[1], 'job ID');
      const row = await statement(env, 'SELECT * FROM jobs WHERE id=? AND user_id=?', id, userId).first();
      if (!row) fail(404, 'NOT_FOUND', 'Agent request not found.');
      if (jobRoute[2] === 'undo' && request.method === 'POST') return json(await undoJob(env, userId, row, (await readJson(request, 1000)).expectedRevision));
      if (jobRoute[2] === 'stop' && request.method === 'POST') {
        await statement(env, "UPDATE jobs SET stopped=1,updated_at=? WHERE id=? AND status IN ('queued','running')", Date.now(), id).run();
        // Cooperative stop lets an in-flight generation record its actual cost before settlement.
        return json({ job: publicJob(await statement(env, 'SELECT * FROM jobs WHERE id=?', id).first()) });
      }
      if (!jobRoute[2] && request.method === 'GET') {
        if (row.status === 'queued') {
          try { await dispatchJob(env, row); }
          catch (error) { console.error('Agent dispatch will retry', { jobId: row.id, message: error.message }); }
        }
        const events = await eventsForProject(env, userId, row.project_id);
        return json({ job: await jobWithUndo(env, row), project: await getProject(env, userId, row.project_id), messages: displayMessages(events), events: events.filter((event) => event.job_id === id && !['message', 'browser_session', 'undo_snapshot'].includes(event.type)) });
      }
    }
    if (path === '/api/billing/checkout' && request.method === 'POST') {
      if ((await account(env, userId)).billing.active) fail(409, 'ALREADY_SUBSCRIBED', 'You already have an active subscription. Manage it in your billing portal.');
      const checkout = await billingClient(env).checkouts.create({ products: [env.POLAR_PRODUCT_ID], external_customer_id: userId, success_url: `${env.APP_ORIGIN}/dashboard?checkout=success`, return_url: `${env.APP_ORIGIN}/dashboard`, allow_trial: false });
      return json({ url: checkout.url });
    }
    if (path === '/api/billing/portal' && request.method === 'POST') {
      const session = await billingClient(env).customerSessions.create({ external_customer_id: userId, return_url: `${env.APP_ORIGIN}/dashboard` });
      return json({ url: session.customer_portal_url });
    }
    fail(404, 'NOT_FOUND', 'API route not found.');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code, ...error.details }, error.status);
    console.error('Product API request failed', { name: error.name, message: error.message });
    return json({ error: 'Something went wrong. Please retry.', code: 'INTERNAL_ERROR' }, 500);
  }
}
