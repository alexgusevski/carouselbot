export async function verifySelectedLayerPriority({ cdp, evaluate }) {
  await evaluate(cdp, `(async () => {
    const result = await window.carouselBotAgent.execute({ type: 'project.create', name: 'Selected layer regression' });
    await window.carouselBotAgent.execute({ type: 'project.open', projectId: result.projectId });
    await window.carouselBotAgent.execute({ type: 'slide.add', projectId: result.projectId });
    const { activeProject, activeSlide, selectOnlyLayer } = await import('/src/editor-state.mjs');
    const { renderEditor } = await import('/src/editor.mjs');
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    canvas.getContext('2d').fillRect(0, 0, 100, 100);
    activeProject().assets.push({ id: 'selection-asset', name: 'Selection fixture', width: 100, height: 100, imageData: canvas.toDataURL() });
    activeSlide().overlays = [
      { id: 'behind', assetId: 'selection-asset', x: .25, y: .3, width: .4, height: .3, rotation: 0, z: 1 },
      { id: 'front', assetId: 'selection-asset', x: .1, y: .1, width: .8, height: .8, rotation: 0, z: 3 },
    ];
    activeSlide().texts = [{ id: 'text-behind', text: 'Live text', x: .3, y: .35, width: .3, height: .2, size: 50, fontWeight: 700, style: 'plain', rotation: 0, z: 2 }];
    selectOnlyLayer('overlay', 'behind'); renderEditor();
  })()`);
  const inspect = () => evaluate(cdp, `(async () => {
    const { activeSlide, selectedLayerKeys } = await import('/src/editor-state.mjs');
    return { slide: structuredClone(activeSlide()), selection: selectedLayerKeys() };
  })()`);
  const point = (selector, fraction = .5) => evaluate(cdp, `(() => {
    const box = document.querySelector(${JSON.stringify(selector)}); const r = box.getBoundingClientRect();
    const x = r.left + r.width * ${fraction}; const y = r.top + r.height * ${fraction};
    return { x, y, top: document.elementFromPoint(x, y)?.closest('.overlay-box, .text-box')?.dataset.overlayId };
  })()`);
  const drag = async (p, dx, dy, modifiers = 0) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + dx, y: p.y + dy, button: 'left', buttons: 1, modifiers });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y + dy, button: 'left', buttons: 0, clickCount: 1, modifiers });
  };
  for (const [selector, field, dx, dy] of [
    ['.overlay-box[data-overlay-id="behind"]', 'x', 20, 12],
    ['.overlay-box[data-overlay-id="behind"] [data-edge="e"]', 'width', 16, 0],
    ['.overlay-box[data-overlay-id="behind"] [data-corner="se"]', 'width', 12, 12],
    ['.overlay-box[data-overlay-id="behind"] [data-rotate]', 'rotation', 18, 5],
  ]) {
    const p = await point(selector);
    if (p.top !== 'front') throw new Error('Regression fixture must cover selected control: ' + selector);
    const before = await inspect(); await drag(p, dx, dy); const after = await inspect();
    if (after.slide.overlays[0][field] === before.slide.overlays[0][field]
      || JSON.stringify(after.slide.overlays[1]) !== JSON.stringify(before.slide.overlays[1])
      || after.selection[0] !== 'overlay:behind') throw new Error('Covered selected interaction failed: ' + selector);
  }
  // Clicking an uncovered part of the front layer must still select it.
  await drag(await point('.overlay-box[data-overlay-id="front"]', .05), 0, 0);
  if ((await inspect()).selection[0] !== 'overlay:front') throw new Error('Other visible layers became unselectable');
  await evaluate(cdp, `(async () => {
    const { selectOnlyLayer } = await import('/src/editor-state.mjs');
    const { renderEditor } = await import('/src/editor.mjs');
    selectOnlyLayer('text', 'text-behind'); renderEditor();
  })()`);
  const beforeText = await inspect();
  await drag(await point('.text-box[data-text-id="text-behind"]', .05), 18, 10);
  if ((await inspect()).slide.texts[0].x === beforeText.slide.texts[0].x) throw new Error('Covered selected text did not drag');
  // Observe multiple painted sizes before releasing a real range drag.
  const range = await evaluate(cdp, `(() => { const r = document.querySelector('#font-weight').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, width: r.width }; })()`);
  const sizes = [];
  const beforeWeight = await inspect();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: range.x + range.width * .3, y: range.y, button: 'left', buttons: 1, clickCount: 1 });
  for (const fraction of [.4, .6, .8]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: range.x + range.width * fraction, y: range.y, button: 'left', buttons: 1 });
    sizes.push(await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => resolve(document.querySelector('.text-box').style.getPropertyValue('--text-font-weight'))))`));
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: range.x + range.width * .8, y: range.y, button: 'left', buttons: 0, clickCount: 1 });
  if (new Set(sizes).size !== 3) throw new Error('Font weight did not paint continuously while dragging: ' + JSON.stringify(sizes));
  await evaluate(cdp, `(async () => { document.activeElement?.blur(); await new Promise(resolve => setTimeout(resolve, 250)); const { undo } = await import('/src/editor.mjs'); await undo(); })()`);
  const undone = await inspect();
  if (undone.slide.texts[0].fontWeight !== beforeWeight.slide.texts[0].fontWeight) throw new Error('Weight drag must undo as one gesture');
}
