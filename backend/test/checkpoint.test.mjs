import test from 'node:test';
import assert from 'node:assert/strict';
import { agentCheckpoint, agentFailureMessage } from '../agent-checkpoint.mjs';
import { runAgent } from '../agent.mjs';

function serializingStep() {
  const persisted = new Map();
  return { async do(name, config, callback) {
    assert.equal(config.retries.limit, 0);
    if (persisted.has(name)) return structuredClone(persisted.get(name));
    try {
      const result = structuredClone(await callback());
      persisted.set(name, result);
      return result;
    } catch (error) {
      // Mirrors the observed Workflow failure: Error.code is not retained.
      throw new Error(error.message);
    }
  } };
}

test('terminal failure codes survive serialization and replay without repeating a provider step', async () => {
  const step = serializingStep();
  await assert.rejects(step.do('unprotected', { retries: { limit: 0 } }, async () => {
    throw Object.assign(new Error('Budget reached'), { code: 'QUOTA_EXCEEDED' });
  }), error => error.code === undefined);
  for (const code of ['QUOTA_EXCEEDED', 'STALE_PROJECT', 'USAGE_RECORD_FAILED', 'JOB_STOPPED']) {
    let calls = 0;
    const callback = async () => { calls++; throw Object.assign(new Error('Terminal failure'), { code }); };
    await assert.rejects(agentCheckpoint(step, code, callback), error => error.code === code);
    await assert.rejects(agentCheckpoint(step, code, callback), error => error.code === code);
    assert.equal(calls, 1);
  }
  assert.match(agentFailureMessage('QUOTA_EXCEEDED'), /saved edits.*follow-up/);
  assert.deepEqual(await agentCheckpoint(step, 'successful-old-result', async () => ({ value: 1 })), { value: 1 });
});

test('agent budget failure reaches Workflow settlement with its code before any provider call', async () => {
  let providerCalls = 0;
  const job = { id: 'job', userId: 'user', projectId: 'project', prompt: 'Make slides', budgetUsd: .0001 };
  await assert.rejects(runAgent({ OPENROUTER_API_KEY: 'test' }, job, {
    step: serializingStep(),
    client: { chat: { completions: { create: async () => { providerCalls++; } } } },
    loadProject: async () => ({ id: 'project', name: 'Test', slides: [], assets: [], revision: 1 }),
    loadHistory: async () => [], isStopped: async () => false, emit: async () => {},
    browserSession: { close: async () => {} },
  }), error => error.code === 'QUOTA_EXCEEDED' && /follow-up/.test(agentFailureMessage(error.code)));
  assert.equal(providerCalls, 0);
});
