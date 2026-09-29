import assert from "node:assert/strict";
import test from "node:test";
import { editableDurationRounds, editableZoneSize } from "../scripts/config-input.js";
import { durationRoundsError } from "../scripts/duration.js";
import { defaultConfig, normalizeConfig, validateConfig } from "../scripts/zone-config.js";

test("missing legacy fields receive defaults while cleared dimensions remain invalid", () => {
  assert.equal(editableZoneSize(undefined, 15), 15);
  assert.equal(editableZoneSize(null, 10), 10);
  assert.equal(editableZoneSize("", 15), "");
  assert.equal(editableZoneSize("   ", 10), "");
  assert.equal(editableZoneSize("0", 15), 0);
  assert.equal(editableZoneSize("-5", 15), -5);
  assert.equal(editableZoneSize("25", 15), 25);
});

test("missing legacy durations receive a default while cleared custom durations remain blank", () => {
  assert.equal(editableDurationRounds(undefined, 1), 1);
  assert.equal(editableDurationRounds(null, 1), 1);
  assert.equal(editableDurationRounds("", 1), "");
  assert.equal(editableDurationRounds("   ", 1), "");
  assert.match(durationRoundsError(editableDurationRounds("", 1)), /positive whole number/);
  assert.equal(editableDurationRounds("0", 1), "0");
  assert.equal(editableDurationRounds("2d4", 1), "2d4");
});

test("unknown duration remains visible for validation while known legacy values migrate", () => {
  const config = defaultConfig();
  config.name = "Import";
  config.targeting.affects = "enemies";
  config.effects[0].triggers.activation = true;
  config.effects[0].chatAlert.enabled = true;
  config.duration.type = "until-next-moon";

  const normalized = normalizeConfig(config);
  assert.equal(normalized.duration.type, "until-next-moon");
  const validation = validateConfig(normalized);
  assert.match(validation.errors.join(" "), /until-next-moon.*unavailable/);
  assert.deepEqual(validation.issues.find((issue) => issue.target?.field === "duration-type")?.target, {
    scope: "zone", field: "duration-type"
  });
  assert.throws(() => normalizeConfig(config, { strict: true }), /until-next-moon.*not supported/);

  config.duration.type = "until-dismissed";
  assert.equal(normalizeConfig(config, { strict: true }).duration.type, "unlimited");
  config.duration.type = "1-round";
  assert.deepEqual(normalizeConfig(config, { strict: true }).duration, { type: "custom-rounds", rounds: 1 });
  config.visibility = "gm";
  config.effects[0].repeat = "once-per-activation";
  const migrated = normalizeConfig(config, { strict: true });
  assert.equal(migrated.visibility, "creator");
  assert.equal(migrated.effects[0].repeat, "once-per-zone");
});

test("import repairs missing and duplicate Effect Block IDs without changing the first occurrence", () => {
  const config = defaultConfig();
  config.name = "Imported IDs";
  config.targeting.affects = "enemies";
  config.effects[0].triggers.activation = true;
  config.effects[0].chatAlert.enabled = true;
  const blocks = Array.from({ length: 6 }, () => structuredClone(config.effects[0]));
  for (const [index, block] of blocks.entries()) block.name = `Effect Block ${index + 1}`;
  blocks[0].id = "shared";
  blocks[1].id = " shared ";
  blocks[2].id = "reserved";
  blocks[3].id = " ";
  blocks[4].id = "shared-1";
  delete blocks[5].id;
  config.effects = blocks;

  const oldFoundry = globalThis.foundry;
  globalThis.foundry = { utils: { randomID: () => "reserved" } };
  try {
    const rawErrors = validateConfig(config).errors.join(" ");
    assert.match(rawErrors, /shares ID 'shared'/);
    assert.match(rawErrors, /needs an ID/);

    const normalized = normalizeConfig(config);
    const ids = normalized.effects.map((block) => block.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.trim()));
    assert.equal(ids[0], "shared");
    assert.equal(ids[2], "reserved");
    assert.equal(ids[4], "shared-1");
    assert.notEqual(ids[1], "reserved", "generated IDs cannot take a later block's original ID");
    assert.deepEqual(normalizeConfig(normalized), normalized, "the migration is stable once saved");
    assert.deepEqual(normalizeConfig(config, { strict: true }).effects.map((block) => block.id), ids);
    assert.deepEqual(validateConfig(normalized).errors, []);
  } finally {
    globalThis.foundry = oldFoundry;
  }
});

test("unknown imported enum choices are rejected instead of changed to defaults", () => {
  const base = defaultConfig();
  base.name = "Import";
  const cases = [
    [(config) => { config.mode = "cone"; }, /Zone type.*cone/],
    [(config) => { config.targeting.affects = "foes"; }, /Affects.*foes/],
    [(config) => { config.effects[0].repeat = "occasionally"; }, /repeat setting.*occasionally/],
    [(config) => { config.effects[0].save.type = "luck"; }, /save type.*luck/],
    [(config) => { config.effects[0].immunity.starts = ["after-save", "whenever"]; }, /immunity start.*whenever/],
    [(config) => { config.effects[0].outcomes.noSave.conditions.push({ slug: "frightened", removal: "surprise" }); }, /condition removal.*surprise/]
  ];
  for (const [mutate, message] of cases) {
    const config = structuredClone(base);
    mutate(config);
    assert.throws(() => normalizeConfig(config), message);
  }
});

test("unknown condition and linked-condition slugs remain intact and receive field errors", () => {
  const config = defaultConfig();
  config.name = "Import";
  config.targeting.affects = "enemies";
  config.effects[0].triggers.activation = true;
  config.effects[0].chatAlert.enabled = true;
  config.effects[0].outcomes.noSave.conditions.push({
    slug: "mystery-condition", value: 2, removal: "condition-end", condition: "missing-link"
  });
  const normalized = normalizeConfig(config);
  const condition = normalized.effects[0].outcomes.noSave.conditions[0];
  assert.deepEqual([condition.slug, condition.value, condition.condition], ["mystery-condition", 2, "missing-link"]);
  const validation = validateConfig(normalized);
  assert.deepEqual(validation.issues.filter((issue) => issue.target?.conditionIndex === 0)
    .map((issue) => issue.target.field), ["condition-slug", "condition-link"]);

  condition.slug = "frightened";
  condition.condition = "sickened";
  assert.deepEqual(validateConfig(normalized).errors, []);
});

test("condition-recovery immunity requires its condition in an active outcome", () => {
  const config = defaultConfig();
  config.name = "Recovery validation";
  config.targeting.affects = "enemies";
  const block = config.effects[0];
  block.triggers.activation = true;
  block.immunity.duration = "1-round";
  block.immunity.starts = ["condition-recovery"];
  block.immunity.recoveryCondition = "sickened";
  block.outcomes.noSave.conditions.push({
    slug: "frightened", value: 1, removal: "normal", condition: ""
  });

  const missing = validateConfig(config);
  assert.match(missing.errors.join(" "), /must apply recovery condition 'sickened'.*active outcome/);
  assert.equal(missing.issues.find((issue) => issue.message.includes("must apply recovery condition"))?.target.field, "recovery-condition");

  block.outcomes.noSave.conditions.push({
    slug: "sickened", value: 1, removal: "normal", condition: ""
  });
  assert.deepEqual(validateConfig(config).errors, []);
});
