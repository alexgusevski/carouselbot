import { escapeHtml, duplicateProjectData } from './editor-model.mjs';
import { state, app, activeProject, setLayerSelection } from './editor-state.mjs';

export function createProductUI({ client, projects, renderEditor, toast, addAssets }) {
  const chats = new Map();
  let pollTimer;
  let visibleProjectId;
  let saveError = null;
  const busy = (job) => ['queued', 'running'].includes(job?.status);
  const attachableAssets = (project) => (project.assets || []).filter((asset) => !asset.videoData && /^data:image\/(png|jpeg|webp|gif)[;,]/i.test(asset.imageData || ''));
  const monthlyCredits = () => Number(client.config.allowanceCredits) || 500;
  const requestCredits = () => Number(client.config.jobBudgetCredits) || 50;
  function generationNotice() {
    if (!client.config.agentAvailable) return '<p class="chat-note">AI assistance is not available yet.</p>';
    if (client.account?.canGenerate !== false) return '';
    if (!client.account.billing?.active) return '<p class="chat-note">Subscribe to create with AI. Manual editing is always available.</p><button class="button button--quiet chat-subscribe" data-product-action="billing" type="button">Subscribe · $19/month</button>';
    const end = Number(client.account.billing.periodEnd);
    const renewal = Number.isFinite(end) && end > Date.now() ? ` Your allowance renews ${new Date(end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.` : '';
    return `<p class="chat-note">You need ${requestCredits()} credits available to start a request.${escapeHtml(renewal)}</p>`;
  }
  function accountMarkup() {
    if (!client.configured) return '';
    if (!client.user) return '<button class="button button--quiet" data-product-action="sign-in" type="button">Sign in</button>';
    return `<button class="button button--quiet" data-product-action="billing" type="button">${client.account?.billing?.active ? `${Number(client.account.credits) || 0} credits` : 'Get credits'}</button><button class="button button--quiet" data-product-action="account" type="button">Account</button><button class="button button--quiet" data-product-action="sign-out" type="button">Sign out</button>`;
  }
  function bindAccounts(root = app) {
    root.querySelectorAll('[data-product-action]').forEach((button) => button.addEventListener('click', async () => {
      try {
        const action = button.dataset.productAction;
        if (action === 'sign-in') client.signIn();
        if (action === 'sign-out') { await projects.flushPendingSave(); await client.signOut(); }
        if (action === 'account') client.manageAccount();
        if (action === 'billing') {
          if (!client.config.billingAvailable) throw new Error('Payments are not available yet.');
          await client.billing(Boolean(client.account?.billing?.active));
        }
      } catch (error) { toast(error.message); }
    }));
  }
  function mountAccount() {
    const actions = app.querySelector('.header-actions');
    if (!actions) return;
    actions.insertAdjacentHTML('beforeend', `<div class="product-account">${accountMarkup()}</div>`);
    bindAccounts(actions);
    updateSaveStatus(saveError);
  }
  function updateSaveStatus(error) {
    saveError = error;
    app.querySelector('[data-product-action="retry-save"]')?.remove();
    if (!error || !client.user) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button button--quiet';
    button.dataset.productAction = 'retry-save'; button.textContent = 'Unsaved · Retry';
    button.title = error.message || 'Your last changes have not saved.';
    button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = 'Saving…';
      try { await projects.flushPendingSave(); updateSaveStatus(null); }
      catch (failure) { updateSaveStatus(failure); toast(failure.message); }
    });
    app.querySelector('.product-account')?.prepend(button);
  }
  async function mountLocalImport() {
    if (!client.user || !state.db) return;
    const dashboard = app.querySelector('.dashboard');
    if (!dashboard) return;
    const importKey = `carouselbot:imports:${client.user.id}`;
    let imported = {};
    try { imported = JSON.parse(localStorage.getItem(importKey) || '{}'); } catch { /* A private window can still import projects. */ }
    const local = (await new Promise((resolve, reject) => {
      const read = state.db.transaction('project-catalog').objectStore('project-catalog').getAll();
      read.onsuccess = () => resolve(read.result || []); read.onerror = () => reject(read.error);
    }).catch(() => [])).filter((project) => imported[project.id] !== project.updatedAt);
    if (!local.length || !dashboard.isConnected) return;
    const notice = document.createElement('div'); notice.className = 'browser-project-import';
    notice.innerHTML = '<p>Your browser also has local projects.</p><button class="button button--quiet" type="button">Import browser projects</button>';
    const button = notice.querySelector('button');
    button.addEventListener('click', async () => {
      button.disabled = true; button.textContent = 'Importing…';
      try {
        for (const metadata of local) {
          const project = await new Promise((resolve, reject) => {
            const read = state.db.transaction('projects').objectStore('projects').get(metadata.id);
            read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
          });
          if (project) {
            await client.cloudStore.put(duplicateProjectData(project, { name: project.name }), 0);
            imported[metadata.id] = metadata.updatedAt;
            try { localStorage.setItem(importKey, JSON.stringify(imported)); } catch { /* Originals remain safe if import tracking is unavailable. */ }
          }
        }
        await projects.refreshDashboardProjects(); toast('Browser projects copied to your account.');
      } catch (error) { button.disabled = false; button.textContent = 'Import browser projects'; toast(error.message); }
    });
    dashboard.prepend(notice);
  }
  function renderLanding() {
    clearTimeout(pollTimer); visibleProjectId = null;
    state.activeProjectId = null; state.activeSlideId = null; setLayerSelection([]);
    document.title = 'CarouselBot';
    app.innerHTML = `<header class="app-header"><a class="brand" href="/" aria-label="CarouselBot"><span class="brand-mark" aria-hidden="true"></span><span class="brand-copy"><strong>CarouselBot</strong><small>AI carousel maker</small></span></a><div class="header-actions">${accountMarkup()}<a class="button button--primary" href="/dashboard">Open editor</a></div></header>
      <main class="product-landing"><section class="landing-intro"><p class="eyebrow">CarouselBot</p><h1>Make a carousel.<br>Just describe it.</h1><p>Turn an idea and your images into editable slides. Refine them in chat, adjust them on the canvas, and download them ready to post.</p><div class="landing-actions"><a class="button button--primary" href="/dashboard">Start creating</a><a class="button button--quiet" href="/dashboard">Use your own AI via MCP</a></div></section>
      <section class="landing-preview" aria-label="Example carousel"><article><span>01 / 03</span><h2>A small idea.<br>A good place<br>to start.</h2><p>Make something worth sharing.</p></article><article><span>02 / 03</span><h2>Write it.<br>Shape it.<br>Make it yours.</h2><p>Every word and layer stays editable.</p></article><article><span>03 / 03</span><h2>Ready<br>to post.</h2><p>Download full-size slides.</p></article></section>
      <section class="landing-details"><div><h2>Chat and canvas</h2><p>Ask for a first draft or a specific change. You can also move images, rewrite text, and edit every slide yourself.</p></div><div><h2>Your images, your projects</h2><p>Add screenshots and photos. Sign in to save projects and continue where you left off.</p></div><div><h2>Export when you’re ready</h2><p>Download 1080px-wide slides. Connect an external AI agent through MCP if you prefer.</p></div></section>
      <section class="landing-plan" aria-label="Pricing"><div><h2>$19 / month</h2><p>${monthlyCredits()} AI credits each month. Each request can use up to ${requestCredits()} credits.</p><p>Manual editing and MCP are free.</p></div>${client.user ? `<button class="button button--primary" data-product-action="billing" type="button">${client.account?.billing?.active ? 'Manage subscription' : 'Subscribe'}</button>` : client.configured ? '<button class="button button--primary" data-product-action="sign-in" type="button">Sign in to subscribe</button>' : '<a class="button button--primary" href="/dashboard">Open editor</a>'}</section>
      <footer class="landing-footer"><span>CarouselBot</span><a href="mailto:kontakt@beundraab.se">Contact</a></footer></main>`;
    bindAccounts();
  }
  function chatFor(id) {
    if (!chats.has(id)) chats.set(id, { messages: [], job: null, draft: '', attachments: [], loaded: false, loading: false, submitting: false, requestId: null, error: '' });
    return chats.get(id);
  }
  function chatMarkup(project) {
    const chat = chatFor(project.id);
    const status = chat.error || (busy(chat.job) ? chat.job.status === 'queued' ? 'Waiting to start…' : 'Making changes…' : chat.job?.status === 'failed' ? `${chat.job.error || 'The agent could not finish. Please retry.'} Any saved changes are still available.` : chat.job?.status === 'stopped' ? 'Stopped.' : '');
    return `<aside class="project-chat" aria-label="Carousel chat"><div class="chat-heading"><h2>Chat</h2><button class="icon-button" data-chat-action="close" type="button" aria-label="Collapse chat">×</button></div>
      <div class="chat-messages" aria-live="polite">${chat.messages.map((message) => `<article class="chat-message chat-message--${message.role === 'user' ? 'user' : 'assistant'}"><span>${message.role === 'user' ? 'You' : 'CarouselBot'}</span><p>${escapeHtml(message.content || '')}</p></article>`).join('') || '<p class="chat-empty">Describe the carousel you want to make. Add images from your assets if you have them.</p>'}</div>
      <p class="chat-status" role="status">${escapeHtml(status)}</p>
      ${client.user ? `<form class="chat-composer"><label class="visually-hidden" for="chat-prompt">Message</label><textarea id="chat-prompt" placeholder="Make a carousel about…" rows="3" maxlength="10000" ${chat.submitting ? 'disabled' : ''}>${escapeHtml(chat.draft)}</textarea>
      ${attachableAssets(project).length ? `<label class="chat-asset-label">Include images<select class="chat-attachments" multiple aria-label="Images to include">${attachableAssets(project).map((asset) => `<option value="${escapeHtml(asset.id)}" ${chat.attachments.includes(asset.id) ? 'selected' : ''}>${escapeHtml(asset.name || 'Image')}</option>`).join('')}</select></label>` : ''}
      <div class="chat-actions"><button class="button button--quiet" data-chat-action="attach" type="button">Add images</button><button class="button button--quiet" data-chat-action="undo" type="button" ${chat.undoing ? 'disabled' : ''}>${chat.undoing ? 'Undoing…' : 'Undo'}</button>${busy(chat.job) ? '<button class="button button--quiet" data-chat-action="stop" type="button">Stop</button>' : `<button class="button button--primary" type="submit" ${chat.submitting || !client.config.agentAvailable || client.account?.canGenerate === false ? 'disabled' : ''}>${chat.submitting ? 'Sending…' : 'Send'}</button>`}</div></form><input class="hidden-input" data-chat-upload type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple />${generationNotice()}` : `<div class="chat-sign-in"><p>Sign in to create and edit with CarouselBot.</p>${accountMarkup()}</div>`}</aside>`;
  }
  function paintChat() {
    const project = activeProject();
    const panel = app.querySelector('.project-chat');
    if (!project || !panel) return;
    const focusedPrompt = document.activeElement === panel.querySelector('textarea');
    const selection = focusedPrompt ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const previousMessages = panel.querySelector('.chat-messages');
    const scrollTop = previousMessages.scrollTop;
    const followLatest = previousMessages.scrollHeight - previousMessages.clientHeight - scrollTop < 32;
    panel.outerHTML = chatMarkup(project); bindChat();
    const messages = app.querySelector('.chat-messages');
    if (messages) messages.scrollTop = followLatest ? messages.scrollHeight : scrollTop;
    if (focusedPrompt) {
      const prompt = app.querySelector('.project-chat textarea');
      if (prompt && !prompt.disabled) { prompt.focus({ preventScroll: true }); prompt.setSelectionRange(...selection); }
    }
  }
  async function loadChat(id) {
    const chat = chatFor(id);
    if (chat.loading || !client.user) return;
    chat.loading = true;
    try {
      await projects.flushPendingSave();
      const result = await client.request(`/api/projects/${encodeURIComponent(id)}/chat`);
      Object.assign(chat, { messages: result.messages || [], job: result.job, loaded: true, error: '' });
      if (visibleProjectId === id) { paintChat(); schedulePoll(id); }
    } catch (error) { chat.error = error.message; if (visibleProjectId === id) paintChat(); }
    finally { chat.loading = false; }
  }
  function schedulePoll(id) {
    clearTimeout(pollTimer);
    if (visibleProjectId !== id || !busy(chatFor(id).job)) return;
    pollTimer = setTimeout(() => void poll(id), 1500);
  }
  async function poll(id) {
    if (visibleProjectId !== id) return;
    const chat = chatFor(id);
    try {
      const result = await client.request(`/api/jobs/${encodeURIComponent(chat.job.id)}`);
      chat.job = result.job; chat.messages = result.messages || chat.messages;
      chat.error = '';
      const project = await client.hydrate(result.project);
      const local = state.projects.find((p) => p.id === id);
      // Do not repaint over a manual edit that is still waiting to save.
      if (project && local && project.revision > local.revision && !projects.hasPendingSave()) {
        if (!chat.historyRecorded) { projects.recordHistory(local); chat.historyRecorded = true; }
        state.projects[state.projects.indexOf(local)] = project;
        if (!project.slides.some((s) => s.id === state.activeSlideId)) state.activeSlideId = project.slides[0]?.id || null;
        if (visibleProjectId === id) renderEditor();
      } else if (visibleProjectId === id) paintChat();
      if (!busy(chat.job)) {
        await client.refreshAccount();
        if (visibleProjectId === id) {
          paintChat();
          const account = app.querySelector('.product-account');
          if (account) { account.innerHTML = accountMarkup(); bindAccounts(account); }
        }
      }
    } catch (error) { chat.error = error.message; if (visibleProjectId === id) paintChat(); }
    schedulePoll(id);
  }
  function bindChat() {
    const panel = app.querySelector('.project-chat');
    const project = activeProject();
    if (!panel || !project) return;
    const chat = chatFor(project.id);
    panel.querySelector('textarea')?.addEventListener('input', (event) => { chat.draft = event.target.value; chat.requestId = null; });
    panel.querySelector('.chat-attachments')?.addEventListener('change', (event) => { chat.attachments = [...event.target.selectedOptions].map((o) => o.value); chat.requestId = null; });
    panel.querySelector('[data-chat-action="close"]').addEventListener('click', () => {
      state.productChatCollapsed = true; renderEditor();
    });
    panel.querySelector('[data-chat-action="undo"]')?.addEventListener('click', async () => {
      document.activeElement?.blur();
      if (chat.undoing) return;
      chat.undoing = true; chat.error = ''; paintChat();
      try {
        if (projects.hasUndo?.()) await projects.undo();
        else if (chat.job?.canUndo && !busy(chat.job)) {
          await projects.flushPendingSave();
          if (activeProject()?.id !== project.id) return;
          if (projects.hasUndo?.()) await projects.undo();
          else {
            const current = state.projects.find((item) => item.id === project.id);
            const result = await client.request(`/api/jobs/${encodeURIComponent(chat.job.id)}/undo`, { method: 'POST', body: { expectedRevision: current.revision } });
            chat.job = result.job;
            await projects.reloadProjectFromDb(project.id);
          }
        }
      } catch (error) {
        chat.error = error.message;
        if (error.code === 'STALE_PROJECT') {
          chat.job.canUndo = false;
          await projects.reloadProjectFromDb(project.id).catch(() => {});
        }
      } finally { chat.undoing = false; if (visibleProjectId === project.id) paintChat(); }
    });
    panel.querySelector('[data-chat-action="attach"]')?.addEventListener('click', () => panel.querySelector('[data-chat-upload]').click());
    panel.querySelector('[data-chat-upload]')?.addEventListener('change', async (event) => {
      const before = new Set(project.assets.map((a) => a.id));
      await addAssets(event);
      chat.attachments.push(...attachableAssets(project).filter((a) => !before.has(a.id)).map((a) => a.id));
      chat.requestId = null;
      paintChat();
    });
    panel.querySelector('[data-chat-action="stop"]')?.addEventListener('click', async () => {
      try { await client.request(`/api/jobs/${encodeURIComponent(chat.job.id)}/stop`, { method: 'POST' }); await poll(project.id); }
      catch (error) { toast(error.message); }
    });
    panel.querySelector('form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (chat.submitting || busy(chat.job) || !chat.draft.trim() || client.account?.canGenerate === false) return;
      chat.submitting = true; chat.error = ''; paintChat();
      try {
        if (chat.attachments.length > 8) throw new Error('Include up to eight images per request.');
        await projects.flushPendingSave();
        const attachments = [];
        for (const id of chat.attachments) {
          const asset = project.assets.find((a) => a.id === id);
          if (!asset) continue;
          const storedAsset = asset.cloudImageUrl?.match(/^\/api\/assets\/([\w-]+)$/);
          if (storedAsset) { attachments.push(storedAsset[1]); continue; }
          const blob = await (await fetch(asset.imageData)).blob();
          const file = new File([blob], asset.name || 'image', { type: blob.type });
          attachments.push((await client.upload(file)).id);
        }
        chat.requestId ||= crypto.randomUUID();
        const result = await client.request(`/api/projects/${encodeURIComponent(project.id)}/jobs`, { method: 'POST', body: { prompt: chat.draft.trim(), attachmentIds: attachments, expectedRevision: project.revision, requestId: chat.requestId } });
        chat.job = result.job; chat.historyRecorded = false;
        chat.messages.push({ role: 'user', content: chat.draft.trim() }); chat.draft = ''; chat.attachments = []; chat.requestId = null;
        schedulePoll(project.id);
      } catch (error) {
        chat.error = error.message;
        if (error.status === 402) await client.refreshAccount().catch(() => {});
        if (error.code === 'JOB_ACTIVE') await loadChat(project.id);
        if (error.code === 'STALE_PROJECT') await projects.reloadProjectFromDb(project.id).catch(() => {});
      }
      finally { chat.submitting = false; if (visibleProjectId === project.id) paintChat(); }
    });
    bindAccounts(panel);
  }
  function mount(view) {
    clearTimeout(pollTimer); visibleProjectId = view === 'editor' ? activeProject()?.id : null;
    mountAccount();
    if (view !== 'editor') { void mountLocalImport(); return; }
    if (!client.configured) return;
    const shell = app.querySelector('.editor-shell');
    if (client.user) {
      const validateFiles = (event, files) => {
        try { [...files].forEach((file) => client.validateUpload?.(file)); }
        catch (error) {
          event.preventDefault(); event.stopImmediatePropagation();
          app.querySelectorAll('.is-file-drop-target').forEach((target) => target.classList.remove('is-file-drop-target'));
          toast(error.message); return false;
        }
        return true;
      };
      for (const input of app.querySelectorAll('input[type="file"]')) {
        input.addEventListener('change', (event) => { if (!validateFiles(event, input.files)) input.value = ''; }, { capture: true });
        if (['photo-upload', 'asset-upload'].includes(input.id)) input.accept = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm';
        if (input.id === 'slide-background-upload') input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      }
      shell.addEventListener('drop', (event) => validateFiles(event, event.dataTransfer?.files || []), { capture: true });
    }
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'button button--quiet';
    toggle.textContent = 'Chat'; toggle.dataset.action = 'toggle-chat'; toggle.setAttribute('aria-expanded', String(!state.productChatCollapsed));
    app.querySelector('.header-actions')?.prepend(toggle);
    toggle.addEventListener('click', () => { state.productChatCollapsed = !state.productChatCollapsed; renderEditor(); });
    if (state.productChatCollapsed) return;
    shell.classList.add('editor-shell--chat');
    shell.insertAdjacentHTML('afterbegin', chatMarkup(activeProject())); bindChat();
    const chat = chatFor(visibleProjectId);
    if (!chat.loaded) void loadChat(visibleProjectId); else schedulePoll(visibleProjectId);
  }
  return { renderLanding, mount, updateSaveStatus };
}
