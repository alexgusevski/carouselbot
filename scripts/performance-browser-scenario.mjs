// Small, capped fixtures in the smoke test's disposable Chrome profile.
export async function verifyEditorMemory({ cdp, evaluate, waitFor, pageUrl }) {
  const fixture = await evaluate(cdp, `(async () => {
    const store = await import('/src/project-store.mjs');
    const { solidBackgroundDataUrl } = await import('/src/slide-background.mjs');
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 768;
    const context = canvas.getContext('2d');
    const assets = [];
    for (let index = 0; index < 8; index++) {
      for (let y = 0; y < canvas.height; y += 32) for (let x = 0; x < canvas.width; x += 32) {
        context.fillStyle = 'hsl(' + ((x + y + index * 41) % 360) + ' 70% 55%)';
        context.fillRect(x, y, 32, 32);
      }
      assets.push({ id: 'photo-' + index, name: 'Photo ' + index,
        imageData: canvas.toDataURL('image/jpeg', .85), width: canvas.width, height: canvas.height });
    }
    canvas.width = canvas.height = 0;
    const bytes = JSON.stringify(assets).length * 4;
    if (bytes > 8 * 1048576) throw new Error('Fixture exceeds 8 MiB safety cap');
    const ids = [];
    for (let index = 0; index < 4; index++) {
      const project = { id: 'memory-fixture-' + index, name: 'Memory fixture ' + index, revision: 1,
        folderPath: '/Memory regression', createdAt: Date.now(), updatedAt: Date.now(), aspectRatio: '9:16',
        assets, fonts: [], slides: [{ id: 'cover-' + index, name: 'Cover', aspectRatio: '9:16',
          width: 1080, height: 1920, imageData: solidBackgroundDataUrl('#123456'), backgroundColor: '#123456',
          texts: [], overlays: [] }] };
      await store.putProject(project, { broadcast: false });
      ids.push(project.id);
    }
    const measure = async (read) => {
      const start = performance.now();
      const projects = (await read()).filter(project => ids.includes(project.id));
      return { milliseconds: Math.round(performance.now() - start), serializedBytes: JSON.stringify(projects).length };
    };
    return { full: await measure(store.getAllProjects), catalog: await measure(store.getProjectCatalog) };
  })()`);
  if (fixture.catalog.serializedBytes > fixture.full.serializedBytes / 20) throw new Error('Catalog retained original media');
  await cdp.send('Page.navigate', { url: pageUrl + '/folders/Memory%20regression' });
  await waitFor(() => evaluate(cdp, `document.querySelectorAll('.project-card img.thumb-rendered').length === 4`), 'Cold catalog previews did not render');
  const dashboard = await evaluate(cdp, `(async () => {
    const { state } = await import('/src/editor-state.mjs');
    return { catalogOnly: state.projects.every(project => project.__catalog),
      originalImages: document.querySelectorAll('.dashboard img[src^="data:"]').length,
      loadedPreviews: state.thumbnailUrls.size + state.projectCoverUrls.size };
  })()`);
  if (!dashboard.catalogOnly || dashboard.originalImages) throw new Error('Dashboard retained or mounted original media');
  await cdp.send('HeapProfiler.collectGarbage');
  const dashboardHeap = await cdp.send('Runtime.getHeapUsage');

  const instrumentation = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__originalProjectReads = 0;
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(...args) {
      if (this.name === 'projects') window.__originalProjectReads++;
      return originalGet.apply(this, args);
    };
  ` });
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(() => evaluate(cdp, `document.querySelectorAll('.project-card img.thumb-rendered').length === 4`), 'Stored previews did not restore');
  const warmReads = await evaluate(cdp, 'window.__originalProjectReads');
  if (warmReads !== 0) throw new Error('Warm dashboard read original projects: ' + warmReads);
  await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: instrumentation.identifier });

  await evaluate(cdp, `(async () => {
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(...args) {
      const request = originalGet.apply(this, args);
      if (this.name !== 'projects') return request;
      return new Proxy(request, {
        get(target, property) { return Reflect.get(target, property, target); },
        set(target, property, value) {
          target[property] = property === 'onsuccess' ? event => setTimeout(() => value(event), 50) : value;
          return true;
        },
      });
    };
    try {
      document.querySelector('[data-project-id="memory-fixture-0"]').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      document.querySelector('[data-action="home"]').click();
      await new Promise(resolve => setTimeout(resolve, 150));
      const { state } = await import('/src/editor-state.mjs');
      if (!document.querySelector('.dashboard') || !state.projects.every(project => project.__catalog)) {
        throw new Error('Cancelled navigation retained a loaded project or reopened the editor');
      }
    } finally { IDBObjectStore.prototype.get = originalGet; }
  })()`);
  await cdp.send('Page.navigate', { url: pageUrl + '/folders/Memory%20regression' });
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-project-id="memory-fixture-0"]'))`), 'Navigation fixture did not restore folder');
  await evaluate(cdp, `(() => {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "connect-src 'self'";
    document.head.appendChild(policy);
    window.__memoryCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__memoryCspViolations.push(event.blockedURI));
    document.querySelector('[data-project-id="memory-fixture-0"]').click();
  })()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-asset-preview-id][src^="blob:"]'))`), 'Editor asset thumbnails did not render');
  const editor = await evaluate(cdp, `(async () => {
    const { state } = await import('/src/editor-state.mjs');
    const originals = state.projects.filter(project => !project.__catalog);
    const source = originals[0];
    const images = [...document.querySelectorAll('[data-asset-preview-id][src]')];
    await Promise.all(images.map(image => image.decode()));
    return { loadedProjectCount: originals.length, originalWidth: source.assets[0].width,
      originalsIntact: source.assets.length === 8 && source.assets.every(asset => asset.imageData.startsWith('data:image/jpeg')),
      maxThumbnailWidth: Math.max(...images.map(image => image.naturalWidth)),
      assetPreviews: images.length, cspViolations: window.__memoryCspViolations };
  })()`);
  if (editor.loadedProjectCount !== 1 || !editor.originalsIntact || editor.originalWidth !== 1024
    || editor.maxThumbnailWidth > 256 || editor.cspViolations.length) throw new Error('Editor retained full library or decoded original asset rail: ' + JSON.stringify(editor));
  await evaluate(cdp, `document.querySelector('[data-action="home"]').click()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('.dashboard'))`), 'Returning to dashboard failed');
  const returned = await evaluate(cdp, `(async () => {
    const { state } = await import('/src/editor-state.mjs');
    return { catalogOnly: state.projects.every(project => project.__catalog),
      decodedAssets: document.querySelectorAll('[data-asset-preview-id][src]').length };
  })()`);
  if (!returned.catalogOnly || returned.decodedAssets) throw new Error('Leaving editor retained original projects or asset thumbnails');
  await evaluate(cdp, `(async () => {
    const { deleteProjectFromDb } = await import('/src/project-store.mjs');
    for (let index = 0; index < 4; index++) await deleteProjectFromDb('memory-fixture-' + index, { broadcast: false });
  })()`);
  await cdp.send('Page.navigate', { url: pageUrl });
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('.dashboard'))`), 'Fixture cleanup did not return to dashboard');
  return { ...fixture, dashboard, dashboardJsHeapMiB: Math.round(dashboardHeap.usedSize / 1048576), warmOriginalReads: warmReads, editor, returned };
}
