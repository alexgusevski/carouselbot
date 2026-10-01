export async function verifyProductChat({ cdp, evaluate, waitFor }) {
  await evaluate(cdp, `(async () => {
    const editor = await import('/src/editor.mjs');
    const { state, activeProject } = await import('/src/editor-state.mjs');
    const store = await import('/src/project-store.mjs');
    const { createProductUI } = await import('/src/product-ui.mjs');
    const created = await window.carouselBotAgent.execute({ type: 'project.create', name: 'Hosted chat regression' });
    await window.carouselBotAgent.execute({ type: 'project.open', projectId: created.projectId });
    const current = activeProject();
    const image = document.createElement('canvas'); image.width = image.height = 1;
    current.assets.push({ id: 'private-chat-image', name: 'Private image', imageData: image.toDataURL(), cloudImageUrl: '/api/assets/private-image', width: 1, height: 1 });
    window.__productFixture = { current, requests: [], flushes: 0, stopped: false, undoCount: 0 };
    const fixture = window.__productFixture;
    let ui;
    const client = {
      configured: true, user: { id: 'fixture-user' }, config: { agentAvailable: true, jobBudgetCredits: 50 }, account: { credits: 500, canGenerate: true },
      hydrate: async project => project, refreshAccount: async () => {},
      request: async (path, options = {}) => {
        fixture.requests.push({ path, body: options.body });
        if (path.endsWith('/chat')) {
          if (!fixture.saveCompleted) throw new Error('Chat read raced the initial project save');
          return { messages: [], job: null };
        }
        if (path.endsWith('/jobs')) {
          if (!fixture.lostResponse) { fixture.lostResponse = true; throw new Error('Network response lost'); }
          return { job: { id: 'fixture-job', status: 'running' } };
        }
        if (path.endsWith('/stop')) { fixture.stopped = true; return { job: { id: 'fixture-job', status: 'stopped' } }; }
        if (path === '/api/jobs/fixture-job') {
          if (!fixture.generated) {
            fixture.generated = structuredClone(current);
            fixture.generated.name = 'Agent made this carousel';
            fixture.generated.revision += 1;
            await store.putProject(fixture.generated, { expectedRevision: current.revision });
          }
          return { job: { id: 'fixture-job', status: fixture.stopped ? 'stopped' : 'running' }, project: fixture.generated, messages: [{ role: 'user', content: 'Make a test carousel' }, { role: 'assistant', content: '<script>plain text</script>' }] };
        }
        throw new Error('Unexpected fixture route: ' + path);
      },
    };
    ui = createProductUI({
      client,
      projects: {
        recordHistory: editor.recordHistory,
        flushPendingSave: async () => { fixture.flushes++; await editor.flushPendingSave(); fixture.saveCompleted = true; },
        hasPendingSave: () => false,
        hasUndo: editor.hasUndo,
        undo: async () => { fixture.undoCount++; await editor.undo(); },
      },
      renderEditor: () => { editor.renderEditor(); ui.mount('editor'); },
      toast: editor.toast,
      addAssets: async () => {},
    });
    ui.mount('editor');
    fixture.ui = ui;
    fixture.client = client;
    fixture.render = () => { editor.renderEditor(); ui.mount('editor'); };
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('.project-chat textarea'))`), 'Hosted chat did not mount');
  const allowance = await evaluate(cdp, `(() => {
    const fixture = window.__productFixture;
    fixture.client.account = { credits: 0, canGenerate: false, billing: { active: false } };
    fixture.render();
    const subscribe = Boolean(document.querySelector('.chat-subscribe')) && document.querySelector('.chat-composer [type="submit"]').disabled;
    fixture.client.account = { credits: 0, canGenerate: false, billing: { active: true, periodEnd: Date.now() + 86400000 } };
    fixture.render();
    const renewal = document.querySelector('.chat-note').textContent.includes('Your allowance renews') && !document.querySelector('.chat-subscribe');
    fixture.client.account = { credits: 500, canGenerate: true, billing: { active: true } };
    fixture.render();
    return { subscribe, renewal };
  })()`);
  if (!allowance.subscribe || !allowance.renewal) throw new Error('Chat allowance state failed: ' + JSON.stringify(allowance));
  await evaluate(cdp, `(() => {
    window.__productFixture.ui.updateSaveStatus(new Error('Temporary network failure'));
    document.querySelector('[data-product-action="retry-save"]').click();
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `!document.querySelector('[data-product-action="retry-save"]')`), 'Retry save did not clear unsaved status');
  await evaluate(cdp, `(() => {
    const textarea = document.querySelector('.project-chat textarea');
    textarea.value = 'Make a test carousel'; textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const images = document.querySelector('.chat-attachments'); images.options[0].selected = true; images.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.chat-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `document.querySelector('.chat-status')?.textContent === 'Network response lost'`), 'A lost job response did not leave the draft retryable');
  await evaluate(cdp, `document.querySelector('.chat-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`);
  await waitFor(() => evaluate(cdp, `document.querySelector('.project-title-input')?.value === 'Agent made this carousel'`), 'Agent job did not apply an editable project');
  const outcome = await evaluate(cdp, `({
    submitted: window.__productFixture.requests.find(r => r.path.endsWith('/jobs'))?.body,
    flushes: window.__productFixture.flushes,
    escaped: document.querySelector('.chat-messages').textContent.includes('<script>plain text</script>') && !document.querySelector('.chat-messages script'),
    stopVisible: Boolean(document.querySelector('[data-chat-action="stop"]')),
    requestIds: window.__productFixture.requests.filter(r => r.path.endsWith('/jobs')).map(r => r.body.requestId),
  })`);
  if (outcome.submitted?.prompt !== 'Make a test carousel' || !outcome.submitted.requestId || !outcome.flushes || !outcome.escaped || !outcome.stopVisible || outcome.requestIds.length !== 2 || outcome.requestIds[0] !== outcome.requestIds[1] || outcome.submitted.attachmentIds[0] !== 'private-image') throw new Error('Hosted chat integration failed: ' + JSON.stringify(outcome));
  await evaluate(cdp, `document.querySelector('[data-chat-action="stop"]').click()`);
  await waitFor(() => evaluate(cdp, `window.__productFixture.stopped && document.querySelector('.chat-status')?.textContent === 'Stopped.'`), 'Stop did not cancel the hosted job');
  await evaluate(cdp, `document.querySelector('[data-chat-action="undo"]').click()`);
  await waitFor(() => evaluate(cdp, `document.querySelector('.project-title-input')?.value === 'Hosted chat regression'`), 'Hosted agent changes were not undoable');
  await evaluate(cdp, `(async () => {
    const editor = await import('/src/editor.mjs');
    const { createProductUI } = await import('/src/product-ui.mjs');
    const fixture = window.__productFixture;
    fixture.client.request = async () => ({ messages: [{ role: 'assistant', content: 'Background set. Now rendering.' }], job: { id: 'failed-resumed-job', status: 'failed', error: 'The agent could not finish. Please retry.' } });
    fixture.ui = createProductUI({ client: fixture.client,
      projects: { flushPendingSave: editor.flushPendingSave, hasPendingSave: () => false, hasUndo: editor.hasUndo, undo: editor.undo },
      renderEditor: () => fixture.render(), toast: editor.toast, addAssets: async () => {},
    });
    fixture.render = () => { editor.renderEditor(); fixture.ui.mount('editor'); };
    fixture.render();
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `document.querySelector('.chat-status')?.textContent === 'The agent could not finish. Please retry. Any saved changes are still available.'`), 'A failed job resumed after reload hid its error or saved changes status');
  const resumedFailure = await evaluate(cdp, `(() => {
    window.__productFixture.render();
    return document.querySelector('.chat-status')?.textContent === 'The agent could not finish. Please retry. Any saved changes are still available.' && !document.querySelector('.chat-composer [type="submit"]').disabled && !document.querySelector('[data-chat-action="stop"]');
  })()`);
  if (!resumedFailure) throw new Error('Resumed failure status did not persist or allow a new request');
  await evaluate(cdp, `(async () => {
    const editor = await import('/src/editor.mjs');
    const store = await import('/src/project-store.mjs');
    const { state, history, activeProject } = await import('/src/editor-state.mjs');
    const { createProductUI } = await import('/src/product-ui.mjs');
    const fixture = window.__productFixture;
    fixture.beforeJob = structuredClone(activeProject());
    const completed = structuredClone(activeProject());
    completed.name = 'Finished while tab closed'; completed.revision += 1;
    await store.putProject(completed, { expectedRevision: fixture.beforeJob.revision });
    state.projects[state.projects.findIndex(project => project.id === completed.id)] = completed;
    history.past = history.past.filter(project => project.id !== completed.id);
    history.future = history.future.filter(project => project.id !== completed.id);
    fixture.completedJob = { id: 'completed-resumed-job', status: 'completed', canUndo: true };
    fixture.durableUndoRequests = [];
    fixture.client.request = async (path, options = {}) => {
      if (path.endsWith('/chat')) return { messages: [{ role: 'assistant', content: 'Done.' }], job: fixture.completedJob };
      if (path === '/api/jobs/completed-resumed-job/undo') {
        fixture.durableUndoRequests.push(options.body);
        if (options.body.expectedRevision !== activeProject().revision) throw new Error('Undo did not send the current revision');
        const restored = { ...structuredClone(fixture.beforeJob), revision: activeProject().revision + 1 };
        await store.putProject(restored, { expectedRevision: activeProject().revision });
        fixture.completedJob = { ...fixture.completedJob, canUndo: false };
        return { job: fixture.completedJob, project: restored };
      }
      throw new Error('Unexpected durable Undo fixture route: ' + path);
    };
    fixture.ui = createProductUI({ client: fixture.client,
      projects: { flushPendingSave: editor.flushPendingSave, hasPendingSave: () => false, hasUndo: editor.hasUndo, undo: editor.undo,
        reloadProjectFromDb: async id => { await editor.reloadProjectFromDb(id); fixture.render(); },
      },
      renderEditor: () => fixture.render(), toast: editor.toast, addAssets: async () => {},
    });
    fixture.render();
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `document.querySelector('.project-title-input')?.value === 'Finished while tab closed' && document.querySelector('.chat-messages')?.textContent.includes('Done.') && !document.querySelector('[data-chat-action="undo"]').disabled`), 'A completed job after reload did not expose durable Undo');
  await evaluate(cdp, `document.querySelector('[data-chat-action="undo"]').click()`);
  await waitFor(() => evaluate(cdp, `window.__productFixture.durableUndoRequests.length === 1 && document.querySelector('.project-title-input')?.value === 'Hosted chat regression' && !window.__productFixture.completedJob.canUndo && !document.querySelector('[data-chat-action="undo"]').disabled`), 'Durable Undo did not restore the before-job project after reload');
  await evaluate(cdp, `(async () => {
    const editor = await import('/src/editor.mjs');
    document.querySelector('[data-action="home"]').click();
    await editor.flushPendingSave();
    delete window.__productFixture;
    return true;
  })()`);
}

export async function verifyCloudProjectCreation({ cdp, evaluate, waitFor }) {
  await evaluate(cdp, `(async () => {
    const editor = await import('/src/editor.mjs');
    const store = await import('/src/project-store.mjs');
    const { state } = await import('/src/editor-state.mjs');
    const { createProductClient } = await import('/src/product-client.mjs');
    const { createProductUI } = await import('/src/product-ui.mjs');
    const prior = { config: window.CAROUSELBOT_CONFIG, clerk: window.Clerk, fetch: window.fetch, append: document.head.append, projects: [...state.projects] };
    const fixture = window.__cloudCreateFixture = { prior, writes: [], chatReads: [], documents: new Map() };
    window.CAROUSELBOT_CONFIG = { product: { clerkPublishableKey: 'pk_test_' + btoa('clerk.example$') } };
    window.Clerk = { user: { id: 'cloud-creation-fixture' }, session: { getToken: async () => 'fixture-token' }, load: async () => {}, addListener: () => {} };
    document.head.append = function(node) {
      if (node.src?.includes('clerk.example/npm/')) { queueMicrotask(() => node.onload()); return; }
      return prior.append.call(this, node);
    };
    window.fetch = async (url, options = {}) => {
      if (url === '/api/account') return Response.json({ credits: 500, canGenerate: true });
      if (String(url).startsWith('/api/projects/') && options.method === 'PUT') {
        const body = JSON.parse(options.body); fixture.writes.push(body);
        if (!Number.isInteger(body.expectedRevision)) return Response.json({ message: 'Expected revision is required.' }, { status: 400 });
        const actualRevision = fixture.documents.get(body.project.id)?.revision || 0;
        if (actualRevision !== body.expectedRevision) return Response.json({ code: 'STALE_PROJECT', actualRevision }, { status: 409 });
        if (fixture.failNextSave) { fixture.failNextSave = false; return Response.json({ error: 'Temporary upload failure' }, { status: 503 }); }
        await new Promise(resolve => setTimeout(resolve, 100));
        const project = { ...body.project, revision: actualRevision + 1 };
        fixture.documents.set(project.id, project);
        return Response.json({ project });
      }
      if (String(url).endsWith('/chat')) {
        const id = String(url).split('/')[3]; fixture.chatReads.push(id);
        if (!fixture.documents.has(id)) return Response.json({ error: 'Project not found.' }, { status: 404 });
        return Response.json({ messages: [], job: null });
      }
      return prior.fetch(url, options);
    };
    const client = createProductClient(); await client.init();
    store.configureCloudStore(client.cloudStore);
    fixture.ui = createProductUI({ client,
      projects: { flushPendingSave: editor.flushPendingSave, hasPendingSave: () => false, recordHistory: editor.recordHistory, hasUndo: editor.hasUndo, undo: editor.undo },
      renderEditor: editor.renderEditor, toast: editor.toast, addAssets: async () => {},
    });
    document.querySelector('[data-action="new-project"]').click();
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('.project-title-input'))`), 'Native cloud project creation did not open editor');
  await evaluate(cdp, `window.__cloudCreateFixture.ui.mount('editor')`);
  await waitFor(() => evaluate(cdp, `window.__cloudCreateFixture.chatReads.length === 1`), 'Cloud chat did not wait for the native initial save');
  await evaluate(cdp, `(async () => {
    const fixture = window.__cloudCreateFixture; fixture.failNextSave = true;
    const image = document.createElement('canvas'); image.width = image.height = 1;
    const blob = await new Promise(resolve => image.toBlob(resolve));
    const files = new DataTransfer(); files.items.add(new File([blob], 'Retryable photo.png', { type: 'image/png' }));
    const input = document.querySelector('#asset-upload'); input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `window.__cloudCreateFixture.writes.length === 2 && document.querySelector('.toast')?.textContent === 'Temporary upload failure'`), 'Native cloud asset failure was not retained for retry');
  await evaluate(cdp, `(() => {
    const fixture = window.__cloudCreateFixture; fixture.ui.mount('editor'); fixture.ui.updateSaveStatus(new Error('Temporary upload failure'));
    document.querySelector('[data-product-action="retry-save"]').click();
    return true;
  })()`);
  await waitFor(() => evaluate(cdp, `window.__cloudCreateFixture.writes.length === 3 && !document.querySelector('[data-product-action="retry-save"]')`), 'Failed cloud asset save did not recover through Retry');
  const outcome = await evaluate(cdp, `(async () => {
    const fixture = window.__cloudCreateFixture;
    const { state, activeProject } = await import('/src/editor-state.mjs');
    const editor = await import('/src/editor.mjs');
    const store = await import('/src/project-store.mjs');
    await editor.flushPendingSave();
    const result = { expectedRevision: fixture.writes[0]?.expectedRevision, currentRevision: activeProject().revision, persisted: fixture.documents.has(activeProject().id), chatError: document.querySelector('.chat-status').textContent,
      assetRetried: fixture.writes[1].expectedRevision === 1 && fixture.writes[2].expectedRevision === 1 && fixture.documents.get(activeProject().id).assets.length === 1 };
    store.configureCloudStore(null);
    window.CAROUSELBOT_CONFIG = fixture.prior.config; window.Clerk = fixture.prior.clerk; window.fetch = fixture.prior.fetch; document.head.append = fixture.prior.append;
    state.projects = fixture.prior.projects;
    state.activeProjectId = null; state.activeSlideId = null;
    delete window.__cloudCreateFixture;
    window.history.replaceState({}, '', '/dashboard'); editor.renderDashboard();
    return result;
  })()`);
  if (outcome.expectedRevision !== 0 || outcome.currentRevision !== 2 || !outcome.persisted || outcome.chatError || !outcome.assetRetried) throw new Error('Cloud initial-save integration failed: ' + JSON.stringify(outcome));
}
