import {
  SCHEMA_VERSION,
  OUTCOMES,
  newId,
  isValuedCondition,
  conditionSlugs,
  normalizeTraitSlugs,
  normalizeConfig
} from "./zone-config.js";
import { editableZoneSize } from "./config-input.js";
import { storedTargeting } from "./targeting.js";
import { zoneTypeFields } from "./area-shape.js";

/** Keeps selector lookup in one place so form reads fail consistently if the UI changes. */
export function field(root, selector) {
  return root.querySelector(selector);
}

/** Converts outcome controls into portable data before validation or saving. */
export function readOutcome(outcomeEl, key) {
  const conditions = [...outcomeEl.querySelectorAll(".zb-condition-row")].map((row) => {
    const slug = row.querySelector('[data-field="condition-slug"]').value;
    const rawValue = row.querySelector('[data-field="condition-value"]').value.trim();
    const removal = row.querySelector('[data-field="condition-removal"]').value;

    return {
      slug,
      value: isValuedCondition(slug)
        ? Math.max(1, Math.floor(Number(rawValue) || 1))
        : conditionSlugs().includes(slug) ? null : (rawValue === "" ? null : Number(rawValue)),
      removal,
      condition: removal === "condition-end"
        ? row.querySelector('[data-field="condition-link"]').value
        : null
    };
  });

  const effects = [...outcomeEl.querySelectorAll(".zb-effect-row")].map((row) => ({
    uuid: row.querySelector('[data-field="effect-uuid"]').value.trim(),
    removal: row.querySelector('[data-field="effect-removal"]').value
  }));

  return {
    damageMultiplier: Number(outcomeEl.querySelector('[data-field="damage-multiplier"]').value),
    conditions,
    effects
  };
}

/** Treats the form as input only and produces a serializable zone configuration for all actions. */
export function readConfig(root) {
  const commonTraits = [...root.querySelectorAll("[data-trait]:checked")].map((x) => x.dataset.trait);
  const customTraits = field(root, '[data-zone="custom-traits"]').value
    .split(",")
    .map((x) => x.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean);

  const cfg = {
    schemaVersion: SCHEMA_VERSION,
    name: field(root, '[data-zone="name"]').value.trim(),
    ...zoneTypeFields(field(root, '[data-zone="mode"]').value),
    radius: editableZoneSize(field(root, '[data-zone="radius"]').value),
    sideLength: editableZoneSize(field(root, '[data-zone="side-length"]').value),
    visibility: field(root, '[data-zone="visibility"]').value,
    targeting: {
      ...storedTargeting({
        allies: field(root, '[data-zone="affects-allies"]').checked,
        enemies: field(root, '[data-zone="affects-enemies"]').checked,
        self: field(root, '[data-zone="affects-self"]').checked
      }),
      lineOfEffect: field(root, '[data-zone="line-of-effect"]').value
    },
    traits: [...new Set([...commonTraits, ...customTraits])],
    duration: {
      type: field(root, '[data-zone="duration-type"]').value,
      rounds: field(root, '[data-zone="duration-rounds"]').value.trim()
    },
    activationChoices: {
      damageType: {
        enabled: field(root, '[data-zone="damage-choice-enabled"]').checked,
        options: [...root.querySelectorAll("[data-damage-choice-type]:checked")].map((x) => x.dataset.damageChoiceType)
      }
    },
    effects: []
  };

  for (const [index, blockEl] of [...root.querySelectorAll("[data-block-id]")].entries()) {
    const watchedTraits = [...blockEl.querySelectorAll("[data-trait-use-trait]:checked")].map((input) => input.dataset.traitUseTrait);
    const customWatchedTraits = normalizeTraitSlugs(blockEl.querySelector('[data-field="trait-use-custom-traits"]').value);
    const dcSource = blockEl.querySelector('[data-field="dc-source"]').value;
    const rawCustomDc = blockEl.querySelector('[data-field="custom-dc"]').value.trim();
    const dc = dcSource === "custom"
      ? { mode: "custom", value: rawCustomDc === "" ? "" : Number(rawCustomDc) }
      : { mode: "actorStatistic", statistic: dcSource.replace(/^stat:/, "") };

    const outcomes = {};

    for (const [key] of OUTCOMES) {
      const outcomeEl = blockEl.querySelector(`[data-outcome="${key}"]`);

      outcomes[key] = readOutcome(outcomeEl, key);
    }

    cfg.effects.push({
      id: blockEl.dataset.blockId || newId(),
      name: blockEl.querySelector('[data-field="block-name"]').value.trim() || `Effect Block ${index + 1}`,
      triggers: {
        activation: blockEl.querySelector('[data-trigger="activation"]').checked,
        enter: blockEl.querySelector('[data-trigger="enter"]').checked,
        turnStart: blockEl.querySelector('[data-trigger="turnStart"]').checked,
        sourceTurnStart: blockEl.querySelector('[data-trigger="sourceTurnStart"]').checked,
        turnEnd: blockEl.querySelector('[data-trigger="turnEnd"]').checked,
        continuous: blockEl.querySelector('[data-trigger="continuous"]').checked,
        traitUse: blockEl.querySelector('[data-trigger="traitUse"]').checked,
        spellCast: blockEl.querySelector('[data-trigger="spellCast"]').checked,
        hpThreshold: blockEl.querySelector('[data-trigger="hpThreshold"]').checked
      },
      hitPoints: { threshold: blockEl.querySelector('[data-field="hp-threshold"]').value.trim() },
      traitUse: {
        traits: [...new Set([...watchedTraits, ...customWatchedTraits])]
      },
      chatAlert: {
        enabled: blockEl.querySelector('[data-field="chat-alert-enabled"]').checked,
        text: blockEl.querySelector('[data-field="chat-alert-text"]').value.trim()
      },
      repeat: blockEl.querySelector('[data-field="repeat"]').value,
      save: {
        enabled: blockEl.querySelector('[data-field="save-enabled"]').checked,
        type: blockEl.querySelector('[data-field="save-type"]').value,
        choices: [...blockEl.querySelectorAll("[data-save-choice]:checked")].map((x) => x.dataset.saveChoice),
        dc,
        basic: blockEl.querySelector('[data-field="basic-save"]').checked
      },
      damage: {
        enabled: blockEl.querySelector('[data-field="damage-enabled"]').checked,
        formula: blockEl.querySelector('[data-field="damage-formula"]').value.trim(),
        typeMode: blockEl.querySelector('[data-field="damage-type-mode"]').value,
        type: blockEl.querySelector('[data-field="damage-type"]').value
      },
      healing: {
        enabled: blockEl.querySelector('[data-field="healing-enabled"]').checked,
        formula: blockEl.querySelector('[data-field="healing-formula"]').value.trim()
      },
      outcomes,
      immunity: {
        duration: blockEl.querySelector('[data-field="immunity-duration"]').value,
        starts: [...blockEl.querySelectorAll("[data-immunity-start]:checked")].map((x) => x.dataset.immunityStart),
        recoveryCondition: blockEl.querySelector('[data-field="recovery-condition"]').value,
        scope: blockEl.querySelector('[data-field="immunity-scope"]').value,
        group: blockEl.querySelector('[data-field="immunity-group"]').value
      }
    });
  }

  return normalizeConfig(cfg);
}
