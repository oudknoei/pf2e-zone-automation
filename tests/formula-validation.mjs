import assert from "node:assert/strict";
import test from "node:test";

import { pf2eFormulaError } from "../scripts/formula-validation.js";

test("damage and healing formulas are checked in their runtime PF2e wrappers", () => {
  const checked = [];
  class DamageRoll {
    static validate(formula) {
      checked.push(formula);
      return !formula.includes("2d6+");
    }
  }

  assert.equal(pf2eFormulaError("2d6 + 3", "fire", { DamageRollClass: DamageRoll }), null);
  assert.equal(pf2eFormulaError("1d8", "healing", { DamageRollClass: DamageRoll }), null);
  assert.match(pf2eFormulaError("2d6+", "fire", { DamageRollClass: DamageRoll }), /does not recognize/);
  assert.deepEqual(checked, ["{(2d6 + 3)[fire]}", "{(1d8)[healing]}", "{(2d6+)[fire]}"]);
});

test("formula validation fails clearly when the PF2e validator is unavailable", () => {
  assert.match(pf2eFormulaError("", "fire", { DamageRollClass: null }), /Enter a formula/);
  assert.match(pf2eFormulaError("1d6", "fire", { DamageRollClass: null }), /unavailable/);
});
