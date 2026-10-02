export function bytesDataUrl(body, mimeType) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:${mimeType};base64,${btoa(binary)}`;
}
export function decodeImageDataUrl(url) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(url));
  if (!match || match[2].length > 28_000_000) throw new Error('Image provider returned an unsupported image.');
  return { mimeType: match[1], body: Uint8Array.from(atob(match[2]), character => character.charCodeAt(0)) };
}
async function hydrateProject(project, loadAsset) {
  const hydrated = structuredClone(project);
  const loaded = new Map();
  async function imageData(source) {
    if (String(source).startsWith('data:image/')) return source;
    // Only resolve authenticated application assets, never arbitrary model-supplied URLs.
    const path = String(source || '').split('?')[0];
    const match = /(?:^|\/)api\/assets\/([A-Za-z0-9_-]+)$/.exec(path);
    if (!match) throw new Error('This image must be uploaded before the agent can render it.');
    if (!loaded.has(match[1])) {
      const asset = await loadAsset(match[1]);
      loaded.set(match[1], bytesDataUrl(asset.body, asset.mimeType));
    }
    return loaded.get(match[1]);
  }
  for (const asset of hydrated.assets || []) asset.imageData = await imageData(asset.imageData);
  for (const slide of hydrated.slides) slide.imageData = await imageData(slide.imageData);
  for (const font of hydrated.fonts || []) {
    if (font.fontData && !font.fontData.startsWith('data:')) font.fontData = await imageData(font.fontData);
  }
  return hydrated;
}
/** Reconnect only the browser launched by this job; never adopt an account-wide session. */
export function createJobBrowserSession(env, { loadSession = async () => null, saveSession = async () => {}, isStopped = async () => false, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), sdk } = {}) {
  let sessionId;
  const client = async () => sdk || (await import('@cloudflare/puppeteer')).default;
  async function savedId() {
    if (sessionId === undefined) sessionId = await loadSession();
    return sessionId;
  }
  async function checkStopped() {
    if (await isStopped()) throw Object.assign(new Error('Stopped.'), { code: 'JOB_STOPPED' });
  }
  async function launch(puppeteer) {
    await checkStopped();
    try { return await puppeteer.launch(env.BROWSER, { keep_alive: 120000 }); }
    catch (error) {
      // The installed SDK drops Retry-After. Free accounts allow one new browser per 20 seconds.
      // Retry once after that window only for launch rate limits, never the daily usage quota.
      if (!/\b429\b/.test(error.message) || !/rate limit exceeded/i.test(error.message)) throw error;
      const limits = await puppeteer.limits(env.BROWSER);
      if (limits.activeSessions.length >= limits.maxConcurrentSessions) throw error;
      await wait(21000);
      await checkStopped();
      return puppeteer.launch(env.BROWSER, { keep_alive: 120000 });
    }
  }
  return {
    async acquire() {
      await checkStopped();
      const puppeteer = await client();
      if (await savedId()) {
        try { return await puppeteer.connect(env.BROWSER, sessionId); }
        catch (error) {
          // A failed connection is not proof of expiration. Preserve a live owned session on transient errors.
          const active = await puppeteer.sessions(env.BROWSER);
          if (active.some(item => item.sessionId === sessionId)) throw error;
          sessionId = null;
          await saveSession(null);
        }
      }
      const browser = await launch(puppeteer);
      sessionId = browser.sessionId();
      try { await saveSession(sessionId); }
      catch (error) { await browser.close(); sessionId = null; throw error; }
      return browser;
    },
    async close() {
      if (!await savedId()) return;
      const puppeteer = await client();
      let browser;
      try {
        browser = await puppeteer.connect(env.BROWSER, sessionId);
        await browser.close();
        sessionId = null;
        await saveSession(null);
      } finally {
        if (browser?.connected) await browser.disconnect();
      }
    },
  };
}
/** Real browser measurements and the application's own renderer. No project is published. */
export async function previewProject(env, project, { loadAsset, slideId, changedTextIds = [], imageData, launch, browserSession } = {}) {
  if (!env.BROWSER && !launch) throw new Error('Slide previews require the configured Browser Run binding.');
  const origin = new URL(env.APP_ORIGIN || 'https://carousel.bot').origin;
  const hydrated = await hydrateProject(project, loadAsset);
  const puppeteer = launch || browserSession ? null : await import('@cloudflare/puppeteer');
  const browser = browserSession ? await browserSession.acquire() : await (launch || puppeteer.default.launch)(env.BROWSER);
  let context;
  try {
    context = browserSession ? await browser.createBrowserContext() : null;
    const page = await (context || browser).newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(`${origin}/`)) request.continue();
      else request.abort();
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.evaluate(evaluateProjectPreview, { origin, project: hydrated, slideId, changedTextIds, imageData });
  } finally {
    if (browserSession) {
      try { if (context) await context.close(); }
      finally { await browser.disconnect(); }
    } else await browser.close();
  }
}

export async function evaluateProjectPreview({ origin, project, slideId, changedTextIds = [], imageData }) {
  const model = await import(`${origin}/src/editor-model.mjs`);
  const renderer = await import(`${origin}/src/slide-renderer.mjs`);
  const fonts = await import(`${origin}/src/project-fonts.mjs`);
  const result = { fitted: [] };
  if (imageData) return renderer.getImageDimensions(imageData);
  await fonts.ensureProjectFontsLoaded(project);
  const measure = document.createElement('canvas').getContext('2d');
  for (const slide of project.slides) for (const text of slide.texts || []) {
    if (!changedTextIds.includes(text.id)) continue;
    const size = text.size;
    measure.font = fonts.textCanvasFont(project, text, size);
    if ('fontVariationSettings' in measure) measure.fontVariationSettings = fonts.textFontVariationCss(project, text);
    const dimensions = model.slideCanvasDimensions(project, slide);
    const linesBox = text.style === 'boxed' && text.backgroundShape !== 'full';
    const fullBox = text.style === 'boxed' && text.backgroundShape === 'full';
    const inset = linesBox ? size * (model.TEXT_BOX_EDGE_PADDING * 2 + model.BOX_HORIZONTAL_PADDING * 2) : fullBox ? size * .76 : size * .32;
    const lines = model.wrapText(measure, text.text, Math.max(1, text.width * dimensions.width - inset));
    const lineHeight = size * (linesBox ? model.BOX_TEXT_LINE_HEIGHT : model.TEXT_LINE_HEIGHT);
    const contentHeight = linesBox ? Math.max(size * model.BOX_LINE_HEIGHT, (lines.length - 1) * lineHeight + size * model.BOX_LINE_HEIGHT) + size * .36 : lines.length * lineHeight + size * (fullBox ? .76 : .28);
    text.height = Math.max(.045, contentHeight / dimensions.height);
    if (text.height > 1) throw new Error('Text cannot fit. Shorten it, widen it, or split it across slides.');
    text.x = model.clamp(text.x, 0, 1 - text.width);
    text.y = model.clamp(text.y, 0, 1 - text.height);
    result.fitted.push({ id: text.id, height: text.height, x: text.x, y: text.y, lineCount: lines.length });
  }
  if (slideId) {
    const slide = project.slides.find(item => item.id === slideId);
    if (!slide) throw new Error('Slide not found.');
    const size = model.scaleCanvasDimensions(project, 540, slide);
    const canvas = await renderer.renderSlideCanvas(slide, size.width, size.height, project);
    result.imageData = canvas.toDataURL('image/png');
  }
  return result;
}
