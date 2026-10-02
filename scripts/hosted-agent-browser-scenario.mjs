import { evaluateProjectPreview } from '../backend/agent-preview.mjs';
import { applyProjectOperations } from '../backend/agent-model.mjs';

export async function verifyHostedAgentPreview({ cdp, evaluate }) {
  const origin = await evaluate(cdp, 'location.origin');
  const blank = { id: 'private-preview', name: 'Private preview', revision: 1, aspectRatio: '9:16', slides: [], assets: [], fonts: [] };
  const slideDraft = applyProjectOperations(blank, [{ type: 'slide.add', backgroundColor: '#EEEDE7' }], { uid: () => 'preview-slide' });
  const textDraft = applyProjectOperations(slideDraft.project, [{ type: 'text.add', slideId: 'preview-slide', text: 'A clear headline\nwith room to breathe', x: .08, y: .12, width: .78, size: 104, background: 'black' }], { uid: () => 'preview-text' });
  const input = { origin, project: textDraft.project, slideId: 'preview-slide', changedTextIds: ['preview-text'] };
  const result = await evaluate(cdp, `(${evaluateProjectPreview.toString()})(${JSON.stringify(input)})`);
  const fit = result.fitted[0];
  if (!fit || fit.id !== 'preview-text' || fit.height < .1 || fit.height > .6 || fit.lineCount < 2 || !result.imageData?.startsWith('data:image/png;base64,')) throw new Error('Hosted agent failed to fit and render editable text with the application renderer.');
  const pixels = await evaluate(cdp, `(async () => { const image = await (await import('/src/slide-renderer.mjs')).loadImage(${JSON.stringify(result.imageData)}); return {width:image.naturalWidth,height:image.naturalHeight}; })()`);
  if (pixels.width !== 540 || pixels.height !== 960) throw new Error('Hosted agent preview changed the carousel aspect ratio.');
  if (await evaluate(cdp, `window.carouselBotAgent.inspect().projects.some(project => project.id === 'private-preview')`)) throw new Error('Hosted preview unexpectedly saved or published its private project.');
  return { lineCount: fit.lineCount, width: pixels.width, height: pixels.height };
}
