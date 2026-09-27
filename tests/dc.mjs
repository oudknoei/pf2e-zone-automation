import assert from "node:assert/strict";
import test from "node:test";
import { actorStatisticDc, highestClassOrSpellDc, statisticDc } from "../scripts/dc.js";
import { defaultConfig, getDcChoices, validateConfig } from "../scripts/zone-config.js";

globalThis.game = { i18n: { localize: (key) => key } };

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

test("missing and nonpositive statistic values are unavailable", () => {
  for (const value of [null, undefined, "", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(statisticDc({ dc: { value } }), null);
  }
  assert.equal(statisticDc(null), null);
  assert.equal(statisticDc({ dc: { value: 27 } }), 27);

  const actor = {
    name: "Unprepared caster",
    classDC: null,
    classDCs: {},
    spellcasting: { contents: [] },
    getStatistic(slug) {
      if (slug === "spell-dc") return { dc: { value: null } };
      if (slug === "class-spell") return { dc: { value: 0 } };
      return null;
    }
  };
  assert.equal(actorStatisticDc(actor, "spell-dc"), null);
  assert.equal(highestClassOrSpellDc(actor), null);
  assert.deepEqual(getDcChoices(actor), []);
});

test("only resolved positive Actor DCs can be selected for a save", () => {
  const actor = {
    name: "Partial caster",
    classDC: { dc: { value: 27 }, label: "Primary Class DC" },
    classDCs: {},
    spellcasting: { contents: [] },
    getStatistic(slug) {
      if (slug === "spell-dc") return { dc: { value: null } };
      if (slug === "class-spell") return { dc: { value: 0 } };
      return null;
    }
  };
  const choices = getDcChoices(actor);
  assert.deepEqual(Object.fromEntries(choices.map(({ statistic, dc }) => [statistic, dc])), {
    "class-dc": 27, "class-spell": 27
  });
  assert.equal(actorStatisticDc(actor, "class-dc"), 27);

  const config = defaultConfig();
  config.name = "DC test";
  config.targeting.affects = "enemies";
  config.effects[0].triggers.activation = true;
  config.effects[0].chatAlert.enabled = true;
  config.effects[0].save.enabled = true;
  config.effects[0].save.dc = { mode: "actorStatistic", statistic: "spell-dc" };
  const invalid = validateConfig(config, { sourceActor: actor });
  assert.match(invalid.errors.join(" "), /spell-dc.*not available/);
  assert.equal(invalid.issues.find((issue) => issue.target?.field === "dc-source")?.target.index, 0);

  config.effects[0].save.dc.statistic = "class-dc";
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, []);
});
