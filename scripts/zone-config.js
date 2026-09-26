import { editableDurationRounds, editableZoneSize } from "./config-input.js";
import { durationRoundsError } from "./duration.js";
import { highestClassOrSpellDc, statisticDc as statDc } from "./dc.js";
import { hasTargetSelection } from "./targeting.js";
import { pf2eFormulaError } from "./formula-validation.js";

export const SCHEMA_VERSION = 13;
/** Keeps saved trait labels and validation messages readable. */
const titleCase = (slug) => String(slug ?? "").replaceAll("-", " ").replace(/\b\w/g, (m) => m.toUpperCase());
/** Uses PF2e translations when the system provides one. */
const localize = (key, fallback) => {
  if (typeof key !== "string") return fallback;
  const localized = game.i18n.localize(key);
  return localized && localized !== key ? localized : fallback;
};

/** Gives unsaved blocks stable identities so UI edits can target the intended block. */
const newId = () => globalThis.foundry?.utils?.randomID?.(8) ?? crypto.randomUUID().slice(0, 8);


/** Keeps checkbox and custom trait input portable as normalized PF2e slugs. */
function normalizeTraitSlugs(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter(Boolean))];
}

/** Preserves older single-trait configurations while supporting the current multi-trait editor. */
function watchedTraitSlugs(traitUse) {
  return normalizeTraitSlugs([traitUse?.traits ?? [], traitUse?.trait ?? ""]);
}


// PF2e conditions whose system data carries a numeric value.
// Unvalued conditions such as Concealed or Prone serialize with value: null.
const VALUED_CONDITIONS = new Set([
  "clumsy", "doomed", "drained", "dying", "enfeebled", "frightened",
  "sickened", "slowed", "stunned", "stupefied", "wounded"
]);

const OUTCOMES = [
  ["criticalSuccess", "Critical Success"],
  ["success", "Success"],
  ["failure", "Failure"],
  ["criticalFailure", "Critical Failure"],
  ["noSave", "No Save"]
];

const BASIC_MULTIPLIERS = {
  criticalSuccess: 0,
  success: 0.5,
  failure: 1,
  criticalFailure: 2,
  noSave: 1
};


/** Prevents the UI from asking for meaningless numeric values on binary conditions. */
function isValuedCondition(slug) {
  return VALUED_CONDITIONS.has(String(slug ?? ""));
}


/** Retains system-provided statistic labels without making a missing translation block the builder. */
function statLabel(stat, fallback) {
  const label = stat?.label;
  if (typeof label === "string") return localize(label, label) || fallback;
  return fallback;
}

/**
 * Return portable DC selectors. We deliberately avoid spellcasting-entry IDs:
 * those IDs are actor-specific and would make exported JSON non-portable.
 */
function getDcChoices(actor) {
  const found = [];
  const seen = new Set();

  /** Filters incomplete actor statistics so invalid preparation data cannot become a selectable DC. */
  const add = (statistic, label, dc) => {
    if (!statistic || seen.has(statistic) || !Number.isFinite(Number(dc))) return;
    seen.add(statistic);
    found.push({ statistic, label, dc: Number(dc) });
  };

  try {
    if (actor.classDC) {
      add("class-dc", `${statLabel(actor.classDC, "Primary Class DC")} (Primary Class DC)`, statDc(actor.classDC));
    }
  } catch (_err) { /* actor type may not expose classDC */ }

  try {
    for (const [slug, stat] of Object.entries(actor.classDCs ?? {})) {
      add(slug, `${statLabel(stat, titleCase(slug))} (Class DC)`, statDc(stat));
    }
  } catch (_err) { /* ignore */ }

  try {
    add("spell-dc", "Highest Spell DC", statDc(actor.getStatistic?.("spell-dc")));
  } catch (_err) { /* not supported by this actor type */ }

  // PF2e's combined statistic can retain an unprepared 0 during actor data
  // updates. Calculate its value from prepared class and spell statistics,
  // and do the same when a save is resolved.
  const classOrSpellDc = highestClassOrSpellDc(actor);
  if (classOrSpellDc !== null) add("class-spell", "Highest Class or Spell DC", classOrSpellDc);

  // Avoid duplicate primary class choices that resolve to exactly the same slug/DC.
  return found.sort((a, b) => b.dc - a.dc || a.label.localeCompare(b.label));
}


/** Provides an explicit result shape so every degree of success can be edited safely. */
function emptyOutcome(key) {
  return {
    damageMultiplier: BASIC_MULTIPLIERS[key] ?? 1,
    conditions: [],
    effects: []
  };
}

