import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductClient } from '../src/product-client.mjs';

test('cloud saves reuse unchanged private media and upload a replacement background', async () => {
  const prior = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const bodies = [];
  globalThis.window = {
    CAROUSELBOT_CONFIG: { product: { clerkPublishableKey: `pk_test_${btoa('clerk.example$')}` } },
    Clerk: { user: { id: 'account-a' }, session: { getToken: async () => 'session-token' }, load: async () => {}, addListener: () => {} },
  };
  globalThis.document = { createElement: () => ({ dataset: {} }), head: { append: script => queueMicrotask(() => script.onload()) } };
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.headers?.Authorization, 'Bearer session-token');
    if (url === '/api/account') return Response.json({ credits: 4 });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body); bodies.push(body);
      return Response.json({ project: { ...body.project, revision: body.expectedRevision + 1,
        slides: body.project.slides.map(slide => ({ ...slide, imageData: '/api/assets/saved' })) } });
    }
    throw new Error('Unexpected test route ' + url);
  };
  try {
    const client = createProductClient(); await client.init();
    const project = { id: 'one', revision: 0, assets: [], slides: [{ id: 'slide', imageData: 'data:image/png;base64,original' }] };
    await client.cloudStore.put(project, 0);
    assert.equal(project.slides[0].imageData, 'data:image/png;base64,original');
    assert.equal(project.slides[0].cloudImageUrl, '/api/assets/saved');
    await client.cloudStore.put(project, 1);
    assert.equal(bodies[1].project.slides[0].imageData, '/api/assets/saved');
    assert.equal(bodies[1].project.slides[0].cloudImageUrl, undefined);
    project.slides[0].imageData = 'data:image/png;base64,replacement';
    await client.cloudStore.put(project, 2);
    assert.equal(bodies[2].project.slides[0].imageData, 'data:image/png;base64,replacement');
    assert.equal(client.cloudStore.accountId, 'account-a');
  } finally { Object.assign(globalThis, prior); }
});

test('cloud API propagates revision conflicts without claiming a successful save', async () => {
  const prior = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  globalThis.window = {
    CAROUSELBOT_CONFIG: { product: { clerkPublishableKey: `pk_test_${btoa('clerk.example$')}` } },
    Clerk: { user: { id: 'account-a' }, session: { getToken: async () => 'token' }, load: async () => {}, addListener: () => {} },
  };
  globalThis.document = { createElement: () => ({ dataset: {} }), head: { append: script => queueMicrotask(() => script.onload()) } };
  globalThis.fetch = async (url) => url === '/api/account' ? Response.json({}) : Response.json({ code: 'STALE_PROJECT', actualRevision: 8 }, { status: 409 });
  try {
    const client = createProductClient(); await client.init();
    await assert.rejects(client.cloudStore.put({ id: 'one', assets: [], slides: [], revision: 4 }, 3), error => error.code === 'STALE_PROJECT' && error.status === 409);
  } finally { Object.assign(globalThis, prior); }
});

test('cloud project creation and default saves always send a strict revision', async () => {
  const prior = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const revisions = new Map([['existing', 3]]);
  const bodies = [];
  globalThis.window = {
    CAROUSELBOT_CONFIG: { product: { clerkPublishableKey: `pk_test_${btoa('clerk.example$')}` } },
    Clerk: { user: { id: 'account-a' }, session: { getToken: async () => 'token' }, load: async () => {}, addListener: () => {} },
  };
  globalThis.document = { createElement: () => ({ dataset: {} }), head: { append: script => queueMicrotask(() => script.onload()) } };
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/account') return Response.json({});
    const body = JSON.parse(options.body); bodies.push(body);
    if (!Number.isInteger(body.expectedRevision)) return Response.json({ message: 'Expected revision is required.' }, { status: 400 });
    const actualRevision = revisions.get(body.project.id) || 0;
    if (body.expectedRevision !== actualRevision) return Response.json({ code: 'STALE_PROJECT', actualRevision }, { status: 409 });
    revisions.set(body.project.id, actualRevision + 1);
    return Response.json({ project: { ...body.project, revision: actualRevision + 1 } });
  };
  try {
    const client = createProductClient(); await client.init();
    const empty = { assets: [], slides: [] };
    const created = await client.cloudStore.put({ ...empty, id: 'new', revision: null }, null);
    assert.equal(bodies[0].expectedRevision, 0);
    assert.equal(created.revision, 1);
    const saved = await client.cloudStore.put({ ...empty, id: 'existing', revision: 3 }, null);
    assert.equal(bodies[1].expectedRevision, 3);
    assert.equal(saved.revision, 4);
    await client.cloudStore.put({ ...empty, id: 'existing', revision: 5 }, 4);
    assert.equal(bodies[2].expectedRevision, 4, 'explicit CAS wins over an incremented in-memory revision');
    assert.doesNotThrow(() => client.validateUpload({ type: 'image/png', name: 'photo.png' }));
    assert.throws(() => client.validateUpload({ type: 'image/svg+xml', name: 'mark.svg' }), /PNG, JPEG, WebP/);
    assert.throws(() => client.validateUpload({ type: 'image/avif', name: 'photo.avif' }), /PNG, JPEG, WebP/);
    assert.doesNotThrow(() => createProductClient().validateUpload({ type: 'image/svg+xml', name: 'local.svg' }), 'local editing retains existing image support');
    window.Clerk.user = { id: 'account-b' };
    await assert.rejects(client.cloudStore.put({ ...empty, id: 'existing', revision: 5 }, 5), /account changed/);
    await assert.rejects(client.hydrate({ ...empty, id: 'existing' }), /account changed/);
    assert.equal(bodies.length, 3, 'account switch cannot send the old document to the new account');
    window.Clerk.user = { id: 'account-a' };
    window.Clerk.session.getToken = async () => { window.Clerk.user = { id: 'account-b' }; return 'new-account-token'; };
    await assert.rejects(client.cloudStore.put({ ...empty, id: 'existing', revision: 5 }, 5), /account changed/);
    assert.equal(bodies.length, 3, 'switch during token acquisition is also blocked');
  } finally { Object.assign(globalThis, prior); }
});
