import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { directShares } from '../direct-shares.mjs';

test('production shares reuse existing signing, KV, Turnstile and quotas without a proxy', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../migrations/0001_share_budgets.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const stored = new Map();
  const env = {
    SHARING_ENABLED: 'true', TURNSTILE_SITE_KEY: 'existing-site-key', TURNSTILE_SECRET_KEY: 'existing-secret',
    SHARES: {
      async put(key, value, options) { stored.set(key, { value, options }); },
      async getWithMetadata(key) { const item = stored.get(key); return { value: item?.value, metadata: item?.options.metadata }; },
    },
    SHARE_BUDGETS: {
      prepare(sql) {
        return { sql, values: [], bind(...values) { return { ...this, values }; }, async first() { return db.prepare(sql).get(...this.values); } };
      },
      async batch(queries) {
        db.exec('BEGIN');
        try { const result = queries.map(query => db.prepare(query.sql).run(...query.values)); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(JSON.parse(options.body).secret, 'existing-secret');
    return Response.json({ success: true, hostname: 'carousel.bot', action: 'share' });
  });
  const config = await directShares(new Request('https://carousel.bot/api/shares/config'), env);
  assert.equal(config.status, 200); assert.equal((await config.json()).siteKey, 'existing-site-key');
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: { id: 'legacy', name: 'Legacy project', slides: [], assets: [] } }));
  const upload = await directShares(new Request('https://carousel.bot/api/shares', { method: 'POST', body: bytes, headers: {
    Origin: 'https://carousel.bot', 'Content-Type': 'application/octet-stream', 'X-CarouselBot-Share-Format': 'json-v1', 'X-CarouselBot-Share-Bytes': String(bytes.length), 'X-CarouselBot-Turnstile': 'proof', 'CF-Connecting-IP': '192.0.2.1',
  } }), env);
  assert.equal(upload.status, 201);
  const { id } = await upload.json();
  const headers = { 'CF-Connecting-IP': '192.0.2.1' };
  const opened = await directShares(new Request(`https://carousel.bot/api/shares/${id}`, { headers }), env);
  assert.equal(opened.status, 200); assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), bytes);
  assert.equal(stored.size, 1);
  assert.equal((await directShares(new Request(`https://preview.example/api/shares/${id}`, { headers }), env)).status, 403);
  const forged = id.slice(0, -1) + (id.endsWith('0') ? '1' : '0');
  assert.equal((await directShares(new Request(`https://carousel.bot/api/shares/${forged}`, { headers }), env)).status, 404);
  assert.equal((await directShares(new Request('https://carousel.bot/api/shares/config', { method: 'DELETE' }), env)).status, 404);
  assert.equal(db.prepare("SELECT count FROM share_budgets WHERE scope='upload:global'").get().count, 1);
});
