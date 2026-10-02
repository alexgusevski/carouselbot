import { WorkflowEntrypoint } from 'cloudflare:workers';
import { api } from './api.mjs';
import { runAgent } from './agent.mjs';
import { agentFailureMessage } from './agent-checkpoint.mjs';
import { statement, getProject, saveProject, loadAsset, saveAsset, cleanupUnusedAssets } from './store.mjs';
import { emit, history, recordUsage, finishJob, browserSessionForJob, startJob } from './jobs.mjs';
import { dollars } from './core.mjs';
import { productHeaders } from './security-headers.mjs';
import { legacyShares } from './legacy-shares.mjs';
import { directShares } from './direct-shares.mjs';
export class CarouselAgentWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const row = await step.do('load-job', () => statement(this.env, 'SELECT * FROM jobs WHERE id=?', event.payload.jobId).first());
    if (!row || !['queued','running'].includes(row.status)) return;
    try {
      await step.do('start-job', () => startJob(this.env, row));
      const job = { id: row.id, userId: row.user_id, projectId: row.project_id, prompt: row.prompt, attachments: JSON.parse(row.attachments), budgetUsd: dollars(row.budget), spentUsd: dollars(row.spent) };
      const isStopped = async () => { const latest = await statement(this.env, 'SELECT stopped,status FROM jobs WHERE id=?', row.id).first(); return !latest || latest.stopped || !['queued','running'].includes(latest.status); };
      const result = await runAgent(this.env, job, {
        step,
        isStopped,
        loadProject: () => getProject(this.env, row.user_id, row.project_id),
        saveProject: async (project, expectedRevision) => {
          if (await isStopped()) throw Object.assign(new Error('Agent stopped.'), { code: 'STOPPED' });
          return saveProject(this.env, row.user_id, row.project_id, project, expectedRevision, { jobId: row.id });
        },
        loadHistory: () => history(this.env, row),
        emit: (type, data, id) => emit(this.env, row.id, type, data, id),
        recordUsage: (usage) => recordUsage(this.env, row, usage),
        loadAsset: (id) => loadAsset(this.env, row.user_id, id),
        saveAsset: (asset) => saveAsset(this.env, row.user_id, { ...asset, jobId: row.id }),
        loadBrowserSession: () => browserSessionForJob(this.env, row.id),
        saveBrowserSession: (sessionId) => emit(this.env, row.id, 'browser_session', { sessionId }),
      });
      await step.do('complete-job', () => finishJob(this.env, row, result?.stopped || false ? 'stopped' : 'completed'));
    } catch (error) {
      const stopped = ['STOPPED', 'JOB_STOPPED'].includes(error.code) || Boolean((await statement(this.env, 'SELECT stopped FROM jobs WHERE id=?', row.id).first())?.stopped);
      const message = stopped ? null : agentFailureMessage(error.code);
      await step.do('fail-job', () => finishJob(this.env, row, stopped ? 'stopped' : 'failed', message, { uncertainUsage: error.code === 'USAGE_RECORD_FAILED' }));
      console.error('Agent workflow failed', { jobId: row.id, code: error.code, message: error.message });
    }
  }
}
export default {
  async scheduled(event, env) { await cleanupUnusedAssets(env); },
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/shares')) return env.PRODUCT_SHARING_MODE === 'direct' ? directShares(request, env) : legacyShares(request, env);
    if (new URL(request.url).pathname.startsWith('/api/')) return api(request, env);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(productHeaders(env))) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
