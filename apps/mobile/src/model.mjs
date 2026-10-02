import { solidBackgroundDataUrl } from '../../../src/slide-background.mjs';
import { nextLayerZ, clamp, uid } from '../../../src/editor-model.mjs';
const id = uid;
/** @param {any} project */
export function blankSlide(project = null) {
  const slide = {
    id: id(),
    name: 'Untitled slide',
    width: 1080,
    height: 1920,
    texts: [],
    overlays: [],
    backgroundColor: '#F1EFE7',
    imageScale: 1,
    imageX: 0,
    imageY: 0,
  };
  return { ...slide, imageData: solidBackgroundDataUrl(slide.backgroundColor, project, slide) };
}
export function newProject(name = 'Untitled carousel') {
  return {
    id: id(),
    name,
    revision: 0,
    aspectRatio: '9:16',
    slides: [blankSlide()],
    assets: [],
    fonts: [],
    updatedAt: Date.now(),
  };
}
export function newText(slide, text = 'Your next idea') {
  return {
    id: id(),
    text,
    x: 0.07,
    y: 0.25,
    width: 0.86,
    height: 0.25,
    size: 96,
    style: 'boxed',
    background: 'black',
    backgroundShape: 'lines',
    color: '#FFFFFF',
    align: 'center',
    fontFamily: 'TikTok Sans',
    fontWeight: 700,
    z: nextLayerZ(slide),
    rotation: 0,
  };
}
export function duplicateSlide(slide) {
  return {
    ...structuredClone(slide),
    id: id(),
    name: `${slide.name} copy`,
    texts: slide.texts.map((t) => ({ ...structuredClone(t), id: id() })),
    overlays: (slide.overlays || []).map((t) => ({ ...structuredClone(t), id: id() })),
  };
}
export function reorderSlide(project, slideId, offset) {
  const index = project.slides.findIndex((s) => s.id === slideId);
  const next = index + offset;
  if (index < 0 || next < 0 || next >= project.slides.length) return project;
  const slides = [...project.slides];
  const [slide] = slides.splice(index, 1);
  slides.splice(next, 0, slide);
  return { ...project, slides };
}
export function patchLayer(project, slideId, selection, patch) {
  if (!selection) return project;
  return {
    ...project,
    slides: project.slides.map((slide) =>
      slide.id !== slideId
        ? slide
        : {
            ...slide,
            [selection.kind === 'text' ? 'texts' : 'overlays']: (selection.kind === 'text'
              ? slide.texts
              : slide.overlays || []
            ).map((layer) => (layer.id === selection.id ? { ...layer, ...patch } : layer)),
          },
    ),
  };
}
export function transformLayer(layer, dx, dy, mode = 'move', ratio = 1) {
  if (mode === 'resize')
    return {
      width: clamp(layer.width + dx, 0.04, 2),
      height: clamp((layer.height || 0.2) + dy, 0.02, 2),
    };
  return {
    x: clamp(layer.x + dx, -layer.width + 0.02, 0.98),
    y: clamp(layer.y + dy, -(layer.height || 0.2) + 0.02, 0.98),
  };
}
export function agentStatus(job, events = []) {
  if (!job) return 'Ready when you are';
  if (job.status === 'failed') return job.error || 'Request failed. Your saved edits are safe.';
  if (job.status === 'completed') return 'Your carousel is ready';
  if (job.status === 'stopped') return 'Stopped · completed edits saved';
  const event = [...events]
    .reverse()
    .find((e) => ['tool', 'status', 'tool_start', 'project'].includes(e.type));
  const command = event?.data?.command || event?.data?.name || event?.data?.tool;
  if (typeof event?.data?.message === 'string') return event.data.message;
  if (typeof command === 'string')
    return command.includes('render')
      ? 'Checking your slides…'
      : command.includes('text')
        ? 'Editing the text…'
        : command.includes('image')
          ? 'Arranging your images…'
          : 'Editing your carousel…';
  return job.status === 'queued' ? 'Getting started…' : 'Working on your carousel…';
}