/** Starts each Effect Block without hidden behavior so the user must choose its triggers and results. */
function newBlock(index = 1) {
  return {
    id: newId(),
    name: `Effect Block ${index}`,
    triggers: {
      activation: false,
      enter: false,
      turnStart: false,
      sourceTurnStart: false,
      turnEnd: false,
      continuous: false,
      traitUse: false,
      spellCast: false
    },
    traitUse: {
      traits: []
    },
    chatAlert: {
      enabled: false,
      text: "{zone}: {creature} triggered {block}."
    },
    repeat: "once-per-round",
    save: {
      enabled: false,
      type: "will",
      choices: ["reflex", "will"],
      dc: { mode: "custom", value: "" },
      basic: false
    },
    damage: {
      enabled: false,
      formula: "",
      typeMode: "fixed",
      type: "untyped"
    },
    healing: {
      enabled: false,
      formula: ""
    },
    outcomes: Object.fromEntries(OUTCOMES.map(([key]) => [key, emptyOutcome(key)])),
    immunity: {
      duration: "none",
      starts: [],
      recoveryCondition: "sickened"
    }
  };
}

/** Makes important zone decisions visible instead of silently assuming traits, triggers, or a name. */
function defaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: "",
    mode: "emanation",
    areaShape: "circle",
    radius: 15,
    sideLength: 10,
    visibility: "all",
    targeting: {
      affects: "none",
      includeSelf: false
    },
    traits: [],
    duration: {
      type: "unlimited",
      rounds: 1
    },
    activationChoices: {
      damageType: {
        enabled: false,
        options: ["bludgeoning", "piercing", "slashing"]
      }
    },
    effects: [newBlock(1)]
  };
}

/** Repairs incomplete imported result data so presets from older versions remain editable. */
function ensureOutcome(outcome, key) {
  const base = emptyOutcome(key);
  return {
    damageMultiplier: Number.isFinite(Number(outcome?.damageMultiplier))
      ? Number(outcome.damageMultiplier)
      : base.damageMultiplier,
    conditions: Array.isArray(outcome?.conditions)
      ? outcome.conditions.map((c) => {
          const slug = String(c?.slug ?? "frightened");
          const removal = ["normal", "on-exit", "zone-end", "condition-end"].includes(c?.removal)
            ? c.removal
            : "normal";
          return {
            slug,
            value: isValuedCondition(slug)
              ? Math.max(1, Math.floor(Number(c?.value) || 1))
              : null,
            removal,
            condition: removal === "condition-end"
              ? String(c?.condition ?? "sickened")
              : null
          };
        })
      : [],
    effects: Array.isArray(outcome?.effects)
      ? outcome.effects.map((e) => ({
          uuid: String(e?.uuid ?? "").trim(),
          removal: ["item-duration", "on-exit", "zone-end"].includes(e?.removal) ? e.removal : "item-duration"
        }))
      : []
  };
}

