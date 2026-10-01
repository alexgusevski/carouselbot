import test from 'node:test';
import assert from 'node:assert/strict';
import { APIConnectionTimeoutError } from 'openai';
import { applyProjectOperations, inspectProject, solidBackground, projectImageAssetId } from '../backend/agent-model.mjs';
import { bytesDataUrl, decodeImageDataUrl, previewProject, createJobBrowserSession } from '../backend/agent-preview.mjs';
import { runAgent, completeConversation, providerUsage, modelCallBudget } from '../backend/agent.mjs';

const initial = () => ({ id: 'p1', name: 'Test', revision: 3, slides: [], assets: [], fonts: [] });
test('hosted operations preserve editable normalized layers and atomic draft changes', () => {
  const project = initial();
  project.customMetadata = 'preserved';
  const first = applyProjectOperations(project, [{ type: 'slide.add', name: 'Hook', backgroundColor: '#123456' }], { uid: () => 's1' });
  assert.equal(project.slides.length, 0);
  assert.equal(first.project.customMetadata, 'preserved');
  assert.equal(first.project.slides[0].width, 1080);
  const second = applyProjectOperations(first.project, [{ type: 'text.add', slideId: 's1', text: 'Hello', style: 'boxed', background: 'white', color: '#FFFFFF', x: .08, width: .8 }], { uid: () => 't1' });
  const text = second.project.slides[0].texts[0];
  assert.equal(text.color, '#111111');
  assert.equal(text.width, .8);
  assert.deepEqual(second.changedTextIds, ['t1']);
  assert.throws(() => applyProjectOperations(second.project, [{ type: 'slide.delete', slideId: 's1' }, { type: 'text.add', slideId: 'missing' }]), /Slide not found/);
  assert.equal(second.project.slides.length, 1);
});
test('hosted operations validate unique order and translate overlays as images only at tool boundary', () => {
  const project = initial();
  project.slides = [{ id: 's1', imageData: solidBackground(), texts: [], overlays: [{ id: 'i1', assetId: 'a1', width: .4 }] }, { id: 's2', texts: [], overlays: [] }];
  project.assets = [{ id: 'a1', name: 'Upload', width: 800, height: 600, imageData: 'private pixels' }];
  project.fonts = [{ id: 'f1', fontData: 'private font' }];
  assert.throws(() => applyProjectOperations(project, [{ type: 'slide.reorder', slideIds: ['s1', 's1'] }]), /every ID/);
  assert.throws(() => applyProjectOperations(project, [{ type: 'project.delete' }]), /Unsupported/);
  assert.throws(() => applyProjectOperations(project, [{ type: 'project.update', expectedRevision: 2, name: 'Wrong' }]), /Project changed/);
  const inspected = inspectProject(project);
  assert.deepEqual(inspected.slides[0].images, project.slides[0].overlays);
  assert.equal(inspected.slides[0].overlays, undefined);
  assert.equal(inspected.assets[0].imageData, undefined);
  assert.equal(inspected.fonts[0].fontData, undefined);
});
test('inspection keeps truthful private background metadata without exposing its pixels or URL', () => {
  const project = initial();
  project.slides = [{ id: 'photo', imageData: '/api/assets/private-photo', texts: [], overlays: [] }, { id: 'solid', imageData: solidBackground('#123456'), texts: [], overlays: [] }];
  const inspected = inspectProject(project);
  assert.deepEqual(inspected.assets, []);
  assert.equal(inspected.slides[0].imageData, undefined);
  assert.equal(inspected.slides[0].hasImage, true);
  assert.equal(inspected.slides[0].backgroundAssetId, 'private-photo');
  assert.deepEqual(inspected.slides[0].background, { type: 'image', assetId: 'private-photo' });
  assert.equal(inspected.slides[1].hasImage, false);
  assert.equal(inspected.slides[1].backgroundAssetId, null);
  assert.deepEqual(inspected.slides[1].background, { type: 'solid', color: '#123456' });
  assert.equal(JSON.stringify(inspected).includes('/api/assets/'), false);
});
test('library model UUID resolves to its own stored image, never to arbitrary URLs', () => {
  const project = initial();
  project.assets = [{ id: 'local-library-uuid', imageData: '/api/assets/private-stored-hash' }, { id: 'remote', imageData: 'https://external.example/photo.jpg' }];
  assert.equal(projectImageAssetId(project, 'local-library-uuid'), 'private-stored-hash');
  assert.equal(projectImageAssetId(project, 'uploaded-hash'), 'uploaded-hash');
  assert.throws(() => projectImageAssetId(project, 'remote'), /must be uploaded/);
  assert.throws(() => projectImageAssetId(project, 'https://external.example/photo.jpg'), /Invalid image/);
});
test('private images round trip without network retrieval and reject SVG/provider URLs', () => {
  const bytes = new Uint8Array([0, 128, 255, 40]);
  assert.deepEqual(decodeImageDataUrl(bytesDataUrl(bytes, 'image/png')).body, bytes);
  assert.throws(() => decodeImageDataUrl('https://example.com/a.png'), /unsupported/);
  assert.throws(() => decodeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), /unsupported/);
});
test('preview rejects arbitrary remote media and closes browser sessions on failures', async () => {
  const project = initial();
  project.slides = [{ id: 's1', imageData: 'https://external.example/private.png', texts: [], overlays: [] }];
  let launched = false;
  await assert.rejects(previewProject({}, project, { launch: async () => { launched = true; } }), /uploaded before/);
  assert.equal(launched, false);
  project.slides[0].imageData = solidBackground();
  let closed = false;
  await assert.rejects(previewProject({}, project, { launch: async () => ({ newPage: async () => { throw new Error('Browser unavailable'); }, close: async () => { closed = true; } }) }), /Browser unavailable/);
  assert.equal(closed, true);
});
test('private preview resolves uploaded project fonts through the owner asset store', async () => {
  const project = initial();
  project.fonts = [{ id: 'custom-font', fontData: '/api/assets/font-bytes' }];
  const loaded = [];
  const data = await previewProject({}, project, {
    loadAsset: async id => { loaded.push(id); return { body: new Uint8Array([1, 2, 3]), mimeType: 'font/ttf' }; },
    launch: async () => ({ newPage: async () => ({ setRequestInterception: async () => {}, on: () => {}, goto: async () => {}, evaluate: async (_fn, input) => input.project.fonts[0].fontData }), close: async () => {} }),
  });
  assert.deepEqual(loaded, ['font-bytes']);
  assert.equal(data, 'data:font/ttf;base64,AQID');
  assert.equal(project.fonts[0].fontData, '/api/assets/font-bytes');
});
test('job previews reuse one saved browser with isolated contexts and close only that owned session', async () => {
  let saved = null, launches = 0, contexts = 0, contextCloses = 0, browserCloses = 0, disconnects = 0;
  const connectedIds = [];
  const browser = () => ({ connected: true, sessionId: () => 'owned-session',
    createBrowserContext: async () => { contexts++; return { close: async () => { contextCloses++; }, newPage: async () => ({ setRequestInterception: async () => {}, on: () => {}, goto: async () => {}, evaluate: async () => ({ fitted: [] }) }) }; },
    disconnect: async () => { disconnects++; }, close: async () => { browserCloses++; },
  });
  const sdk = { launch: async (_binding, options) => { launches++; assert.equal(options.keep_alive, 120000); return browser(); }, connect: async (_binding, id) => { connectedIds.push(id); return browser(); } };
  const callbacks = { sdk, loadSession: async () => saved, saveSession: async id => { saved = id; } };
  const first = createJobBrowserSession({ BROWSER: {} }, callbacks);
  await previewProject({ BROWSER: {} }, initial(), { browserSession: first });
  // A fresh factory simulates Workflow suspension and resumption without keeping a socket in memory.
  const resumed = createJobBrowserSession({ BROWSER: {} }, callbacks);
  await previewProject({ BROWSER: {} }, initial(), { browserSession: resumed });
  await resumed.close();
  assert.equal(launches, 1);
  assert.equal(contexts, 2);
  assert.equal(contextCloses, 2);
  assert.equal(browserCloses, 1);
  assert.ok(disconnects >= 2);
  assert.deepEqual(connectedIds, ['owned-session', 'owned-session']);
  assert.equal(saved, null);
});
test('expired owned browser can be replaced without adopting or closing other account sessions', async () => {
  let saved = 'expired-own', launches = 0;
  const sdk = { connect: async () => { throw new Error('Session expired'); }, sessions: async () => [{ sessionId: 'other-project-session' }], launch: async () => { launches++; return { sessionId: () => 'replacement-own', close: async () => {} }; } };
  const session = createJobBrowserSession({ BROWSER: {} }, { sdk, loadSession: async () => saved, saveSession: async id => { saved = id; } });
  await session.acquire();
  assert.equal(launches, 1);
  assert.equal(saved, 'replacement-own');
  sdk.sessions = async () => [{ sessionId: 'replacement-own' }, { sessionId: 'other-project-session' }];
  await assert.rejects(session.acquire(), /Session expired/);
  assert.equal(launches, 1);
});
test('new job browser launch recovers once from the Free plan rate window and observes cancellation', async () => {
  const limited = new Error('Unable to create new browser: code:429:message:Rate limit exceeded');
  let launches = 0, waits = [], stopped = false;
  const sdk = {
    launch: async () => { if (++launches === 1) throw limited; return { sessionId: () => 'new-own' }; },
    limits: async () => ({ activeSessions: [{ id: 'unrelated-own' }], maxConcurrentSessions: 3 }),
  };
  const create = () => createJobBrowserSession({ BROWSER: {} }, { sdk, wait: async ms => { waits.push(ms); }, isStopped: async () => stopped });
  await create().acquire();
  assert.equal(launches, 2);
  assert.deepEqual(waits, [21000]);
  launches = 0;
  sdk.launch = async () => { launches++; throw limited; };
  await assert.rejects(create().acquire(), error => error === limited);
  assert.equal(launches, 2); // Only one retry, even if another account job acquired that slot.
  launches = 0;
  await assert.rejects(createJobBrowserSession({ BROWSER: {} }, { sdk, isStopped: async () => stopped, wait: async () => { stopped = true; } }).acquire(), { code: 'JOB_STOPPED' });
  assert.equal(launches, 1);
});
test('browser daily quota and concurrency limits do not trigger launch retries', async () => {
  let launches = 0, waits = 0, limitQueries = 0;
  const sdk = {
    launch: async () => { launches++; throw new Error('Unable to create new browser: code:429:message:Browser time limit exceeded for today'); },
    limits: async () => { limitQueries++; return { activeSessions: [{ id: 'other1' }, { id: 'other2' }, { id: 'other3' }], maxConcurrentSessions: 3 }; },
  };
  const create = () => createJobBrowserSession({ BROWSER: {} }, { sdk, wait: async () => { waits++; } });
  await assert.rejects(create().acquire(), /time limit/);
  assert.equal(limitQueries, 0);
  sdk.launch = async () => { launches++; throw new Error('Unable to create new browser: code:429:message:Rate limit exceeded'); };
  await assert.rejects(create().acquire(), /Rate limit/);
  assert.equal(launches, 2);
  assert.equal(limitQueries, 1);
  assert.equal(waits, 0);
});
test('failed or truncated conversation tool calls do not poison followup requests', () => {
  const pending = { role: 'assistant', content: null, tool_calls: [{ id: 'call1' }] };
  const user = { role: 'user', content: 'continue' };
  assert.deepEqual(completeConversation([{ role: 'tool', content: 'orphan' }, pending, user]), [user]);
  const tool = { role: 'tool', tool_call_id: 'call1', content: 'ok' };
  assert.deepEqual(completeConversation([pending, tool, user]), [pending, tool, user]);
});

