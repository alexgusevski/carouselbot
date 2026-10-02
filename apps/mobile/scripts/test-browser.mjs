import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

// A separate, disposable Chrome profile; never connects to the user's browser.
const profile = await mkdtemp(join(tmpdir(), 'carouselbot-mobile-browser-'));
const port = 20200 + Math.floor(Math.random() * 300);
const root = new URL('../dist/', import.meta.url);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    const relative = path === '/' || !extname(path) ? 'index.html' : path.slice(1);
    if (relative.includes('..')) throw new Error('Invalid path');
    const body = await readFile(new URL(relative, root));
    const type =
      { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.ttf': 'font/ttf' }[
        extname(relative)
      ] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const chrome = spawn(
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let socket,
  id = 0;
const pending = new Map(),
  errors = [];
async function wait(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(label);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function click(label) {
  await evaluate(
    `(()=>{const el=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!el)throw Error('Missing control '+${JSON.stringify(label)});el.click()})()`,
  );
}
try {
  const target = await wait(
    async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page',
      ),
    'Chrome did not start',
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown')
      errors.push(
        m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text,
      );
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/demo` });
  await wait(
    () => evaluate(`!!document.querySelector('iframe')?.contentWindow?.CarouselStage`),
    'Mobile stage did not mount',
  );
  await wait(
    () =>
      evaluate(`document.querySelector('iframe').contentDocument.querySelector('canvas').width>0`),
    'Mobile slide did not render',
  );
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[aria-label]')].filter(e=>/^Slide \\d+$/.test(e.getAttribute('aria-label'))).length`,
    ),
    3,
  );
  await evaluate(
    `window.stageMessages=[];window.addEventListener('message',e=>{try{const m=JSON.parse(e.data);window.stageMessages.push(m)}catch{}})`,
  );
  // Dispatch actual pointer gestures into the rendered slide, observing bridge output.
  await evaluate(
    `(()=>{const w=document.querySelector('iframe').contentWindow,d=w.document,s=d.querySelector('#stage'),r=s.getBoundingClientRect();const fire=(type,x,y,target=s)=>target.dispatchEvent(new w.PointerEvent(type,{pointerId:1,clientX:r.left+x*r.width,clientY:r.top+y*r.height,bubbles:true}));s.setPointerCapture=()=>{};fire('pointerdown',.5,.45);fire('pointermove',.55,.49);fire('pointerup',.55,.49)})()`,
  );
  const moved = await wait(
    () => evaluate(`window.stageMessages.find(m=>m.type==='layerPatch')`),
    'Touch drag did not commit',
  );
  assert.ok(moved.patch.x > 0.07);
  assert.ok(moved.patch.y > 0.3);
  await click('Edit selected layer');
  await wait(
    () => evaluate(`!!document.querySelector('[aria-label="Slide text"]')`),
    'Text inspector did not open',
  );
  await evaluate(
    `(()=>{const el=document.querySelector('[aria-label="Slide text"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify('A longer idea,\nmade by hand.')});el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  );
  await wait(
    () => evaluate(`document.querySelector('[aria-label="Slide text"]').value.includes('longer')`),
    'Text editing failed',
  );
  await click('Done editing');
  await click('Add slide');
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[aria-label]')].filter(e=>/^Slide \\d+$/.test(e.getAttribute('aria-label'))).length`,
    ),
    4,
  );
  await click('Undo');
  await wait(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-label]')].filter(e=>/^Slide \\d+$/.test(e.getAttribute('aria-label'))).length===3`,
      ),
    'Undo did not restore slide list',
  );
  await click('Redo');
  await wait(
    () =>
      evaluate(
        `[...document.querySelectorAll('[aria-label]')].filter(e=>/^Slide \\d+$/.test(e.getAttribute('aria-label'))).length===4`,
      ),
    'Redo did not restore slide list',
  );
  await click('Slide 1');
  await new Promise((resolve) => setTimeout(resolve, 800));
  await evaluate(
    `document.querySelector('iframe').contentWindow.CarouselStage.receive({type:'export',format:'png',requestId:'browser-proof'})`,
  );
  const exported = await wait(
    () => evaluate(`window.stageMessages.find(m=>m.requestId==='browser-proof')`),
    'Full-resolution export failed',
  );
  assert.equal(exported.type, 'exported', exported.message);
  const png = Buffer.from(exported.data.split(',')[1], 'base64');
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1920);
  await writeFile('/tmp/carouselbot-mobile-export.png', png);
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/carouselbot-mobile-editor.png', Buffer.from(screenshot.data, 'base64'));
  const promptBounds = await evaluate(
    `(()=>{const r=document.querySelector('[aria-label="Ask the agent to edit your carousel"]').getBoundingClientRect();return {top:r.top,bottom:r.bottom}})()`,
  );
  assert.ok(
    promptBounds.top > 700 && promptBounds.bottom <= 844,
    'Composer should stay at the bottom',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        mobileStage: true,
        touchDrag: true,
        textInspector: true,
        undoRedo: true,
        fullResolutionExport: '1080×1920',
        bottomComposer: true,
        screenshot: '/tmp/carouselbot-mobile-editor.png',
      },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