/** Moves imported and saved configurations into one current shape before the UI uses them. */
function normalizeConfig(input, { strict = false } = {}) {
  const base = defaultConfig();
  const cfg = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (strict) {
    if (!String(cfg.name ?? "").trim()) throw new Error("Zone name is required.");
    if (cfg.mode != null && !["area", "emanation"].includes(cfg.mode)) throw new Error("Zone type is invalid.");
    if (cfg.areaShape != null && !["circle", "square"].includes(cfg.areaShape)) throw new Error("Area shape is invalid.");
    if (cfg.visibility != null && !["all", "creator", "gm"].includes(cfg.visibility)) throw new Error("Visibility is invalid.");
    if (!Array.isArray(cfg.effects) || !cfg.effects.length) throw new Error("At least one effect block is required.");
  }

  const traits = Array.isArray(cfg.traits)
    ? normalizeTraitSlugs(cfg.traits)
    : base.traits;

  const importedVisibility = cfg.visibility === "gm" ? "creator" : cfg.visibility;
  const result = {
    schemaVersion: SCHEMA_VERSION,
    name: String(cfg.name ?? base.name).trim(),
    mode: ["area", "emanation"].includes(cfg.mode) ? cfg.mode : base.mode,
    areaShape: cfg.areaShape === "square" ? "square" : "circle",
    radius: editableZoneSize(cfg.radius, base.radius),
    sideLength: editableZoneSize(cfg.sideLength, base.sideLength),
    visibility: ["all", "creator"].includes(importedVisibility) ? importedVisibility : base.visibility,
    targeting: {
      affects: ["enemies", "allies", "both", "none"].includes(cfg.targeting?.affects)
        ? cfg.targeting.affects
        : base.targeting.affects,
      includeSelf: Boolean(cfg.targeting?.includeSelf)
    },
    traits,
    duration: {
      type: cfg.duration?.type === "until-dismissed"
        ? "unlimited"
        : cfg.duration?.type === "1-round"
          ? "custom-rounds"
          : ["custom-rounds", "1-minute", "10-minutes", "unlimited"].includes(cfg.duration?.type)
            ? cfg.duration.type
            : base.duration.type,
      rounds: cfg.duration?.type === "1-round"
        ? 1
        : editableDurationRounds(cfg.duration?.rounds, base.duration.rounds)
    },
    activationChoices: {
      damageType: {
        enabled: Boolean(cfg.activationChoices?.damageType?.enabled),
        options: Array.isArray(cfg.activationChoices?.damageType?.options)
          ? [...new Set(cfg.activationChoices.damageType.options.map((x) => String(x).trim()).filter(Boolean))]
          : [...base.activationChoices.damageType.options]
      }
    },
    effects: []
  };

  const effects = Array.isArray(cfg.effects) && cfg.effects.length ? cfg.effects : base.effects;
  result.effects = effects.map((block, index) => {
    const saveMode = block?.save?.dc?.mode === "actorStatistic" ? "actorStatistic" : "custom";
    const rawCustomDc = block?.save?.dc?.value;
    const customDc = rawCustomDc == null || String(rawCustomDc).trim() === ""
      ? ""
      : Number.isFinite(Number(rawCustomDc))
        ? Math.max(0, Number(rawCustomDc))
        : "";
    const dc = saveMode === "actorStatistic"
      ? { mode: "actorStatistic", statistic: String(block?.save?.dc?.statistic ?? "class-dc") }
      : { mode: "custom", value: customDc };

    const outcomes = {};
    for (const [key] of OUTCOMES) outcomes[key] = ensureOutcome(block?.outcomes?.[key], key);

    return {
      id: String(block?.id ?? newId()),
      name: String(block?.name ?? `Effect Block ${index + 1}`).trim() || `Effect Block ${index + 1}`,
      triggers: {
        activation: Boolean(block?.triggers?.activation),
        enter: Boolean(block?.triggers?.enter),
        turnStart: Boolean(block?.triggers?.turnStart),
        sourceTurnStart: Boolean(block?.triggers?.sourceTurnStart),
        turnEnd: Boolean(block?.triggers?.turnEnd),
        continuous: Boolean(block?.triggers?.continuous),
        traitUse: Boolean(block?.triggers?.traitUse),
        spellCast: Boolean(block?.triggers?.spellCast)
      },
      traitUse: {
        traits: watchedTraitSlugs(block?.traitUse)
      },
      chatAlert: {
        enabled: block?.chatAlert?.enabled != null
          ? Boolean(block.chatAlert.enabled)
          : Boolean(block?.triggers?.traitUse && block?.traitUse?.alertText),
        text: String(
          block?.chatAlert?.text
          ?? block?.traitUse?.alertText
          ?? "{zone}: {creature} triggered {block}."
        ).trim()
      },
      repeat: ["every", "once-per-round", "once-per-zone", "once-per-activation"].includes(block?.repeat)
        ? (block.repeat === "once-per-activation" ? "once-per-zone" : block.repeat)
        : "once-per-round",
      save: {
        enabled: Boolean(block?.save?.enabled),
        type: ["fortitude", "reflex", "will", "choice"].includes(block?.save?.type) ? block.save.type : "will",
        choices: Array.isArray(block?.save?.choices)
          ? [...new Set(block.save.choices.filter((x) => ["fortitude", "reflex", "will"].includes(x)))]
          : ["reflex", "will"],
        dc,
        basic: Boolean(block?.save?.basic)
      },
      damage: {
        enabled: Boolean(block?.damage?.enabled),
        formula: String(block?.damage?.formula ?? "").trim(),
        typeMode: block?.damage?.typeMode === "activation-choice" ? "activation-choice" : "fixed",
        type: String(block?.damage?.type ?? "untyped")
      },
      healing: {
        enabled: Boolean(block?.healing?.enabled),
        formula: String(block?.healing?.formula ?? "").trim()
      },
      outcomes,
      immunity: {
        duration: ["none", "1-round", "1-minute", "10-minutes"].includes(block?.immunity?.duration)
          ? block.immunity.duration
          : "none",
        starts: Array.isArray(block?.immunity?.starts)
          ? [...new Set(block.immunity.starts.filter((x) => [
              "after-save", "success-or-better", "failure-or-worse", "affected", "condition-recovery"
            ].includes(x)))]
          : [],
        recoveryCondition: String(block?.immunity?.recoveryCondition ?? "sickened")
      }
    };
  });

  // A Basic save always uses the standard PF2e degree multipliers.
  for (const block of result.effects) {
    if (block.save.enabled && block.save.basic) {
      for (const key of ["criticalSuccess", "success", "failure", "criticalFailure"]) {
        block.outcomes[key].damageMultiplier = BASIC_MULTIPLIERS[key];
      }
    }
    if (!block.save.enabled) block.outcomes.noSave.damageMultiplier = 1;
  }

  // Intentionally no origin/source actor or token data in the serializable config.
  return result;
}


