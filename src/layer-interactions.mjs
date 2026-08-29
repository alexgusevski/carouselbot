import {
  DESIGN_WIDTH,
  layerKey,
  overlayCrop,
  textAlignment,
  rotateDelta,
  applyCropValues,
  clamp,
} from "./editor-model.mjs";
import {
  state,
  app,
  activeSlide,
  selectedText,
  selectedOverlay,
  selectedLayerKeys,
  isLayerSelected,
  selectedLayers,
  setLayerSelection,
  selectOnlyLayer,
  toggleLayerSelection,
  projectAsset,
  getOverlayMetrics,
  constrainOverlay,
  constrainImagePosition,
} from "./editor-state.mjs";
import {
  paintTextContent,
  updateTextBox,
  updateOverlayBox,
  updateStageImage,
} from "./editor-view.mjs";

export function createLayerInteractions({
  recordHistory,
  clearLayerSelection,
  showLayerMenu,
  finishCrop,
  scheduleSave,
  refreshSelection,
  ensureTextFits,
  deleteSelectedLayers,
}) {
  function prepareLayerPointerSelection(event, kind, id) {
    const key = layerKey(kind, id);
    if ((event.metaKey || event.ctrlKey) && event.button === 0) {
      event.preventDefault();
      event.stopPropagation();
      toggleLayerSelection(kind, id);
      refreshSelection();
      return false;
    }
    if (isLayerSelected(kind, id)) setLayerSelection(selectedLayerKeys(), key);
    else selectOnlyLayer(kind, id);
    refreshSelection();
    return event.button !== 2;
  }

  function bindOverlayBox(box) {
    box.addEventListener("pointerdown", (event) => {
      if (state.photoAdjustMode) return;
      const corner = event.target.closest("[data-corner]")?.dataset.corner;
      const edge = event.target.closest("[data-edge]")?.dataset.edge;
      const rotate = event.target.closest("[data-rotate]");
      const cropHandle = event.target.closest("[data-crop]")?.dataset.crop;
      if (!prepareLayerPointerSelection(event, "overlay", box.dataset.overlayId)) return;
      if (state.croppingOverlayId && state.croppingOverlayId !== box.dataset.overlayId) {
        finishCrop();
        return;
      }
      if (state.croppingOverlayId === box.dataset.overlayId) {
        if (cropHandle) beginCropResize(event, box, cropHandle);
        else if (event.target.closest(".crop-rect")) beginCropMove(event, box);
        return;
      }
      if (rotate) beginOverlayRotate(event, box);
      else if (corner) beginOverlayResize(event, box, corner);
      else if (edge) beginOverlayResize(event, box, edge, { preserveAspect: false });
      else beginOverlayDrag(event, box);
    });
    box.addEventListener("contextmenu", (event) => {
      showLayerMenu(event, "overlay", box.dataset.overlayId);
    });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteSelectedLayers();
      }
    });
  }

  function stagePoint(event) {
    const stage = app.querySelector(".stage");
    const rect = stage.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function pointerDeltaInLayerAxes(event, startEvent, degrees) {
    const rotated = rotateDelta(event.clientX - startEvent.clientX, event.clientY - startEvent.clientY, degrees);
    return {
      x: rotated.x / state.stageWidth,
      y: rotated.y / state.stageHeight,
    };
  }

  function layerOffsetToStage(dx, dy, degrees) {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const pixelX = dx * state.stageWidth;
    const pixelY = dy * state.stageHeight;
    return {
      x: (pixelX * cos - pixelY * sin) / state.stageWidth,
      y: (pixelX * sin + pixelY * cos) / state.stageHeight,
    };
  }

  function resizeLayerRect(start, handle, delta, { minWidth, minHeight, maxWidth = Infinity, maxHeight = Infinity, preserveAspect = false } = {}) {
    let width = start.width;
    let height = start.height;
    let centerShiftX = 0;
    let centerShiftY = 0;
    if (preserveAspect) {
      const signX = handle.includes("e") ? 1 : -1;
      const signY = handle.includes("s") ? 1 : -1;
      const vectorX = signX * start.width * state.stageWidth;
      const vectorY = signY * start.height * state.stageHeight;
      const nextX = vectorX + delta.x * state.stageWidth;
      const nextY = vectorY + delta.y * state.stageHeight;
      const projectedScale = (nextX * vectorX + nextY * vectorY) / (vectorX ** 2 + vectorY ** 2 || 1);
      const scale = clamp(projectedScale, Math.max(minWidth / start.width, minHeight / start.height), Math.min(maxWidth / start.width, maxHeight / start.height));
      width = start.width * scale;
      height = start.height * scale;
      centerShiftX = signX * (width - start.width) / 2;
      centerShiftY = signY * (height - start.height) / 2;
    } else {
      if (handle.includes("e")) {
        width = clamp(start.width + delta.x, minWidth, maxWidth);
        centerShiftX = (width - start.width) / 2;
      }
      if (handle.includes("w")) {
        width = clamp(start.width - delta.x, minWidth, maxWidth);
        centerShiftX = (start.width - width) / 2;
      }
      if (handle.includes("s")) {
        height = clamp(start.height + delta.y, minHeight, maxHeight);
        centerShiftY = (height - start.height) / 2;
      }
      if (handle.includes("n")) {
        height = clamp(start.height - delta.y, minHeight, maxHeight);
        centerShiftY = (start.height - height) / 2;
      }
    }
    const stageShift = layerOffsetToStage(centerShiftX, centerShiftY, start.rotation);
    return {
      x: start.centerX + stageShift.x - width / 2,
      y: start.centerY + stageShift.y - height / 2,
      width,
      height,
    };
  }

  function localPointOnOverlay(event, overlay, asset) {
    const stage = app.querySelector(".stage");
    const rect = stage.getBoundingClientRect();
    const metrics = getOverlayMetrics(overlay, asset);
    const centerX = overlay.x + metrics.width / 2;
    const centerY = overlay.y + metrics.height / 2;
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    const local = rotateDelta(nx - centerX, ny - centerY, overlay.rotation || 0);
    return {
      x: (centerX + local.x - overlay.x) / metrics.width,
      y: (centerY + local.y - overlay.y) / metrics.height,
    };
  }

  function beginCropResize(event, box, handle) {
    event.preventDefault();
    event.stopPropagation();
    const overlay = selectedOverlay();
    const asset = overlay ? projectAsset(overlay.assetId) : null;
    if (!overlay || !asset) return;
    recordHistory();
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const startCrop = overlayCrop(overlay);
    const startPoint = localPointOnOverlay(event, overlay, asset);
    const move = (moveEvent) => {
      const point = localPointOnOverlay(moveEvent, overlay, asset);
      const next = { ...startCrop };
      if (handle.includes("e")) next.w = startCrop.w + (point.x - startPoint.x);
      if (handle.includes("s")) next.h = startCrop.h + (point.y - startPoint.y);
      if (handle.includes("w")) {
        next.x = startCrop.x + (point.x - startPoint.x);
        next.w = startCrop.w - (point.x - startPoint.x);
        next.anchorX = startCrop.x + startCrop.w;
      }
      if (handle.includes("n")) {
        next.y = startCrop.y + (point.y - startPoint.y);
        next.h = startCrop.h - (point.y - startPoint.y);
        next.anchorY = startCrop.y + startCrop.h;
      }
      applyCropValues(overlay, next);
      updateOverlayBox(overlay);
      scheduleSave();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginCropMove(event, box) {
    event.preventDefault();
    const overlay = selectedOverlay();
    const asset = overlay ? projectAsset(overlay.assetId) : null;
    if (!overlay || !asset) return;
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const startCrop = overlayCrop(overlay);
    const startPoint = localPointOnOverlay(event, overlay, asset);
    const move = (moveEvent) => {
      const point = localPointOnOverlay(moveEvent, overlay, asset);
      applyCropValues(overlay, {
        x: startCrop.x + (point.x - startPoint.x),
        y: startCrop.y + (point.y - startPoint.y),
        w: startCrop.w,
        h: startCrop.h,
      });
      updateOverlayBox(overlay);
      scheduleSave();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginOverlayDrag(event, box) {
    beginLayerDrag(event, box, "overlay");
  }

  function pointerOverTrash(event) {
    const trash = app.querySelector("[data-asset-trash]");
    if (!trash || !event) return false;
    const rect = trash.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  function beginOverlayResize(event, box, handle, { preserveAspect = true } = {}) {
    event.preventDefault();
    event.stopPropagation();
    const overlay = selectedOverlay();
    const asset = overlay ? projectAsset(overlay.assetId) : null;
    if (!overlay || !asset) return;
    recordHistory();
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const startMetrics = getOverlayMetrics(overlay, asset);
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      width: overlay.width,
      x: overlay.x,
      y: overlay.y,
      height: startMetrics.height,
      centerX: overlay.x + overlay.width / 2,
      centerY: overlay.y + startMetrics.height / 2,
      rotation: overlay.rotation || 0,
    };
    const move = (moveEvent) => {
      const delta = pointerDeltaInLayerAxes(moveEvent, start, start.rotation);
      const next = resizeLayerRect(start, handle, delta, {
        minWidth: 0.04,
        minHeight: 0.025,
        maxWidth: 2.4,
        maxHeight: 2.4,
        preserveAspect,
      });
      overlay.x = next.x;
      overlay.y = next.y;
      overlay.width = next.width;
      overlay.height = next.height;
      constrainOverlay(overlay, asset);
      updateOverlayBox(overlay);
      scheduleSave();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginOverlayRotate(event, box) {
    event.preventDefault();
    event.stopPropagation();
    const overlay = selectedOverlay();
    const asset = overlay ? projectAsset(overlay.assetId) : null;
    if (!overlay || !asset) return;
    recordHistory();
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const metrics = getOverlayMetrics(overlay, asset);
    const stage = app.querySelector(".stage");
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + (overlay.x + metrics.width / 2) * rect.width;
    const centerY = rect.top + (overlay.y + metrics.height / 2) * rect.height;
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const startRotation = overlay.rotation || 0;
    const move = (moveEvent) => {
      const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
      let degrees = startRotation + ((angle - startAngle) * 180) / Math.PI;
      if (moveEvent.shiftKey) degrees = Math.round(degrees / 15) * 15;
      overlay.rotation = ((degrees % 360) + 360) % 360;
      updateOverlayBox(overlay);
      const output = app.querySelector("#overlay-rotation-output");
      const range = app.querySelector("#overlay-rotation");
      const number = app.querySelector("#overlay-rotation-number");
      if (output) output.textContent = `${Math.round(overlay.rotation)}°`;
      if (range) range.value = Math.round(overlay.rotation);
      if (number) number.value = Math.round(overlay.rotation);
      scheduleSave();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function bindTextBox(box) {
    const content = box.querySelector(".text-visual--inside .text-content");
    box.addEventListener("pointerdown", (event) => {
      const corner = event.target.closest("[data-corner]")?.dataset.corner;
      const edge = event.target.closest("[data-edge]")?.dataset.edge;
      const rotate = event.target.closest("[data-rotate]");
      const contentTarget = event.target.closest(".text-content, .text-editor");
      const wasSelected = isLayerSelected("text", box.dataset.textId);

      if (box.classList.contains("is-editing")) {
        if (contentTarget && !corner && !edge && !rotate) return;
        endTextEditing(box);
      } else if (wasSelected && contentTarget && event.button === 0 && !(event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        startTextEditing(box, { clientX: event.clientX, clientY: event.clientY });
        return;
      }

      if (!prepareLayerPointerSelection(event, "text", box.dataset.textId)) return;
      if (state.croppingOverlayId) {
        finishCrop();
        return;
      }
      if (rotate) beginTextRotate(event, box);
      else if (corner) beginResize(event, box, corner);
      else if (edge) beginResize(event, box, edge);
      else beginDrag(event, box);
    });
    box.addEventListener("contextmenu", (event) => {
      if (box.classList.contains("is-editing")) return;
      showLayerMenu(event, "text", box.dataset.textId);
    });
    box.addEventListener("dblclick", (event) => {
      if (box.classList.contains("is-editing")) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      startTextEditing(box, { selectAll: true });
    });
    box.addEventListener("keydown", (event) => {
      if ((event.key === "Backspace" || event.key === "Delete") && !box.classList.contains("is-editing")) {
        event.preventDefault();
        deleteSelectedLayers();
      }
      if (event.key === "Enter" && !box.classList.contains("is-editing")) {
        event.preventDefault();
        box.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      }
    });
  }

  function activeTextEditingBox() {
    return app.querySelector(".text-box.is-editing");
  }

  function isInlineTextEditing() {
    return Boolean(activeTextEditingBox());
  }

  function placeTextCaret(content, clientX, clientY) {
    const selection = window.getSelection();
    if (!selection) return;
    let range = null;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clientX, clientY);
      if (position && content.contains(position.offsetNode)) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
      }
    } else if (document.caretRangeFromPoint) {
      const candidate = document.caretRangeFromPoint(clientX, clientY);
      if (candidate && content.contains(candidate.startContainer)) range = candidate;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function startTextEditing(box, { selectAll = false, clientX = null, clientY = null } = {}) {
    const text = activeSlide()?.texts.find((item) => item.id === box?.dataset.textId);
    const content = box?.querySelector(".text-visual--inside .text-content");
    const contentWrap = content?.closest(".text-content-wrap");
    if (!box || !text || !content || !contentWrap) return;

    const otherEditingBox = activeTextEditingBox();
    if (otherEditingBox && otherEditingBox !== box) endTextEditing(otherEditingBox);
    if (!isLayerSelected("text", text.id) || selectedLayerKeys().length !== 1) {
      selectOnlyLayer("text", text.id);
      refreshSelection();
    }

    box.classList.add("is-editing", "is-selected");
    const editor = document.createElement("span");
    editor.className = "text-editor";
    editor.contentEditable = "true";
    editor.spellcheck = false;
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "Edit text layer");
    editor.setAttribute("aria-multiline", "true");
    editor.style.fontSize = `${text.size * (state.stageWidth / DESIGN_WIDTH)}px`;
    editor.style.textAlign = textAlignment(text);
    editor.textContent = text.text || "";
    content.setAttribute("aria-hidden", "true");
    contentWrap.appendChild(editor);

    editor.addEventListener("input", () => {
      text.text = editor.innerText.replace(/\n$/, "");
      box.querySelectorAll(".text-content").forEach((renderedContent) => {
        paintTextContent(text, renderedContent, box);
      });
      const textarea = app.querySelector("#text-value");
      if (textarea) textarea.value = text.text;
      ensureTextFits(text);
      scheduleSave();
    });
    editor.addEventListener("blur", () => endTextEditing(box));
    editor.focus({ preventScroll: true });

    const selection = window.getSelection();
    if (selectAll && selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      placeTextCaret(editor, clientX, clientY);
    }
  }

  function endTextEditing(box = activeTextEditingBox(), { deselect = false } = {}) {
    if (!box) return;
    const content = box.querySelector(".text-visual--inside .text-content");
    const wasEditing = box.classList.contains("is-editing");
    if (!wasEditing) return;
    const editor = box.querySelector(".text-editor");
    box.classList.remove("is-editing");
    editor?.remove();
    content?.removeAttribute("aria-hidden");
    window.getSelection()?.removeAllRanges();

    const text = activeSlide()?.texts.find((item) => item.id === box.dataset.textId);
    if (wasEditing && text) updateTextBox(text);
    if (deselect && isLayerSelected("text", box.dataset.textId)) {
      clearLayerSelection();
      refreshSelection();
    }
  }

  function beginDrag(event, box) {
    beginLayerDrag(event, box, "text");
  }

  function beginLayerDrag(event, box, draggedKind) {
    event.preventDefault();
    const layers = selectedLayers();
    if (!layers.length) return;
    recordHistory();
    const draggingBoxes = layers.flatMap(({ kind, item }) => {
      const selector = kind === "text"
        ? `.text-box[data-text-id="${item.id}"]`
        : `.overlay-box[data-overlay-id="${item.id}"]`;
      const element = app.querySelector(selector);
      if (element) element.classList.add("is-dragging");
      return element ? [element] : [];
    });
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      layers: layers.map((entry) => ({ ...entry, x: entry.item.x, y: entry.item.y })),
    };
    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - start.clientX) / state.stageWidth;
      const dy = (moveEvent.clientY - start.clientY) / state.stageHeight;
      start.layers.forEach((entry) => {
        entry.item.x = entry.x + dx;
        entry.item.y = entry.y + dy;
        if (entry.kind === "text") updateTextBox(entry.item);
        else updateOverlayBox(entry.item);
      });
      if (draggedKind === "overlay") {
        app.querySelector("[data-asset-trash]")?.classList.toggle("is-hot", pointerOverTrash(moveEvent));
      }
      scheduleSave();
    };
    const end = (endEvent) => {
      draggingBoxes.forEach((element) => element.classList.remove("is-dragging"));
      app.querySelector("[data-asset-trash]")?.classList.remove("is-hot");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (draggedKind === "overlay" && pointerOverTrash(endEvent || event)) deleteSelectedLayers();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginResize(event, box, handle) {
    event.preventDefault();
    event.stopPropagation();
    const text = selectedText();
    if (!text) return;
    recordHistory();
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: text.x,
      y: text.y,
      width: text.width,
      height: text.height,
      centerX: text.x + text.width / 2,
      centerY: text.y + text.height / 2,
      rotation: text.rotation || 0,
    };
    const minWidth = 0.1;
    const minHeight = 0.045;
    const move = (moveEvent) => {
      const delta = pointerDeltaInLayerAxes(moveEvent, start, start.rotation);
      const next = resizeLayerRect(start, handle, delta, {
        minWidth,
        minHeight,
      });
      text.width = next.width;
      text.height = next.height;
      text.x = next.x;
      text.y = next.y;
      updateTextBox(text);
      scheduleSave();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginTextRotate(event, box) {
    event.preventDefault();
    event.stopPropagation();
    const text = selectedText();
    if (!text) return;
    recordHistory();
    try { box.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const stage = app.querySelector(".stage");
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + (text.x + text.width / 2) * rect.width;
    const centerY = rect.top + (text.y + text.height / 2) * rect.height;
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const startRotation = text.rotation || 0;
    const move = (moveEvent) => {
      const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
      let degrees = startRotation + ((angle - startAngle) * 180) / Math.PI;
      if (moveEvent.shiftKey) degrees = Math.round(degrees / 15) * 15;
      text.rotation = ((degrees % 360) + 360) % 360;
      updateTextBox(text);
      scheduleSave();
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function beginImageDrag(event, stage) {
    event.preventDefault();
    const slide = activeSlide();
    if (!slide) return;
    recordHistory();
    stage.classList.add("is-moving-photo");
    try { stage.setPointerCapture(event.pointerId); } catch { /* Window tracking is the fallback. */ }
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      imageX: slide.imageX || 0,
      imageY: slide.imageY || 0,
    };
    const move = (moveEvent) => {
      slide.imageX = start.imageX + (moveEvent.clientX - start.clientX) / state.stageWidth;
      slide.imageY = start.imageY + (moveEvent.clientY - start.clientY) / state.stageHeight;
      constrainImagePosition(slide);
      updateStageImage(slide);
      scheduleSave();
    };
    const end = () => {
      stage.classList.remove("is-moving-photo");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return { bindOverlayBox, bindTextBox, activeTextEditingBox, isInlineTextEditing, endTextEditing, beginImageDrag };
}
