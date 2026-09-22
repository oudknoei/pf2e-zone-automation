import assert from "node:assert/strict";
import test from "node:test";

import {
  durationRoundsError,
  normalizeDurationRounds,
  parseDurationRounds,
  resolveDurationRounds
} from "../scripts/duration.js";

test("duration rounds accept positive integers or safe dice formulas", () => {
  assert.deepEqual(parseDurationRounds(6), { kind: "number", rounds: 6 });
  assert.deepEqual(parseDurationRounds(" 2d4 + 1 "), { kind: "formula", formula: "2d4 + 1" });
  assert.equal(normalizeDurationRounds("2d4"), "2d4");
  assert.equal(durationRoundsError("2d4"), null);
  assert.match(durationRoundsError("@actor.level"), /positive whole number or a dice formula/);
  assert.match(durationRoundsError("0"), /positive whole number or a dice formula/);
});

test("duration formula is evaluated once and records its resolved round count", async () => {
  let evaluations = 0;
  class FixedRoll {
    constructor(formula) {
      assert.equal(formula, "2d4");
      this.total = 5;
    }

    async evaluate(options) {
      assert.deepEqual(options, { async: true });
      evaluations += 1;
      return this;
    }
  }

  const resolved = await resolveDurationRounds(
    { type: "custom-rounds", rounds: "2d4" },
    { RollClass: FixedRoll }
  );

  assert.deepEqual(resolved, { rounds: 5, formula: "2d4" });
  assert.equal(evaluations, 1);
});

test("formula durations reject non-integer or non-positive totals", async () => {
  class FractionalRoll {
    async evaluate() {
      return { total: 2.5 };
    }
  }

  await assert.rejects(
    resolveDurationRounds({ type: "custom-rounds", rounds: "1d4 / 2" }, { RollClass: FractionalRoll }),
    /positive whole number of rounds/
  );
  assert.deepEqual(await resolveDurationRounds({ type: "1-minute" }), { rounds: 10, formula: null });
});
test("duration formulas use Foundry's parser before they are rolled", async () => {
  const checked = [];
  class SyntaxRoll {
    static validate(formula) {
      checked.push(formula);
      return formula !== "2d4 +";
    }
    async evaluate() {
      assert.fail("an invalid formula must not be rolled");
    }
  }

  assert.equal(durationRoundsError("2d4", { RollClass: SyntaxRoll }), null);
  assert.match(durationRoundsError("2d4 +", { RollClass: SyntaxRoll }), /Foundry does not recognize/);
  await assert.rejects(
    resolveDurationRounds({ type: "custom-rounds", rounds: "2d4 +" }, { RollClass: SyntaxRoll }),
    /Foundry does not recognize/
  );
  assert.deepEqual(checked, ["2d4", "2d4 +", "2d4 +"]);
});