function callbacks(responses, overrides = {}) {
  let project = initial();
  const events = [], usages = [], requests = [];
  return {
    events, usages, requests,
    client: { chat: { completions: { create: async input => { requests.push(input); return responses.shift(); } } } },
    loadProject: async () => structuredClone(project),
    saveProject: async (draft, revision) => { assert.equal(project.revision, revision); project = { ...draft, revision: revision + 1 }; return structuredClone(project); },
    loadHistory: async () => [], isStopped: async () => false,
    emit: async (type, data) => events.push({ type, data }),
    recordUsage: async usage => { usages.push(usage); return .5 - usages.reduce((sum, item) => sum + item.cost, 0); },
    ...overrides,
  };
}
const response = (message, id = 'gen1') => ({ id, usage: { cost: .001, prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } }, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] });
const env = { OPENROUTER_API_KEY: 'test-only', OPENROUTER_MODEL: 'anthropic/claude-sonnet-4.6' };
const job = { id: 'j1', userId: 'u1', projectId: 'p1', prompt: 'Create a slide', budgetUsd: .5 };
test('agent persists real provider usage, applies revision checked edits and pins caching session', async () => {
  const cb = callbacks([
    response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: 3, operations: [{ type: 'slide.add', name: 'First' }] }) } }] }),
    response({ role: 'assistant', content: 'Created your slide.' }, 'gen2'),
  ]);
  const result = await runAgent(env, job, cb);
  assert.equal(result.turns, 2);
  assert.equal(cb.usages.length, 2);
  assert.equal(cb.usages[0].cachedTokens, 8);
  assert.equal(cb.requests[0].session_id, 'u1:p1');
  assert.deepEqual(cb.requests[0].messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(cb.events.find(event => event.type === 'project').data.project.revision, 4);
});
test('stop and stale revisions terminate without silently retrying or overwriting manual edits', async () => {
  const stopped = callbacks([], { isStopped: async () => true });
  await assert.rejects(runAgent(env, job, stopped), error => error.code === 'JOB_STOPPED');
  assert.equal(stopped.requests.length, 0);
  const stale = callbacks([response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'apply_operations', arguments: JSON.stringify({ expectedRevision: 2, operations: [{ type: 'slide.add' }] }) } }] })]);
  await assert.rejects(runAgent(env, job, stale), error => error.code === 'STALE_PROJECT');
  assert.equal(stale.events.some(event => event.type === 'project'), false);
});
test('unknown provider billing and allowance exhaustion fail closed', async () => {
  const unknown = callbacks([{ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }]);
  await assert.rejects(runAgent(env, job, unknown), error => error.code === 'UNKNOWN_USAGE');
  assert.equal(unknown.usages.length, 1);
  assert.equal(unknown.usages[0].estimated, true);
  assert.equal(unknown.usages[0].cost, .5);
  assert.equal(providerUsage({ usage: {} }).cost, null);
  const exhausted = callbacks([response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'inspect_project', arguments: '{}' } }] })], { recordUsage: async () => 0 });
  await assert.rejects(runAgent(env, job, exhausted), error => error.code === 'QUOTA_EXCEEDED');
  assert.equal(exhausted.requests.length, 1);
});

