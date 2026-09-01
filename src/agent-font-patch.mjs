function fontWeightConflict(message) {
  const error = new Error(`[FONT_WEIGHT_CONFLICT] ${message}`);
  error.code = "FONT_WEIGHT_CONFLICT";
  return error;
}

/** Keep the high-level font weight and the low-level wght axis as one source of truth. */
export function reconcileAgentFontWeightPatch(text, patch = {}) {
  const settings = text?.fontVariationSettings && typeof text.fontVariationSettings === "object"
    ? { ...text.fontVariationSettings }
    : {};
  const hasVariationWeight = Object.hasOwn(settings, "wght") && Number.isFinite(Number(settings.wght));
  const patchedVariationWeight = patch.fontVariationSettings != null
    && Object.hasOwn(patch.fontVariationSettings, "wght")
    && hasVariationWeight;
  const patchedFontWeight = patch.fontWeight != null;

  if (patchedVariationWeight && patchedFontWeight && Number(settings.wght) !== Number(text.fontWeight)) {
    throw fontWeightConflict("fontWeight and fontVariationSettings.wght must resolve to the same value.");
  }
  if (patchedVariationWeight) {
    text.fontWeight = Number(settings.wght);
  } else if (patchedFontWeight && hasVariationWeight) {
    settings.wght = Number(text.fontWeight);
  }
  if (hasVariationWeight && (patchedVariationWeight || patchedFontWeight)) text.fontVariationSettings = settings;
  return text;
}
