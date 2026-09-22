import assert from "node:assert/strict";
import test from "node:test";

import { hasTargetSelection, storedTargeting, targetLabels, targetingChoices } from "../scripts/targeting.js";

test("saved targeting values round-trip through the independent checkboxes", () => {
  for (const affects of ["allies", "enemies", "both"]) {
    for (const includeSelf of [false, true]) {
      const saved = { affects, includeSelf };
      assert.deepEqual(storedTargeting(targetingChoices(saved)), saved);
      assert.equal(hasTargetSelection(saved), true);
    }
  }
});

test("blank and self-only choices use the existing targeting fields", () => {
  assert.deepEqual(storedTargeting(), { affects: "none", includeSelf: false });
  assert.equal(hasTargetSelection(storedTargeting()), false);

  const selfOnly = storedTargeting({ self: true });
  assert.deepEqual(selfOnly, { affects: "none", includeSelf: true });
  assert.deepEqual(targetingChoices(selfOnly), { allies: false, enemies: false, self: true });
  assert.deepEqual(targetLabels(selfOnly), ["Self (Source Actor)"]);
  assert.equal(hasTargetSelection(selfOnly), true);
  assert.equal(hasTargetSelection({ affects: "unknown", includeSelf: true }), false);
});
