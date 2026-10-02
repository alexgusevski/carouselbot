const terminalCodes = new Set(['STOPPED', 'JOB_STOPPED', 'STALE_PROJECT', 'QUOTA_EXCEEDED', 'UNKNOWN_USAGE', 'USAGE_RECORD_FAILED']);
const noRetries = { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' };

export async function agentCheckpoint(step, name, callback) {
  if (!step) return callback();
  const result = await step.do(name, noRetries, async () => {
    try { return await callback(); }
    catch (error) {
      if (!terminalCodes.has(error.code)) throw error;
      // Workflow errors can lose custom properties. Persist terminal failures as
      // serializable results, then throw outside the step so settlement sees code.
      return { __carouselbotFailure: { code: error.code, message: String(error.message).slice(0, 1000) } };
    }
  });
  const failure = result?.__carouselbotFailure;
  if (failure && terminalCodes.has(failure.code)) throw Object.assign(new Error(failure.message), { code: failure.code });
  return result;
}

export function agentFailureMessage(code) {
  if (code === 'STALE_PROJECT') return 'You edited the carousel while the agent was working. Review it and send another message.';
  if (code === 'QUOTA_EXCEEDED') return 'This request reached its agent budget. Your saved edits remain; send a follow-up to continue.';
  return 'The agent could not finish. Please retry.';
}
