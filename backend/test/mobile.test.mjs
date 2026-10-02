import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { syncRevenueCat, revenueCatWebhook } from '../revenuecat.mjs';
import { account, saveProject, acceptWebhook, statement } from '../store.mjs';
import { createJob } from '../jobs.mjs';
import { api } from '../api.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_product',
    '0002_folders',
    '0003_asset_references',
    '0004_mobile_billing',
  ])
    db.exec(readFileSync(new URL(`../migrations/${migration}.sql`, import.meta.url), 'utf8'));
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...values) => ({
          first: async () => db.prepare(sql).get(...values) || null,
          all: async () => ({ results: db.prepare(sql).all(...values) }),
          run: async () => ({ meta: db.prepare(sql).run(...values) }),
        }),
      }),
      batch: async (queries) => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const query of queries) results.push(await query.run());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
    POLAR_PRODUCT_ID: 'polar-pro',
    APP_ORIGIN: 'https://carousel.bot',
    CLERK_MOBILE_AUDIENCE: 'carouselbot-mobile',
    REVENUECAT_SECRET_KEY: 'test-secret',
    REVENUECAT_WEBHOOK_AUTH: 'Bearer webhook-test',
    REVENUECAT_PRODUCT_IDS: 'carouselbot_pro_monthly,carouselbot-pro:monthly',
    AGENT_ALLOWANCE_USD: '5',
    JOB_BUDGET_USD: '.5',
    OPENROUTER_API_KEY: 'test',
    BROWSER: {},
    AGENT_WORKFLOW: { create: async () => {} },
  };
  const start = Date.now() - 60000,
    end = Date.now() + 86400000;
  const subscriber = {
    entitlements: {
      pro: {
        product_identifier: 'carouselbot_pro_monthly',
        purchase_date: new Date(start).toISOString(),
        expires_date: new Date(end).toISOString(),
      },
    },
    subscriptions: {
      carouselbot_pro_monthly: {
        store: 'app_store',
        is_sandbox: false,
        purchase_date: new Date(start).toISOString(),
      },
    },
  };
  env.REVENUECAT_FETCH = async () => Response.json({ subscriber });
  return { env, db, subscriber, start, end };
}
test('verified store purchase grants the same account and allowance used by web agent jobs', async () => {
  const { env } = fixture();
  await syncRevenueCat(env, 'user_alex');
  const info = await account(env, 'user_alex');
  assert.equal(info.billing.provider, 'revenuecat');
  assert.equal(info.billing.store, 'app_store');
  assert.equal(info.credits, 500);
  const project = await saveProject(
    env,
    'user_alex',
    'test',
    { id: 'test', name: 'Mobile', slides: [], assets: [] },
    0,
  );
  const job = await createJob(env, 'user_alex', 'test', {
    prompt: 'Edit my slides',
    expectedRevision: project.revision,
  });
  assert.equal(job.status, 'queued');
  assert.equal((await account(env, 'user_alex')).credits, 450);
  assert.equal((await account(env, 'user_other')).billing.active, false);
});
test('reconciliation and webhook replays never replenish spent credits', async () => {
  const { env } = fixture();
  await syncRevenueCat(env, 'user_alex');
  await statement(env, 'UPDATE allowances SET spent=2000000 WHERE user_id=?', 'user_alex').run();
  await syncRevenueCat(env, 'user_alex', { force: true });
  const request = () =>
    new Request('https://carousel.bot/api/billing/revenuecat/webhook', {
      method: 'POST',
      headers: { authorization: env.REVENUECAT_WEBHOOK_AUTH },
      body: JSON.stringify({ event: { id: 'renewal', type: 'RENEWAL', app_user_id: 'user_alex' } }),
    });
  await revenueCatWebhook(request(), env);
  await revenueCatWebhook(request(), env);
  assert.equal((await account(env, 'user_alex')).credits, 300);
  assert.equal((await statement(env, 'SELECT COUNT(*) AS count FROM webhooks').first()).count, 1);
});
test('untrusted webhook and unsupported product/store/sandbox cannot grant access', async () => {
  const { env, subscriber } = fixture();
  await assert.rejects(
    revenueCatWebhook(new Request('https://carousel.bot', { method: 'POST', body: '{}' }), env),
    (e) => e.code === 'INVALID_SIGNATURE',
  );
  subscriber.subscriptions.carouselbot_pro_monthly.is_sandbox = true;
  await syncRevenueCat(env, 'user_alex');
  assert.equal((await account(env, 'user_alex')).billing.active, false);
  env.REVENUECAT_ENVIRONMENT = 'SANDBOX';
  await new Promise((resolve) => setTimeout(resolve, 3));
  await syncRevenueCat(env, 'user_alex', { force: true });
  assert.equal((await account(env, 'user_alex')).billing.active, true);
  subscriber.entitlements.pro.product_identifier = 'unapproved';
  await new Promise((resolve) => setTimeout(resolve, 3));
  await syncRevenueCat(env, 'user_alex', { force: true });
  assert.equal((await account(env, 'user_alex')).billing.active, false);
});
test('cancel at period end retains access; expiration removes it without erasing spend', async () => {
  const { env, subscriber } = fixture();
  subscriber.subscriptions.carouselbot_pro_monthly.unsubscribe_detected_at =
    new Date().toISOString();
  await syncRevenueCat(env, 'user_alex');
  assert.equal((await account(env, 'user_alex')).billing.active, true);
  await statement(env, 'UPDATE allowances SET spent=1000000').run();
  subscriber.entitlements.pro.expires_date = new Date(Date.now() - 100).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 3));
  await syncRevenueCat(env, 'user_alex', { force: true });
  assert.equal((await account(env, 'user_alex')).billing.active, false);
  assert.equal((await statement(env, 'SELECT spent FROM allowances').first()).spent, 1000000);
});
test('failed verification keeps existing entitlement and remains retryable', async () => {
  const { env } = fixture();
  await syncRevenueCat(env, 'user_alex');
  env.REVENUECAT_FETCH = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(
    syncRevenueCat(env, 'user_alex', { force: true }),
    (e) => e.code === 'BILLING_UNAVAILABLE',
  );
  assert.equal((await account(env, 'user_alex')).billing.active, true);
});
test('renewal grants a new period once; grace extends access without refilling spend', async () => {
  const { env, subscriber, start } = fixture();
  await syncRevenueCat(env, 'user_alex');
  await statement(env, 'UPDATE allowances SET spent=2000000').run();
  subscriber.entitlements.pro.expires_date = new Date(Date.now() - 10).toISOString();
  subscriber.subscriptions.carouselbot_pro_monthly.grace_period_expires_date = new Date(
    Date.now() + 60000,
  ).toISOString();
  await new Promise((r) => setTimeout(r, 3));
  await syncRevenueCat(env, 'user_alex', { force: true });
  assert.equal((await account(env, 'user_alex')).credits, 300);
  subscriber.subscriptions.carouselbot_pro_monthly.purchase_date = new Date(
    start + 30000,
  ).toISOString();
  subscriber.entitlements.pro.expires_date = new Date(Date.now() + 86400000).toISOString();
  await new Promise((r) => setTimeout(r, 3));
  await syncRevenueCat(env, 'user_alex', { force: true });
  await syncRevenueCat(env, 'user_alex', { force: true });
  assert.equal((await account(env, 'user_alex')).credits, 500);
  assert.equal((await statement(env, 'SELECT COUNT(*) AS n FROM allowances').first()).n, 2);
});
test('transfer reconciles both accounts from the subscriber service, not webhook assertions', async () => {
  const { env, subscriber } = fixture();
  await syncRevenueCat(env, 'user_alex');
  env.REVENUECAT_FETCH = async (url) =>
    Response.json({
      subscriber: url.endsWith('user_other') ? subscriber : { entitlements: {}, subscriptions: {} },
    });
  await new Promise((r) => setTimeout(r, 3));
  await revenueCatWebhook(
    new Request('https://carousel.bot', {
      method: 'POST',
      headers: { authorization: env.REVENUECAT_WEBHOOK_AUTH },
      body: JSON.stringify({
        event: {
          id: 'transfer',
          type: 'TRANSFER',
          transferred_from: ['user_alex'],
          transferred_to: ['user_other'],
        },
      }),
    }),
    env,
  );
  assert.equal((await account(env, 'user_alex')).billing.active, false);
  assert.equal((await account(env, 'user_other')).billing.active, true);
});
test('a delayed older reconciliation cannot revoke a newer verified purchase', async () => {
  const { env, subscriber } = fixture();
  let release, fetched;
  const started = new Promise((r) => {
    fetched = r;
  });
  env.REVENUECAT_FETCH = async () => {
    fetched();
    return new Promise((r) => {
      release = r;
    });
  };
  const old = syncRevenueCat(env, 'user_alex', { force: true });
  await started;
  await new Promise((r) => setTimeout(r, 3));
  env.REVENUECAT_FETCH = async () => Response.json({ subscriber });
  await syncRevenueCat(env, 'user_alex', { force: true });
  release(Response.json({ subscriber: { entitlements: {}, subscriptions: {} } }));
  await old;
  assert.equal((await account(env, 'user_alex')).billing.active, true);
  assert.equal((await account(env, 'user_alex')).credits, 500);
});
test('existing Polar subscription is recognized by mobile with its original credit ledger', async () => {
  const { env, start, end } = fixture();
  await acceptWebhook(env, 'polar-event', {
    type: 'subscription.active',
    data: {
      id: 'polar-sub',
      status: 'active',
      product_id: 'polar-pro',
      customer: { external_id: 'user_alex' },
      current_period_start: new Date(start).toISOString(),
      current_period_end: new Date(end).toISOString(),
      modified_at: new Date().toISOString(),
    },
  });
  await statement(env, 'UPDATE allowances SET spent=1230000').run();
  const info = await account(env, 'user_alex');
  assert.equal(info.billing.provider, 'polar');
  assert.equal(info.credits, 377);
});
test('mobile JWT requires verified issuer, session and dedicated audience, preserving web origin checks', async () => {
  const { env } = fixture();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  env.CLERK_JWT_KEY = await exportSPKI(publicKey);
  env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('test.clerk.accounts.dev$').toString('base64')}`;
  const sign = (changes) =>
    new SignJWT({ sid: 'sess_test', aud: 'carouselbot-mobile', v: 2, ...changes })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('user_alex')
      .setIssuer('https://test.clerk.accounts.dev')
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) - 5)
      .setExpirationTime('5m')
      .sign(privateKey);
  const request = async (changes = {}, mobile = true) =>
    new Request('https://carousel.bot/api/account', {
      headers: {
        authorization: `Bearer ${await sign(changes)}`,
        ...(mobile ? { 'x-carousel-client': 'mobile' } : {}),
      },
    });
  assert.equal((await api(await request(), env)).status, 200);
  assert.equal((await api(await request({ aud: 'other-app' }), env)).status, 401);
  assert.equal((await api(await request({ azp: 'https://evil.example' }), env)).status, 401);
  assert.equal((await api(await request({ sid: 'not-a-session' }), env)).status, 401);
  assert.equal((await api(await request({}, false), env)).status, 401);
  assert.equal((await api(await request({ azp: env.APP_ORIGIN }, false), env)).status, 200);
  const project = await saveProject(
    env,
    'user_alex',
    'delete-me',
    { id: 'delete-me', name: 'Private', slides: [], assets: [] },
    0,
  );
  await syncRevenueCat(env, 'user_alex');
  const job = await createJob(env, 'user_alex', project.id, {
    prompt: 'Edit this',
    expectedRevision: project.revision,
  });
  const deletion = async () =>
    new Request('https://carousel.bot/api/account', {
      method: 'DELETE',
      headers: (await request()).headers,
    });
  assert.equal(
    (await api(await deletion(), env)).status,
    409,
    'running jobs must stop before deletion',
  );
  await statement(env, "UPDATE jobs SET status='stopped' WHERE id=?", job.id).run();
  assert.equal((await api(await deletion(), env)).status, 200);
  assert.equal((await statement(env, 'SELECT COUNT(*) AS n FROM projects').first()).n, 0);
  assert.equal((await statement(env, 'SELECT COUNT(*) AS n FROM jobs').first()).n, 0);
  assert.equal(
    (await api(await request(), env)).status,
    410,
    'an unexpired old session cannot recreate the account',
  );
  await syncRevenueCat(env, 'user_alex', { force: true });
  await acceptWebhook(env, 'after-deletion', {
    type: 'subscription.active',
    data: {
      id: 'polar-sub',
      status: 'active',
      product_id: 'polar-pro',
      customer: { external_id: 'user_alex' },
      current_period_start: new Date(Date.now() - 1000).toISOString(),
      current_period_end: new Date(Date.now() + 60000).toISOString(),
      modified_at: new Date().toISOString(),
    },
  });
  assert.equal(
    (await statement(env, 'SELECT COUNT(*) AS n FROM subscriptions').first()).n,
    0,
    'billing retries cannot resurrect deleted data or refill credits',
  );
});