test('provider call budget limits output and rejects requests that cannot fit remaining allowance', () => {
  const budget = modelCallBudget({}, [{role:'user',content:'hello'}], .1);
  assert.ok(budget.maxTokens < 4096);
  assert.equal(budget.provider.max_price.prompt, 5);
  assert.throws(() => modelCallBudget({}, [{role:'user',content:'hello'}], .0001), error => error.code === 'QUOTA_EXCEEDED');
});
test('2K image byte payload is counted once and older visual context is trimmed within the remaining budget', () => {
  // A multi-megabyte raster payload, as returned for a 2K image, must not count as millions of text tokens.
  const largeImage = `data:image/png;base64,${Buffer.alloc(3_000_000, 127).toString('base64')}`;
  const vision = url => ({ role: 'user', content: [{ type: 'text', text: 'Tool image for visual inspection.' }, { type: 'image_url', image_url: { url } }] });
  const large = modelCallBudget({}, [vision(largeImage)], .422005);
  const small = modelCallBudget({}, [vision('data:image/png;base64,AQID')], .422005);
  assert.equal(large.maxTokens, small.maxTokens);
  assert.equal(large.messages[0].content[1].image_url.url, largeImage);
  const original = [vision('/api/assets/reference'), vision(largeImage), vision(largeImage), vision('/api/assets/latest-render')];
  const budget = modelCallBudget({}, original, .422005);
  const retained = budget.messages.flatMap(message => message.content.filter(part => part.type === 'image_url'));
  assert.ok(retained.length < 4 && retained.length > 0);
  assert.equal(retained.at(-1).image_url.url, '/api/assets/latest-render');
  assert.ok(budget.maxTokens >= 256);
  assert.equal(original.flatMap(message => message.content.filter(part => part.type === 'image_url')).length, 4);
  assert.equal(budget.provider.max_price.prompt, 5);
  assert.throws(() => modelCallBudget({}, [vision(largeImage)], .1), error => error.code === 'QUOTA_EXCEEDED');
});
test('ambiguous provider timeout preserves usage reservation and never retries the call', async () => {
  const cb = callbacks([]);
  let calls = 0;
  cb.client.chat.completions.create = async () => { calls++; throw new APIConnectionTimeoutError(); };
  await assert.rejects(runAgent(env, job, cb), APIConnectionTimeoutError);
  assert.equal(calls, 1);
  assert.equal(cb.usages.length, 1);
  assert.equal(cb.usages[0].cost, .5);
  assert.equal(cb.usages[0].reason, 'provider_connection_lost');
});
test('image generation uses the current dedicated API and fixed price provider metadata', async () => {
  const cb = callbacks([
    response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'A lemon on a pale background' }) } }] }),
    response({ role: 'assistant', content: 'Image created.' }, 'gen2'),
  ]);
  let posted;
  cb.client.get = async path => {
    assert.equal(path, '/images/models/bytedance-seed/seedream-4.5/endpoints');
    return { endpoints: [{ provider_tag: 'seed', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .04 }, { billable: 'input_image', unit: 'image', cost_usd: 0 }] }] };
  };
  cb.client.post = async (path, request) => { posted = { path, ...request }; return { data: [{ b64_json: 'AQID', media_type: 'image/png' }], usage: { cost: .04 } }; };
  cb.saveAsset = async asset => { assert.deepEqual(asset.body, new Uint8Array([1, 2, 3])); return { id: 'generated1', url: '/api/assets/generated1' }; };
  cb.loadAsset = async () => ({ body: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  await runAgent(env, job, cb);
  assert.equal(posted.path, '/images');
  assert.equal(posted.body.resolution, '2K'); // Seedream 4.5 rejects 1K below its 3.7MP minimum.
  assert.equal(posted.body.aspect_ratio, '9:16');
  assert.deepEqual(posted.body.provider, { only: ['seed'], allow_fallbacks: false });
  assert.equal(cb.usages[1].cost, .04);
  assert.equal(cb.usages[1].generationId, 'image:j1:0:0');
  assert.ok(cb.requests[1].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
});
test('view_image resolves a migrated library ID through the current project and owner store', async () => {
  const project = initial();
  project.assets = [{ id: 'library-uuid', imageData: '/api/assets/stored-hash' }];
  const cb = callbacks([response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'view_image', arguments: '{"assetId":"library-uuid"}' } }] }), response({ role: 'assistant', content: 'Inspected your image.' }, 'gen2')], { loadProject: async () => project });
  const loaded = [];
  cb.loadAsset = async id => { loaded.push(id); return { body: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }; };
  await runAgent(env, job, cb);
  assert.ok(loaded.length >= 1);
  assert.ok(loaded.every(id => id === 'stored-hash'));
});
test('ambiguous image provider timeout consumes the reservation once and terminates before another model call', async () => {
  const cb = callbacks([
    response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'A lemon' }) } }] }),
  ]);
  cb.client.get = async () => ({ endpoints: [{ provider_tag: 'seed', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .04 }] }] });
  let calls = 0;
  cb.client.post = async () => { calls++; throw new APIConnectionTimeoutError(); };
  await assert.rejects(runAgent(env, job, cb), error => error.code === 'UNKNOWN_USAGE');
  assert.equal(calls, 1);
  assert.equal(cb.requests.length, 1);
  assert.equal(cb.usages.length, 2);
  assert.equal(cb.usages[1].generationId, 'unknown:j1:image:0:0');
  assert.equal(cb.usages[1].cost, .499);
  assert.equal(cb.usages[1].estimated, true);
  assert.equal(cb.events.some(event => event.type === 'asset'), false);
});
test('billing persistence failure after a priced image is fatal rather than a recoverable tool error', async () => {
  const cb = callbacks([
    response({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'A lemon' }) } }] }),
  ]);
  cb.client.get = async () => ({ endpoints: [{ provider_tag: 'seed', pricing: [{ billable: 'output_image', unit: 'image', cost_usd: .04 }] }] });
  cb.client.post = async () => ({ data: [{ b64_json: 'AQID', media_type: 'image/png' }], usage: { cost: .04 } });
  let records = 0;
  cb.recordUsage = async () => { if (++records === 2) throw new Error('Database unavailable'); return .499; };
  await assert.rejects(runAgent(env, job, cb), error => error.code === 'USAGE_RECORD_FAILED');
  assert.equal(records, 2);
  assert.equal(cb.requests.length, 1);
  assert.equal(cb.events.some(event => event.type === 'asset'), false);
});
