import test from 'node:test';
import assert from 'node:assert/strict';
import { productHeaders } from '../backend/security-headers.mjs';
import { readFile } from 'node:fs/promises';

test('hosted static pages permit configured Clerk scripts without broad script sources', () => {
  const publishableKey = `pk_test_${Buffer.from('test.clerk.accounts.dev$').toString('base64')}`;
  const csp = productHeaders({ CLERK_PUBLISHABLE_KEY: publishableKey })['Content-Security-Policy'];
  const scripts = csp.split('; ').find(part => part.startsWith('script-src '));
  assert.ok(scripts.includes('https://test.clerk.accounts.dev'));
  assert.ok(!scripts.includes("'unsafe-inline'"));
  assert.ok(!scripts.includes("'unsafe-eval'"));
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  const invalid = `pk_test_${Buffer.from('example.com; script-src *$').toString('base64')}`;
  assert.ok(!productHeaders({ CLERK_PUBLISHABLE_KEY: invalid })['Content-Security-Policy'].includes('example.com'));
});

test('product Worker runs before static assets so authentication CSP reaches landing and editor', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.product.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.r2_buckets[0].binding, 'ASSETS_BUCKET');
});
