import assert from "node:assert/strict";
import test from "node:test";
import { highestClassOrSpellDc } from "../scripts/dc.js";

test("Class-or-Spell DC uses the highest prepared class or spell statistic", () => {
  const actor = {
    classDC: null,
    classDCs: {},
    spellcasting: { contents: [] },
    getStatistic(slug) {
      if (slug === "spell-dc") return { dc: { value: 27 } };
      if (slug === "class-spell") return { dc: { value: 0 } };
      return null;
    }
  };

  assert.equal(highestClassOrSpellDc(actor), 27);
});

test("Class-or-Spell DC includes every prepared class and spell statistic", () => {
  const actor = {
    classDC: { dc: { value: 24 } },
    classDCs: { kineticist: { dc: { value: 28 } } },
    spellcasting: { contents: [{ statistic: { dc: { value: 27 } } }] },
    getStatistic: () => null
  };

  assert.equal(highestClassOrSpellDc(actor), 28);
});