/** Lets validation distinguish an intentionally empty block from one with an actual result. */
function getPayloadCount(block) {
  const keys = block.save.enabled
    ? ["criticalSuccess", "success", "failure", "criticalFailure"]
    : ["noSave"];
  return keys.reduce((count, key) => {
    const outcome = block.outcomes[key];
    return count + outcome.conditions.length + outcome.effects.length;
  }, 0);
}

/** Stops a zone from being created when the runtime could not apply it predictably. */
function validateConfig(cfg, { sourceActor, requireCurrentSource = false, currentSourceMatches = true } = {}) {
  const errors = [];
  const warnings = [];
  const issues = [];
  const dcChoices = getDcChoices(sourceActor);
  /** Keeps validation errors tied to their field so the UI can explain how to fix them. */
  const error = (message, target = null) => {
    errors.push(message);
    if (target) issues.push({ message, target });
  };
  /** Provides a stable location for errors in a block list whose rows can be added or removed. */
  const blockTarget = (index, field, extra = {}) => ({ scope: "block", index, field, ...extra });

  if (requireCurrentSource && !currentSourceMatches) {
    error("The controlled token has changed. Click 'Use Current Selection' before continuing.", { scope: "source" });
  }
  if (!cfg.name) error("Zone name is required.", { scope: "zone", field: "name" });
  if (cfg.mode !== "area" || cfg.areaShape === "circle") {
    if (!Number.isFinite(cfg.radius) || cfg.radius <= 0 || cfg.radius > 1000) error("Radius must be greater than 0 and no more than 1,000 feet.", { scope: "zone", field: "radius" });
  } else if (!Number.isFinite(cfg.sideLength) || cfg.sideLength <= 0 || cfg.sideLength > 1000) {
    error("Side length must be greater than 0 and no more than 1,000 feet.", { scope: "zone", field: "side-length" });
  }
  if (!hasTargetSelection(cfg.targeting)) error("Select at least one target: Allies, Enemies, or Self (Source Actor).", { scope: "zone", field: "targeting" });
  if (cfg.duration?.type === "custom-rounds") {
    const durationError = durationRoundsError(cfg.duration.rounds);
    if (durationError) error(durationError, { scope: "zone", field: "duration-rounds" });
  }
  if (!cfg.effects.length) error("At least one effect block is required.", { scope: "blocks" });

  const sharedDamageChoice = cfg.activationChoices?.damageType;
  if (sharedDamageChoice?.enabled) {
    if (!sharedDamageChoice.options.length) {
      error("Shared activation damage type is enabled but no allowed damage types are selected.", { scope: "activation-damage-choice" });
    } else if (sharedDamageChoice.options.length === 1) {
      warnings.push("Shared activation damage type has only one allowed type; a fixed damage type may be simpler.");
    }
  }

  cfg.effects.forEach((block, index) => {
    const prefix = `${block.name || `Effect Block ${index + 1}`}:`;
    if (!Object.values(block.triggers).some(Boolean)) {
      error(`${prefix} select at least one trigger.`, blockTarget(index, "triggers"));
    }
    if (block.triggers.traitUse && !watchedTraitSlugs(block.traitUse).length) {
      error(`${prefix} On Trait Use requires at least one watched trait.`, blockTarget(index, "trait-use-traits"));
    }
    if (block.chatAlert?.enabled && !block.chatAlert?.text) {
      error(`${prefix} Chat Alert is enabled but no alert text was entered.`, blockTarget(index, "chat-alert-text"));
    }

    if (block.save.enabled && block.triggers.continuous) {
      error(`${prefix} "While a creature is inside" cannot require a saving throw. Use a separate Effect Block for ongoing No Save effects and another for save triggers.`, blockTarget(index, "save-enabled"));
    }

    if (block.save.enabled) {
      if (block.save.type === "choice" && block.save.choices.length < 2) {
        error(`${prefix} target-choice save requires at least two allowed saves.`, blockTarget(index, "save-choices"));
      }
      if (block.save.dc.mode === "custom") {
        if (!(Number(block.save.dc.value) > 0)) {
          error(`${prefix} custom save DC must be greater than 0.`, blockTarget(index, "custom-dc"));
        }
      } else if (!dcChoices.some((x) => x.statistic === block.save.dc.statistic)) {
        error(`${prefix} DC statistic '${block.save.dc.statistic}' is not available on ${sourceActor.name}.`, blockTarget(index, "dc-source"));
      }
    }

    if (block.damage.enabled) {
      const type = block.damage.typeMode === "activation-choice" ? "untyped" : (block.damage.type ?? "untyped");
      const formulaError = pf2eFormulaError(block.damage.formula, type);
      if (formulaError) error(`${prefix} damage: ${formulaError}`, blockTarget(index, "damage-formula"));
    }
    if (block.healing?.enabled) {
      const formulaError = pf2eFormulaError(block.healing.formula, "healing");
      if (formulaError) error(`${prefix} healing: ${formulaError}`, blockTarget(index, "healing-formula"));
    }
    if (block.damage.enabled && block.damage.typeMode === "activation-choice" && !sharedDamageChoice?.enabled) {
      error(`${prefix} uses the shared activation damage type, but that zone-level choice is not enabled.`, blockTarget(index, "damage-type-mode"));
    }

    for (const [outcomeKey, outcome] of Object.entries(block.outcomes)) {
      for (const [conditionIndex, condition] of (outcome.conditions ?? []).entries()) {
        if (condition.removal === "condition-end") {
          if (!condition.condition) {
            error(
              `${prefix} ${titleCase(outcomeKey)} condition '${condition.slug}' must name the condition that ends it.`,
              blockTarget(index, "condition-link", { outcomeKey, conditionIndex })
            );
          } else if (condition.condition === condition.slug) {
            warnings.push(`${prefix} ${titleCase(outcomeKey)} condition '${condition.slug}' is set to end when itself ends.`);
          }
        }
      }
    }

    const relevantOutcomes = block.save.enabled
      ? ["criticalSuccess", "success", "failure", "criticalFailure"]
      : ["noSave"];

    for (const key of relevantOutcomes) {
      const outcome = block.outcomes[key];
      outcome.effects.forEach((effect, effectIndex) => {
        if (!effect.uuid) {
          error(`${prefix} ${titleCase(key)} Effect Item ${effectIndex + 1} has no UUID.`, blockTarget(index, "effect-uuid", { outcomeKey: key, effectIndex }));
        }
      });
    }

    if (!block.damage.enabled && !block.healing?.enabled && getPayloadCount(block) === 0 && !block.chatAlert?.enabled) {
      warnings.push(`${prefix} has no damage, healing, conditions, Effect Items, or Chat Alert in its active outcomes.`);
    }

    if (block.immunity.duration !== "none" && block.immunity.starts.length === 0) {
      error(`${prefix} immunity has a duration but no start condition.`, blockTarget(index, "immunity-starts"));
    }
    if (block.immunity.starts.includes("after-save") && !block.save.enabled) {
      warnings.push(`${prefix} 'After any save' immunity is selected but this block has no save.`);
    }
    if (block.immunity.starts.includes("condition-recovery") && !block.immunity.recoveryCondition) {
      error(`${prefix} choose a recovery condition for condition-based immunity.`, blockTarget(index, "recovery-condition"));
    }
    if (block.triggers.continuous && (block.damage.enabled || block.healing?.enabled)) {
      warnings.push(`${prefix} continuous damage/healing will need special runtime semantics; verify this is intentional.`);
    }
  });

  return { errors, warnings, issues };
}


export {
  OUTCOMES, BASIC_MULTIPLIERS, newId, normalizeTraitSlugs, watchedTraitSlugs,
  isValuedCondition, getDcChoices, emptyOutcome, newBlock, defaultConfig,
  normalizeConfig, validateConfig
};
