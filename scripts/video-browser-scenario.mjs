import { mkdir, writeFile } from "node:fs/promises";

export async function verifyVideoSlides({ cdp, evaluate, waitFor, outputDirectory }) {
  await evaluate(cdp, `(async () => {
    const project = await window.carouselBotAgent.execute({ type: 'project.create', name: 'Video sample' });
    await window.carouselBotAgent.execute({ type: 'project.open', projectId: project.projectId });
  })()`);
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-action="video-sample"]'))`), "Video sample button missing");
  await evaluate(cdp, `document.querySelector('[data-action="video-sample"]').click()`, { userGesture: true });
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('[data-video-time]'))`), "Sample video did not appear", 20000);
  const sample = await evaluate(cdp, `(async () => {
    const { activeSlide, activeProject } = await import('/src/editor-state.mjs');
    const slide = activeSlide();
    const asset = activeProject().assets[0];
    window.__sampleVideoAsset = asset;
    window.__sampleVideoSlide = slide;
    window.__sampleVideoProject = activeProject();
    return { duration: asset.duration, texts: slide.texts.length, videos: document.querySelectorAll('[data-slide-video]').length,
      label: document.querySelector('[data-action="export"]').textContent };
  })()`);
  if (sample.duration < 9.8 || sample.duration > 10.5 || sample.texts !== 5 || !sample.videos || !sample.label.includes('MP4')) throw new Error(`Invalid video sample: ${JSON.stringify(sample)}`);
  await evaluate(cdp, `document.querySelector('[data-video-play]').click()`);
  await evaluate(cdp, `(() => {
    const range = document.querySelector('[data-video-time]'); range.value = 6;
    range.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate(cdp, `[...document.querySelectorAll('[data-slide-video]')].every(v => v.paused && Math.abs(v.currentTime - 6) < 0.15)`), "Timeline did not seek all video layers");
  await evaluate(cdp, `document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))`);
  await waitFor(() => evaluate(cdp, `Number(document.querySelector('[data-video-time]').value) > 6.2`), "Space did not resume playback");
  await evaluate(cdp, `document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))`);
  // Space must win over the last-clicked asset and native button activation.
  const pressSpace = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  };
  await evaluate(cdp, `document.querySelector('.asset-item').focus()`);
  await pressSpace();
  const assetSpace = await evaluate(cdp, `({ playing: document.querySelector('[data-video-play]').getAttribute('aria-pressed'), modal: Boolean(document.querySelector('.asset-preview-modal')), badge: Boolean(document.querySelector('.asset-video-badge')), cursor: getComputedStyle(document.querySelector('[data-video-time]'), '::-webkit-slider-thumb').cursor })`);
  if (assetSpace.playing !== 'true' || assetSpace.modal || !assetSpace.badge || assetSpace.cursor !== 'pointer') throw new Error(`Asset Space or video styling regression: ${JSON.stringify(assetSpace)}`);
  await evaluate(cdp, `document.querySelector('[data-action="export"]').focus()`);
  await pressSpace();
  if (!await evaluate(cdp, `document.querySelector('[data-video-play]').getAttribute('aria-pressed') === 'false' && !document.querySelector('[data-action="export"]').disabled`)) throw new Error('Space activated the focused download button');
  const typing = await evaluate(cdp, `(() => {
    const input = document.querySelector('.project-title-input');
    const key = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    input.dispatchEvent(key);
    return !key.defaultPrevented && document.querySelector('[data-video-play]').getAttribute('aria-pressed') === 'false';
  })()`);
  if (!typing) throw new Error('Space was intercepted in a text field');
  await evaluate(cdp, `document.querySelector('.asset-item').click()`, { userGesture: true });
  await waitFor(() => evaluate(cdp, `Boolean(document.querySelector('.asset-preview-modal video')?.currentTime > 0.1)`), 'Clicking the video asset did not play its preview');
  await pressSpace();
  if (!await evaluate(cdp, `document.querySelector('.asset-preview-modal video').paused && document.querySelector('[data-video-play]').getAttribute('aria-pressed') === 'false'`)) throw new Error('Space in the video preview changed the slide playback');
  await evaluate(cdp, `(() => {
    window.__closedPreviewVideo = document.querySelector('.asset-preview-modal video');
    document.querySelector('.asset-preview-close').click();
  })()`);
  await waitFor(() => evaluate(cdp, `!document.querySelector('.asset-preview-modal') && !window.__closedPreviewVideo.hasAttribute('src')`), 'Video preview did not release its decoder on close');
  await evaluate(cdp, `(() => {
    window.__videoOriginalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      window.__sampleExportName = this.download;
      void fetch(this.href).then(response => response.blob()).then(blob => { window.__sampleExport = blob; });
    };
    document.querySelector('[data-action="export"]').click();
  })()`, { userGesture: true });
  await waitFor(() => evaluate(cdp, `Boolean(window.__sampleExport)`), "Native MP4 download did not finish", 25000);
  const bytes = await evaluate(cdp, `(async () => {
    HTMLAnchorElement.prototype.click = window.__videoOriginalAnchorClick;
    if (!window.__sampleExportName.endsWith('.mp4')) throw new Error('Video download filename is not MP4');
    return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(window.__sampleExport); });
  })()`);
  if (!bytes?.startsWith('data:video/mp4;base64,')) throw new Error('Export did not produce MP4');
  const mp4Bytes = Buffer.from(bytes.split(',')[1], 'base64');
  if (!mp4Bytes.includes(Buffer.from('avc1')) || mp4Bytes.includes(Buffer.from('avc3'))) {
    throw new Error('MP4 export must use Apple-compatible avc1, not avc3');
  }
  const metadata = await evaluate(cdp, `(async () => {
    const { loadVideo, releaseVideo } = await import('/src/video-media.mjs');
    const url = URL.createObjectURL(window.__sampleExport);
    const video = await loadVideo(url);
    const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    // Decode from beginning to end, not only metadata/the first frame.
    await new Promise((resolve, reject) => {
      video.loop = false;
      video.addEventListener('ended', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Export failed during playback')), { once: true });
      video.play().catch(reject);
    });
    video.currentTime = 5;
    await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    releaseVideo(video); URL.revokeObjectURL(url);
    return result;
  })()`);
  if (metadata.width !== 1080 || metadata.height !== 1920 || metadata.duration < 9.8 || metadata.duration > 11) throw new Error(`MP4 metadata invalid: ${JSON.stringify(metadata)}`);
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(`${outputDirectory}/prompt-to-app.mp4`, Buffer.from(bytes.split(',')[1], 'base64'));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${outputDirectory}/video-editor.png`, Buffer.from(shot.data, 'base64'));
  }
  // Exercise the actual clipboard importer and deduplication, not the agent protocol.
  await evaluate(cdp, `(async () => {
    const response = await fetch(window.__sampleVideoAsset.videoData);
    const blob = await response.blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'pasted-demo.mp4', { type: 'video/mp4' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(() => evaluate(cdp, `window.__sampleVideoSlide.overlays.length === 2`), "Pasted video did not become an editable layer");
  // Native upload also supports video backgrounds.
  await evaluate(cdp, `(async () => {
    const blob = await (await fetch(window.__sampleVideoAsset.videoData)).blob();
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'background.mp4', { type: 'video/mp4' }));
    const input = document.querySelector('#photo-upload'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate(cdp, `window.__sampleVideoProject.slides.length === 2 && Boolean(window.__sampleVideoProject.slides[1].videoData)`), "Video background upload failed");
  await waitFor(() => evaluate(cdp, `new Promise(resolve => {
    const request = indexedDB.open('carouselbot-db');
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('projects').objectStore('projects').get(window.__sampleVideoProject.id);
      get.onsuccess = () => { resolve(get.result?.slides.length === 2 && get.result.assets.some(a => a.videoData)); db.close(); };
    };
  })`), "Video data did not persist locally");
  await evaluate(cdp, `(async () => {
    const { activeSlide, selectOnlyLayer } = await import('/src/editor-state.mjs');
    const { renderEditor } = await import('/src/editor.mjs');
    for (const overlay of [...activeSlide().overlays]) {
      selectOnlyLayer('overlay', overlay.id); renderEditor();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    }
    if (document.querySelector('[data-video-time]') || !document.querySelector('[data-action="export"]').textContent.includes('PNG')) {
      throw new Error('Deleting the last video did not restore PNG mode');
    }
  })()`);
  process.stdout.write(`Video import, playback, scrub, sample, MP4 decode, and persistence passed: ${JSON.stringify(metadata)}\n`);
}
