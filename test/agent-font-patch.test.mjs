import test from "node:test";
import assert from "node:assert/strict";

import { reconcileAgentFontWeightPatch } from "../src/agent-font-patch.mjs";

test("keeps agent fontWeight and the wght variation axis synchronized", () => {
  const variationOnly = { fontWeight: 500, fontVariationSettings: { wght: 725, wdth: 90 } };
  reconcileAgentFontWeightPatch(variationOnly, { fontVariationSettings: { wght: 725, wdth: 90 } });
  assert.equal(variationOnly.fontWeight, 725);

  const existingSettings = { wght: 500, wdth: 90 };
  const weightOnly = { fontWeight: 650, fontVariationSettings: existingSettings };
  reconcileAgentFontWeightPatch(weightOnly, { fontWeight: 650 });
  assert.deepEqual(weightOnly.fontVariationSettings, { wght: 650, wdth: 90 });
  assert.deepEqual(existingSettings, { wght: 500, wdth: 90 }, "candidate reconciliation must not mutate the stored layer before commit");

  const matching = { fontWeight: 700, fontVariationSettings: { wght: 700 } };
  assert.equal(reconcileAgentFontWeightPatch(matching, { fontWeight: 700, fontVariationSettings: { wght: 700 } }), matching);
});

test("rejects contradictory agent fontWeight and wght values", () => {
  const text = { fontWeight: 600, fontVariationSettings: { wght: 700 } };
  assert.throws(
    () => reconcileAgentFontWeightPatch(text, { fontWeight: 600, fontVariationSettings: { wght: 700 } }),
    (error) => error.code === "FONT_WEIGHT_CONFLICT" && /same value/.test(error.message),
  );
});
