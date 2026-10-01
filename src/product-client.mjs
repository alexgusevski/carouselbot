// Browser-only account and API boundary. Provider secrets stay on the server.
export function createProductClient() {
  let config = {};
  let clerk = null;
  let account = null;
  let accountId = null;
  const assetData = new Map();
  const mediaSources = new WeakMap();
  function assertAccount() {
    if (!accountId || clerk?.user?.id !== accountId) throw new Error('Your account changed. Reload to continue.');
  }
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    assertAccount();
    const token = await clerk?.session?.getToken();
    if (!token) throw new Error('Sign in to use your account.');
    assertAccount();
    const response = await fetch(path, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body instanceof Blob ? {} : body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => ({}));
    assertAccount();
    if (!response.ok) {
      const error = new Error(result.message || result.error || (response.status === 409 ? 'This project changed. Reloaded the latest version.' : 'Could not complete the request.'));
      Object.assign(error, { code: result.code, project: result.project, status: response.status });
      throw error;
    }
    return result;
  }
  async function hydrate(project) {
    if (!project) return null;
    assertAccount();
    const resolve = async (value) => {
      if (!value?.startsWith('/api/assets/')) return value;
      if (!assetData.has(value)) assetData.set(value, (async () => {
        const token = await clerk.session.getToken();
        assertAccount();
        const response = await fetch(value, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('Could not load project image.');
        const blob = await response.blob();
        assertAccount();
        return new Promise((yes, no) => {
          const reader = new FileReader(); reader.onload = () => yes(reader.result); reader.onerror = no; reader.readAsDataURL(blob);
        });
      })().catch((error) => { assetData.delete(value); throw error; }));
      while (assetData.size > 8) assetData.delete(assetData.keys().next().value);
      return assetData.get(value);
    };
    for (const asset of project.assets || []) {
      if (asset.imageData?.startsWith('/api/assets/')) { asset.cloudImageUrl = asset.imageData; asset.imageData = await resolve(asset.imageData); }
      if (asset.videoData?.startsWith('/api/assets/')) { asset.cloudVideoUrl = asset.videoData; asset.videoData = await resolve(asset.videoData); }
    }
    for (const slide of project.slides || []) {
      if (slide.imageData?.startsWith('/api/assets/')) { slide.cloudImageUrl = slide.imageData; slide.imageData = await resolve(slide.imageData); }
      if (slide.videoData?.startsWith('/api/assets/')) { slide.cloudVideoUrl = slide.videoData; slide.videoData = await resolve(slide.videoData); }
    }
    for (const font of project.fonts || []) {
      if (font.fontData?.startsWith('/api/assets/')) { font.cloudFontUrl = font.fontData; font.fontData = await resolve(font.fontData); }
    }
    for (const item of [...(project.assets || []), ...(project.slides || []), ...(project.fonts || [])]) {
      mediaSources.set(item, { imageData: item.imageData, videoData: item.videoData, fontData: item.fontData });
    }
    return project;
  }
  function serializable(project) {
    const copy = structuredClone(project);
    for (const group of ['assets', 'slides', 'fonts']) for (let index = 0; index < (copy[group] || []).length; index++) {
      const item = copy[group][index];
      const original = project[group][index];
      for (const [field, cloudField] of [['imageData', 'cloudImageUrl'], ['videoData', 'cloudVideoUrl'], ['fontData', 'cloudFontUrl']]) {
        if (item[cloudField] && mediaSources.get(original)?.[field] === original[field]) item[field] = item[cloudField];
        delete item[cloudField];
      }
    }
    return copy;
  }
  async function loadScript(src, publishableKey) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => reject(new Error('Sign-in could not load. Please reload.')), 15000);
      script.src = src; script.async = true; script.crossOrigin = 'anonymous';
      if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error('Sign-in could not load. Please reload.')); };
      document.head.append(script);
    });
  }
  async function init({ legacy = false } = {}) {
    const supplied = window.CAROUSELBOT_CONFIG?.product;
    if (supplied) config = supplied;
    else {
      // Static/local installs deliberately have no account API.
      if (legacy || ['localhost', '127.0.0.1'].includes(location.hostname)) return;
      const response = await fetch('/api/config').catch(() => null);
      if (response?.ok) config = await response.json();
    }
    if (!config.clerkPublishableKey) return;
    const domain = atob(config.clerkPublishableKey.split('_')[2]).replace(/\$$/, '');
    if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error('Invalid sign-in configuration.');
    await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, config.clerkPublishableKey);
    clerk = window.Clerk;
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    accountId = clerk.user?.id || null;
    const initialUser = clerk.user?.id;
    clerk.addListener(({ user }) => {
      if (user?.id !== initialUser) location.reload();
    }, { skipInitialEmit: true });
    if (clerk.user) account = await request('/api/account');
  }
  return {
    init, request, hydrate,
    get config() { return config; }, get user() { return clerk?.user?.id === accountId ? clerk.user : null; }, get account() { return account; },
    get configured() { return Boolean(config.clerkPublishableKey); },
    validateUpload(file) {
      if (!accountId) return;
      const type = String(file.type || '').toLowerCase();
      if ((type.startsWith('image/') && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))
        || (type.startsWith('video/') && !['video/mp4', 'video/webm'].includes(type))
        || (!type && /\.(svg|avif|heic|heif|mov)$/i.test(file.name || ''))) {
        throw new Error('Saved projects support PNG, JPEG, WebP and GIF images, and MP4 or WebM videos.');
      }
    },
    async refreshAccount() { account = await request('/api/account'); return account; },
    signIn() { clerk?.openSignIn({ fallbackRedirectUrl: '/dashboard', signUpFallbackRedirectUrl: '/dashboard' }); },
    signOut() { return clerk?.signOut({ redirectUrl: '/' }); },
    manageAccount() { clerk?.openUserProfile(); },
    cloudStore: {
      get accountId() { return accountId; },
      async folders() { return (await request('/api/folders')).folders; },
      async createFolder(path) { await request('/api/folders', { method: 'POST', body: { path } }); },
      async moveFolder(sourceFolderPath, destinationFolderPath) { const result = await request('/api/folders/move', { method: 'POST', body: { sourceFolderPath, destinationFolderPath } }); return Promise.all(result.projects.map(hydrate)); },
      async list() { return (await request('/api/projects')).projects; },
      async get(id) { try { return hydrate((await request(`/api/projects/${encodeURIComponent(id)}`)).project); } catch (error) { if (error.status === 404) return null; throw error; } },
      async put(project, expectedRevision) {
        expectedRevision ??= project.revision ?? 0;
        const submitted = new Map([...project.assets || [], ...project.slides || [], ...project.fonts || []].map((item) => [item, { imageData: item.imageData, videoData: item.videoData, fontData: item.fontData }]));
        const saved = (await request(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', body: { project: serializable(project), expectedRevision } })).project;
        for (const group of ['assets', 'slides', 'fonts']) {
          const field = group === 'fonts' ? 'fontData' : 'imageData';
          const cloudField = group === 'fonts' ? 'cloudFontUrl' : 'cloudImageUrl';
          for (const item of project[group] || []) {
            const stored = saved[group]?.find((other) => other.id === item.id);
            if (stored?.[field]?.startsWith('/api/assets/') && item[field] === submitted.get(item)?.[field]) item[cloudField] = stored[field];
            if (stored?.videoData?.startsWith('/api/assets/') && item.videoData === submitted.get(item)?.videoData) item.cloudVideoUrl = stored.videoData;
            mediaSources.set(item, submitted.get(item));
          }
        }
        return saved;
      },
      async delete(id, expectedRevision) { return request(`/api/projects/${encodeURIComponent(id)}?expectedRevision=${expectedRevision ?? ''}`, { method: 'DELETE' }); },
    },
    async upload(file) { return request('/api/assets', { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'image') } }); },
    async billing(portal = false) {
      const { url } = await request(`/api/billing/${portal ? 'portal' : 'checkout'}`, { method: 'POST' });
      const destination = new URL(url);
      if (destination.protocol !== 'https:') throw new Error('Invalid checkout URL.');
      location.assign(destination.href);
    },
  };
}
