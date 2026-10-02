import { fail, readJson, money, revenueCatProduct } from './core.mjs';
import { statement } from './store.mjs';

const userPattern = /^user_[\w-]+$/;

// Only the server-to-server subscriber response grants access. Client CustomerInfo
// and webhook transaction fields are never accepted as proof of a purchase.
export async function syncRevenueCat(env, userId, { force = false, cooldown = 30000 } = {}) {
  if (!env.REVENUECAT_SECRET_KEY)
    fail(503, 'NOT_CONFIGURED', 'App subscriptions are not configured.');
  if (!userPattern.test(userId)) fail(400, 'INVALID_USER', 'Invalid account.');
  if (await statement(env, 'SELECT user_id FROM deleted_accounts WHERE user_id=?', userId).first())
    return;
  const id = `rc:${userId}`;
  const stamp = Date.now();
  const previous = await statement(
    env,
    'SELECT updated_at FROM subscriptions WHERE id=?',
    id,
  ).first();
  if (!force && previous && stamp - previous.updated_at < cooldown) return;
  const response = await (env.REVENUECAT_FETCH || fetch)(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
    {
      headers: { authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    fail(502, 'BILLING_UNAVAILABLE', 'Could not verify your subscription. Please retry.');
  const { subscriber } = await response.json();
  if (!subscriber || typeof subscriber !== 'object')
    fail(502, 'BILLING_UNAVAILABLE', 'Invalid subscription response.');
  const entitlement = subscriber.entitlements?.[env.REVENUECAT_ENTITLEMENT_ID || 'pro'];
  const subscription = subscriber.subscriptions?.[entitlement?.product_identifier];
  const start = Date.parse(subscription?.purchase_date || entitlement?.purchase_date);
  const end = Math.max(
    Date.parse(entitlement?.expires_date) || 0,
    Date.parse(subscription?.grace_period_expires_date) || 0,
  );
  const allowedProducts = String(env.REVENUECAT_PRODUCT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedStore = ['app_store', 'play_store'].includes(subscription?.store);
  const allowedEnvironment = !subscription?.is_sandbox || env.REVENUECAT_ENVIRONMENT === 'SANDBOX';
  const active = Boolean(
    entitlement &&
      subscription &&
      allowedStore &&
      allowedEnvironment &&
      allowedProducts.includes(entitlement.product_identifier) &&
      Number.isFinite(start) &&
      start <= stamp &&
      end > stamp,
  );
  const queries = [
    statement(
      env,
      `INSERT INTO subscriptions(id,user_id,product_id,status,period_start,period_end,updated_at,provider,store) VALUES(?,?,?,?,?,?,?,'revenuecat',?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,updated_at=excluded.updated_at,store=excluded.store WHERE excluded.updated_at>subscriptions.updated_at`,
      id,
      userId,
      revenueCatProduct(env),
      active ? 'active' : 'expired',
      Number.isFinite(start) ? start : 0,
      end,
      stamp,
      subscription?.store || null,
    ),
  ];
  if (active)
    queries.push(
      statement(
        env,
        `INSERT OR IGNORE INTO allowances(user_id,period_start,period_end,allowance)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND status='active' AND period_start=? AND updated_at=?)`,
        userId,
        start,
        end,
        money(env.AGENT_ALLOWANCE_USD || 5),
        id,
        start,
        stamp,
      ),
    );
  await env.DB.batch(queries);
}

export async function revenueCatWebhook(request, env) {
  if (!env.REVENUECAT_WEBHOOK_AUTH)
    fail(503, 'NOT_CONFIGURED', 'App billing webhook is not configured.');
  const digest = (value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([
    digest(request.headers.get('authorization') || ''),
    digest(env.REVENUECAT_WEBHOOK_AUTH),
  ]);
  let difference = 0;
  const a = new Uint8Array(actual),
    b = new Uint8Array(expected);
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) fail(403, 'INVALID_SIGNATURE', 'Invalid webhook authorization.');
  const { event } = await readJson(request, 1024 * 1024);
  if (!event || typeof event.id !== 'string' || event.id.length > 200)
    fail(400, 'INVALID_WEBHOOK', 'Webhook ID is required.');
  const eventId = `rc:${event.id}`;
  if (await statement(env, 'SELECT id FROM webhooks WHERE id=?', eventId).first()) return;
  if (event.type !== 'TEST') {
    const ids = [
      ...new Set(
        [
          event.app_user_id,
          event.original_app_user_id,
          ...(event.aliases || []),
          ...(event.transferred_from || []),
          ...(event.transferred_to || []),
        ].filter((id) => typeof id === 'string' && userPattern.test(id)),
      ),
    ];
    if (ids.length > 20) fail(400, 'INVALID_WEBHOOK', 'Too many accounts in webhook.');
    for (const id of ids) await syncRevenueCat(env, id, { force: true });
  }
  await statement(
    env,
    'INSERT OR IGNORE INTO webhooks(id,type,created_at) VALUES(?,?,?)',
    eventId,
    `revenuecat.${event.type}`,
    Date.now(),
  ).run();
}
