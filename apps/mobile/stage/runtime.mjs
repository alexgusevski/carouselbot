import { renderSlideCanvas } from '../../../src/slide-renderer.mjs';
import { renderVideoFrame } from '../../../src/video-frame.mjs';
import { renderSlideMp4 } from '../../../src/video-export.mjs';
import { getOverlayMetrics } from '../../../src/editor-state.mjs';
import {
  slideItems,
  slideCanvasDimensions,
  clamp,
  wrapText,
  TEXT_LINE_HEIGHT,
  BOX_TEXT_LINE_HEIGHT,
  BOX_HORIZONTAL_PADDING,
  TEXT_BOX_EDGE_PADDING,
} from '../../../src/editor-model.mjs';
import { ensureProjectFontsLoaded, textCanvasFont } from '../../../src/project-fonts.mjs';
import { transformLayer } from '../src/model.mjs';

let project,
  slide,
  selection = null,
  locked = false,
  backgroundMode = false;
let generation = 0,
  painting = false,
  repaint = false,
  drag = null,
  zoom = 1;
const stage = document.querySelector('#stage'),
  canvas = document.querySelector('canvas'),
  outline = document.querySelector('#selection');
const send = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
function bounds(item, kind) {
  return {
    ...item,
    ...(kind === 'overlay'
      ? getOverlayMetrics(
          item,
          project.assets.find((a) => a.id === item.assetId),
          { project, slide },
        )
      : {}),
  };
}
function selected() {
  return (
    selection &&
    slideItems(slide).find(({ item, kind }) => item.id === selection.id && kind === selection.kind)
  );
}
function showSelection() {
  const layer = selected();
  outline.hidden = !layer || locked;
  if (!layer) return;
  const b = bounds(layer.item, layer.kind);
  Object.assign(outline.style, {
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.width * 100}%`,
    height: `${b.height * 100}%`,
    transform: `rotate(${b.rotation || 0}deg)`,
  });
}
async function paint() {
  if (!slide) return;
  if (painting) {
    repaint = true;
    return;
  }
  painting = true;
  const stamp = generation;
  try {
    const frame = await renderVideoFrame(slide, project, 540, undefined, window.playhead || 0);
    if (stamp !== generation) {
      frame.width = frame.height = 0;
      repaint = true;
      return;
    }
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d').drawImage(frame, 0, 0);
    let thumbnail;
    if (!drag && !pinch) {
      const small = document.createElement('canvas');
      small.width = 90;
      small.height = Math.round((90 * frame.height) / frame.width);
      small.getContext('2d').drawImage(frame, 0, 0, small.width, small.height);
      thumbnail = small.toDataURL('image/png');
    }
    send({ type: 'painted', slideId: slide.id, revision: project.revision, thumbnail });
    frame.width = frame.height = 0;
    showSelection();
  } catch (error) {
    send({ type: 'error', message: error.message });
  } finally {
    painting = false;
    if (repaint) {
      repaint = false;
      void paint();
    }
  }
}
function point(event) {
  const r = stage.getBoundingClientRect();
  return { x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height };
}
function hit(p, layer) {
  const b = bounds(layer.item, layer.kind),
    cx = b.x + b.width / 2,
    cy = b.y + b.height / 2;
  const r = stage.getBoundingClientRect(),
    angle = (-(b.rotation || 0) * Math.PI) / 180;
  const dx = (p.x - cx) * r.width,
    dy = (p.y - cy) * r.height;
  const x = Math.cos(angle) * dx - Math.sin(angle) * dy,
    y = Math.sin(angle) * dx + Math.cos(angle) * dy;
  return Math.abs(x) <= (b.width * r.width) / 2 + 8 && Math.abs(y) <= (b.height * r.height) / 2 + 8;
}
const pointers = new Map();
let pinch = null;
stage.addEventListener('pointerdown', (event) => {
  if (!slide || locked) return;
  stage.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    if (drag?.layer) Object.assign(drag.layer.item, drag.before);
    drag = null;
    void paint();
    return;
  }
  const p = point(event);
  const handle = event.target.dataset.handle;
  const layer = handle
    ? selected()
    : [...slideItems(slide)].reverse().find((layer) => hit(p, layer));
  selection = layer ? { id: layer.item.id, kind: layer.kind } : null;
  send({ type: 'selection', selection });
  showSelection();
  if (backgroundMode && !handle)
    drag = {
      before: { imageX: slide.imageX || 0, imageY: slide.imageY || 0 },
      start: p,
      mode: 'background',
    };
  else if (layer)
    drag = { layer, before: bounds(layer.item, layer.kind), start: p, mode: handle || 'move' };
});
stage.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    zoom = clamp((pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance, 1, 3);
    stage.style.transform = `scale(${zoom})`;
    return;
  }
  if (!drag) return;
  const p = point(event),
    dx = p.x - drag.start.x,
    dy = p.y - drag.start.y;
  if (drag.mode === 'background')
    Object.assign(slide, {
      imageX: clamp(drag.before.imageX + dx, -2, 2),
      imageY: clamp(drag.before.imageY + dy, -2, 2),
    });
  else if (drag.mode === 'rotate') {
    const r = stage.getBoundingClientRect(),
      b = drag.before;
    drag.layer.item.rotation =
      (Math.atan2((p.y - b.y - b.height / 2) * r.height, (p.x - b.x - b.width / 2) * r.width) *
        180) /
        Math.PI +
      90;
  } else Object.assign(drag.layer.item, transformLayer(drag.before, dx, dy, drag.mode));
  showSelection();
  void paint();
});
function finish(event, canceled = false) {
  pointers.delete(event.pointerId);
  if (pinch) {
    if (pointers.size === 0) pinch = null;
    return;
  }
  if (!drag) return;
  if (canceled) {
    Object.assign(drag.mode === 'background' ? slide : drag.layer.item, drag.before);
    void paint();
  } else if (drag.mode === 'background')
    send({
      type: 'backgroundPatch',
      slideId: slide.id,
      revision: project.revision,
      patch: { imageX: slide.imageX, imageY: slide.imageY },
    });
  else {
    const { x, y, width, height, rotation } = drag.layer.item;
    send({
      type: 'layerPatch',
      slideId: slide.id,
      revision: project.revision,
      selection,
      patch: { x, y, width, ...(height != null ? { height } : {}), rotation },
    });
  }
  drag = null;
}
stage.addEventListener('pointerup', (event) => finish(event));
stage.addEventListener('pointercancel', (event) => finish(event, true));
stage.addEventListener('dblclick', () => {
  if (selection?.kind === 'text' && !locked) send({ type: 'editText', selection });
});
window.CarouselStage = {
  receive: async (message) => {
    try {
      if (message.type === 'load') {
        pointers.clear();
        drag = null;
        pinch = null;
        generation++;
        project = message.project;
        slide = project.slides.find((s) => s.id === message.slideId);
        selection = message.selection;
        locked = message.locked;
        backgroundMode = message.backgroundMode;
        if (!slide) return;
        const d = slideCanvasDimensions(project, slide);
        stage.style.aspectRatio = `${d.width}/${d.height}`;
        stage.style.width = `min(calc(100vw - 42px), calc((100vh - 42px) * ${d.width / d.height}))`;
        showSelection();
        await paint();
      } else if (message.type === 'state') {
        if (message.locked && drag) {
          Object.assign(drag.mode === 'background' ? slide : drag.layer.item, drag.before);
          pointers.clear();
          drag = null;
          pinch = null;
          void paint();
        }
        selection = message.selection;
        locked = message.locked;
        backgroundMode = message.backgroundMode;
        showSelection();
      } else if (message.type === 'playhead') {
        window.playhead = message.time;
        await paint();
      } else if (message.type === 'resetZoom') {
        zoom = 1;
        stage.style.transform = '';
      } else if (message.type === 'measureText') {
        const text = message.text;
        await ensureProjectFontsLoaded(project, [text]);
        const context = document.createElement('canvas').getContext('2d');
        context.font = textCanvasFont(project, text, text.size);
        const boxed = text.style === 'boxed' && text.backgroundShape !== 'full';
        const inset = boxed
          ? text.size * (TEXT_BOX_EDGE_PADDING * 2 + BOX_HORIZONTAL_PADDING * 2)
          : text.size * 0.32;
        const lines = wrapText(context, text.text, Math.max(1, text.width * 1080 - inset));
        const d = slideCanvasDimensions(project, slide);
        const height = clamp(
          (lines.length * text.size * (boxed ? BOX_TEXT_LINE_HEIGHT : TEXT_LINE_HEIGHT) +
            text.size * 0.4 +
            4) /
            ((d.height * 1080) / d.width),
          0.025,
          2,
        );
        send({ type: 'measured', requestId: message.requestId, data: height });
      } else if (message.type === 'export') {
        const targetProject = message.project || project;
        const targetSlide = message.project
          ? message.project.slides.find((s) => s.id === message.slideId)
          : slide;
        const d = slideCanvasDimensions(targetProject, targetSlide);
        if (message.format === 'mp4') {
          const blob = await renderSlideMp4(targetSlide, targetProject);
          const reader = new FileReader();
          reader.onload = () =>
            send({
              type: 'exported',
              requestId: message.requestId,
              data: reader.result,
              format: 'mp4',
            });
          reader.readAsDataURL(blob);
        } else {
          const frame = await renderVideoFrame(
            targetSlide,
            targetProject,
            d.width,
            d.height,
            window.playhead || 0,
          );
          send({
            type: 'exported',
            requestId: message.requestId,
            data: frame.toDataURL('image/png'),
            format: 'png',
          });
          frame.width = frame.height = 0;
        }
      }
    } catch (error) {
      send({ type: 'error', requestId: message.requestId, message: error.message });
    }
  },
};
send({ type: 'ready' });
