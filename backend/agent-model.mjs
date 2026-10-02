import { FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_OUTLINE_WIDTH, normalizeHexColor, TEXT_WEIGHT, ensureBoxedTextContrast, nextLayerZ, initialOverlayWidth, overlayCrop, clamp, projectCatalogEntry, slideCanvasDimensions } from '../src/editor-model.mjs';

import { applyProjectFontToText } from '../src/project-fonts.mjs';
import { solidBackgroundDataUrl, canonicalSolidBackgroundColor } from '../src/slide-background.mjs';

const roles = { title: 104, subtitle: 76, body: 60, caption: 48 };
const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? clamp(Number(value), min, max) : fallback;
const label = (value, fallback) => String(value || fallback).slice(0, 160);
export function solidBackground(color = '#EEEDE7', project = null, slide = null) {
  return solidBackgroundDataUrl(color, project, slide);
}
export function inspectProject(project) {
  const catalog = projectCatalogEntry(project);
  return { ...catalog, slides: catalog.slides.map(({ imageData, overlays, ...slide }, index) => {
    const original = project.slides[index];
    const source = String(original.imageData || '');
    let color = canonicalSolidBackgroundColor(original, project);
    // Older saved projects omit backgroundColor but retain the exact generated solid SVG.
    if (!color && source.startsWith('data:image/svg+xml;charset=utf-8,')) {
      try {
        const candidate = decodeURIComponent(source.slice(source.indexOf(',') + 1)).match(/fill="(#[A-Fa-f0-9]{6})"/)?.[1];
        if (candidate && source === solidBackgroundDataUrl(candidate, project, original)) color = normalizeHexColor(candidate);
      } catch { /* Noncanonical SVGs remain images. */ }
    }
    const backgroundAssetId = source.match(/^\/api\/assets\/([A-Za-z0-9_-]+)$/)?.[1]
      || project.assets?.find(asset => asset.imageData && asset.imageData === source)?.id
      || null;
    const hasImage = Boolean(source && !color);
    return { ...slide, hasImage, backgroundAssetId: hasImage ? backgroundAssetId : null, background: color ? { type: 'solid', color } : hasImage ? { type: 'image', assetId: backgroundAssetId } : { type: 'empty' }, images: overlays || [] };
  }) };
}
export function projectImageAssetId(project, requestedId) {
  if (typeof requestedId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(requestedId)) throw new Error('Invalid image asset ID.');
  const asset = project.assets?.find(item => item.id === requestedId);
  if (!asset) return requestedId;
  const storedId = String(asset.imageData || '').match(/^\/api\/assets\/([A-Za-z0-9_-]+)$/)?.[1];
  if (!storedId) throw new Error('This library image must be uploaded before it can be inspected.');
  return storedId;
}
function textPatch(text, patch, project) {
  if (Object.hasOwn(patch, 'fontId')) applyProjectFontToText(project, text, patch.fontId);
  if (patch.text != null) text.text = String(patch.text).slice(0, 4000);
  if (roles[patch.role]) text.role = patch.role;
  for (const [key, min, max] of [['x', -0.5, 1.5], ['y', -0.5, 1.5], ['width', .1, 1], ['height', .045, 1.5], ['size', FONT_SIZE_MIN, FONT_SIZE_MAX], ['outlineWidth', 0, 40], ['z', -1000, 1000]]) {
    if (patch[key] != null) text[key] = number(patch[key], text[key], min, max);
  }
  if (['plain', 'outline', 'boxed'].includes(patch.style)) text.style = patch.style;
  if (['left', 'center', 'right'].includes(patch.align)) text.align = patch.align;
  if (patch.color != null) text.color = normalizeHexColor(patch.color, text.color);
  if (patch.background != null) text.background = patch.background === 'white' ? 'white' : 'black';
  if (patch.backgroundShape != null) text.backgroundShape = patch.backgroundShape === 'full' ? 'full' : 'lines';
  if (patch.rotation != null) text.rotation = number(patch.rotation, 0, -3600, 3600) % 360;
  ensureBoxedTextContrast(text);
  return text;
}
function imagePatch(image, patch, asset, project, slide) {
  for (const key of ['x', 'y', 'width', 'height', 'rotation', 'z', 'cropX', 'cropY', 'cropW', 'cropH']) {
    if (patch[key] != null) image[key] = number(patch[key], image[key] || 0, -1000, 1000);
  }
  const crop = overlayCrop(image);
  Object.assign(image, { cropX: crop.x, cropY: crop.y, cropW: crop.w, cropH: crop.h });
  image.width = number(image.width, .34, .04, 2.4);
  image.height = number(image.height, image.width * slideCanvasDimensions(project, slide).width / slideCanvasDimensions(project, slide).height * (asset.height * crop.h / (asset.width * crop.w)), .025, 2.4);
  image.rotation = ((image.rotation || 0) % 360 + 360) % 360;
  return image;
}
function reorder(items, ids) {
  if (!Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.id === id))) throw new Error('Order must contain every ID exactly once.');
  return ids.map(id => items.find(item => item.id === id));
}
/** Pure draft mutation; persistence and revision CAS belong to the hosted project store. */
export function applyProjectOperations(original, operations, { assets = [], uid = () => crypto.randomUUID() } = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 30) throw new Error('Provide 1–30 operations.');
  const project = structuredClone(original);
  project.assets ||= [];
  const changedTexts = new Set();
  const results = [];
  for (const op of operations) {
    if (!op || typeof op.type !== 'string') throw new Error('Operation type is required.');
    if (op.expectedRevision != null && Number(op.expectedRevision) !== Number(original.revision || 0)) throw new Error('Project changed; inspect it and retry.');
    const slide = project.slides.find(item => item.id === op.slideId);
    const asset = project.assets.find(item => item.id === op.assetId);
    const requireSlide = () => { if (!slide) throw new Error(`Slide not found: ${op.slideId}`); return slide; };
    const findLayer = id => { const layer = [...requireSlide().texts, ...(slide.overlays || [])].find(item => item.id === id); if (!layer) throw new Error(`Layer not found: ${id}`); return layer; };
    let result = {};
    switch (op.type) {
      case 'project.update': project.name = label(op.name, project.name); break;
      case 'asset.import': {
        const imported = assets.find(item => item.id === (op.assetId || op.mediaId));
        if (!imported) throw new Error('Upload the image first and use its assetId.');
        if (!project.assets.some(item => item.id === imported.id)) project.assets.push({ ...imported, name: label(op.name, imported.name) });
        result = { assetId: imported.id }; break;
      }
      case 'asset.update': if (!asset) throw new Error('Asset not found.'); asset.name = label(op.name, asset.name); break;
      case 'asset.delete': if (!asset) throw new Error('Asset not found.'); project.assets = project.assets.filter(item => item.id !== asset.id); for (const item of project.slides) item.overlays = (item.overlays || []).filter(layer => layer.assetId !== asset.id); break;
      case 'slide.add': {
        const background = op.assetId ? asset : null;
        if (op.assetId && !background) throw new Error('Background asset not found. Import it first.');
        const dimensions = slideCanvasDimensions(project);
        const created = { id: uid(), name: label(op.name, `Slide ${project.slides.length + 1}`), imageData: background?.imageData || solidBackground(op.backgroundColor, project), backgroundColor: background ? undefined : normalizeHexColor(op.backgroundColor, '#EEEDE7'), width: background?.width || dimensions.width, height: background?.height || dimensions.height, imageScale: 1, imageX: 0, imageY: 0, texts: [], overlays: [] };
        project.slides.splice(number(op.index, project.slides.length, 0, project.slides.length), 0, created);
        result = { createdSlideId: created.id }; break;
      }
      case 'slide.update':
        requireSlide();
        if (op.name != null) slide.name = label(op.name, slide.name);
        if (op.backgroundColor != null) Object.assign(slide, { imageData: solidBackground(op.backgroundColor, project, slide), backgroundColor: normalizeHexColor(op.backgroundColor, '#EEEDE7'), width: slideCanvasDimensions(project, slide).width, height: slideCanvasDimensions(project, slide).height, imageScale: 1, imageX: 0, imageY: 0 });
        if (op.assetId) { if (!asset) throw new Error('Background asset not found.'); Object.assign(slide, { imageData: asset.imageData, backgroundColor: undefined, width: asset.width, height: asset.height, imageScale: 1, imageX: 0, imageY: 0 }); }
        for (const key of ['imageScale', 'imageX', 'imageY']) if (op[key] != null) slide[key] = number(op[key], slide[key], key === 'imageScale' ? 1 : -3, 3);
        break;
      case 'slide.duplicate': {
        requireSlide(); const copy = structuredClone(slide); copy.id = uid(); copy.name = label(op.name, `${slide.name} copy`);
        for (const layer of [...copy.texts, ...(copy.overlays || [])]) layer.id = uid();
        project.slides.splice(project.slides.indexOf(slide) + 1, 0, copy); result = { createdSlideId: copy.id }; break;
      }
      case 'slide.delete': requireSlide(); project.slides = project.slides.filter(item => item.id !== slide.id); break;
      case 'slide.reorder': project.slides = reorder(project.slides, op.slideIds); break;
      case 'text.add': {
        requireSlide(); const role = roles[op.role] ? op.role : String(op.text || '').length <= 48 ? 'title' : 'body';
        const text = textPatch({ id: uid(), text: '', x: .08, y: .12, width: .78, height: .12, role, size: roles[role], fontFamily: 'TikTok Sans', fontWeight: TEXT_WEIGHT, fontStyle: 'normal', style: 'boxed', background: 'black', backgroundShape: 'lines', color: '#FFFFFF', outlineWidth: DEFAULT_OUTLINE_WIDTH, align: 'center', rotation: 0, z: nextLayerZ(slide) }, op, project);
        slide.texts.push(text); changedTexts.add(text.id); result = { createdTextId: text.id }; break;
      }
      case 'text.update':
        requireSlide(); if (!Array.isArray(op.updates) || op.updates.length > 100) throw new Error('Text updates are required.');
        for (const patch of op.updates) { const text = slide.texts.find(item => item.id === patch.id); if (!text) throw new Error('Text layer not found.'); textPatch(text, patch, project); changedTexts.add(text.id); } break;
      case 'text.fit': requireSlide(); for (const id of op.textIds || []) { if (!slide.texts.some(item => item.id === id)) throw new Error('Text layer not found.'); changedTexts.add(id); } break;
      case 'image.add': {
        requireSlide(); if (!asset) throw new Error('Asset not found. Import it first.');
        const image = imagePatch({ id: uid(), assetId: asset.id, x: .12, y: .3, width: initialOverlayWidth(asset, project, slide), rotation: 0, z: nextLayerZ(slide) }, op, asset, project, slide);
        (slide.overlays ||= []).push(image); result = { createdImageId: image.id }; break;
      }
      case 'image.update': requireSlide(); for (const patch of op.updates || []) { const image = (slide.overlays || []).find(item => item.id === patch.id); if (!image) throw new Error('Image layer not found.'); imagePatch(image, patch, project.assets.find(item => item.id === image.assetId), project, slide); } break;
      case 'layer.delete': requireSlide(); for (const id of op.layerIds || []) findLayer(id); slide.texts = slide.texts.filter(item => !(op.layerIds || []).includes(item.id)); slide.overlays = (slide.overlays || []).filter(item => !(op.layerIds || []).includes(item.id)); break;
      case 'layer.duplicate': requireSlide(); for (const id of op.layerIds || []) { const source = findLayer(id); const copy = { ...source, id: uid(), x: source.x + number(op.offsetX, .03, -1, 1), y: source.y + number(op.offsetY, .03, -1, 1), z: nextLayerZ(slide) }; (source.assetId ? slide.overlays : slide.texts).push(copy); } break;
      case 'layer.reorder': requireSlide(); reorder([...slide.texts, ...(slide.overlays || [])], op.layerIds).forEach((item, index) => { item.z = index + 1; }); break;
      default: throw new Error(`Unsupported operation: ${op.type}`);
    }
    results.push({ type: op.type, ...result });
    if (project.slides.length > 50 || project.assets.length > 100 || project.slides.some(item => item.texts.length + (item.overlays || []).length > 100)) throw new Error('Project limit reached (50 slides, 100 assets, 100 layers per slide).');
  }
  return { project, results, changedTextIds: [...changedTexts] };
}
