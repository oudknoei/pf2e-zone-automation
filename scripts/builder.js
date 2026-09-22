import { zoneRuntimeEntrypoint } from "./runtime.js";
import { durationRoundsError, normalizeDurationRounds, parseDurationRounds, resolveDurationRounds } from "./duration.js";
import { postFormulaDurationMessage } from "./duration-chat.js";
import { requestGMWorker } from "./transport.js";
import { highestClassOrSpellDc, statisticDc as statDc } from "./dc.js";

/*
 * PF2e Zone Automation - Player Builder / Runtime
 * Target: Foundry VTT v14 + Pathfinder Second Edition 8.5.1
 * Builds zone configurations and Foundry v14 Regions whose Execute Script
 * behaviors call this module. Player operations use the module socket to
 * request validated actions from the active GM.
 *
 * Targeted and source-checked against PF2e 8.5.1 / Foundry VTT V14.
 */

/** Keeps builder startup tied to the active PF2e scene and selected source token. */
export async function openZoneBuilder() {
  "use strict";

  const BUILDER_VERSION = "0.5.18";
  const RUNTIME_VERSION = "0.5.15";
  const SCHEMA_VERSION = 11;
  const ZONE_COLOR_LIGHTEN = 0.1;
  const LIBRARY_JOURNAL_NAME = "PF2e Zone Library";
  const DialogV2 = foundry.applications.api.DialogV2;
  const fu = foundry.utils;

  if (game.system.id !== "pf2e") {
    ui.notifications.error("PF2e Zone Builder requires the Pathfinder Second Edition system.");
    return;
  }

  if (!canvas?.ready) {
    ui.notifications.error("PF2e Zone Builder requires an active Scene.");
    return;
  }

  /** Prevents ambiguous zones by requiring exactly one valid source before editing begins. */
  function selectedSourceToken({ notify = true } = {}) {
    const selected = canvas.tokens.controlled;
    if (selected.length !== 1) {
      if (notify) {
        ui.notifications.warn(
          selected.length === 0
            ? "Select exactly one source token before using PF2e Zone Builder."
            : "PF2e Zone Builder requires exactly one selected source token."
        );
      }
      return null;
    }
    if (!selected[0].actor) {
      if (notify) ui.notifications.warn("The selected token does not have an Actor.");
      return null;
    }
    return selected[0];
  }

  let sourceToken = selectedSourceToken();
  if (!sourceToken) return;
  let sourceActor = sourceToken.actor;

  /** Keeps actor and user text from changing the builder HTML. */
  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  /** Makes stored slugs understandable without giving display text authority over saved data. */
  const titleCase = (slug) => String(slug ?? "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());

  /** Uses PF2e translations when available while retaining a readable fallback for custom content. */
  const localize = (key, fallback) => {
    if (typeof key !== "string") return fallback;
    const localized = game.i18n.localize(key);
    return localized && localized !== key ? localized : fallback;
  };

  /** Gives unsaved blocks stable identities so UI edits can target the intended block. */
  const newId = () => fu.randomID?.(8) ?? crypto.randomUUID().slice(0, 8);

  /** Prevents preview and form changes from mutating a saved configuration by reference. */
  const clone = (obj) => {
    if (globalThis.structuredClone) return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  };

  /** Keeps the Region border visible against its own fill color. */
  function lightenZoneColor(value, amount = ZONE_COLOR_LIGHTEN) {
    const raw = String(value ?? "#999999").trim();
    const short = raw.match(/^#?([0-9a-f]{3})$/i);
    const full = raw.match(/^#?([0-9a-f]{6})$/i);
    const hex = full?.[1] ?? (short ? short[1].split("").map((c) => `${c}${c}`).join("") : null);
    if (!hex) return raw || "#999999";

    const t = Math.clamp(Number(amount) || 0, 0, 1);
    const channels = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * t));
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }

  /** Turns hidden player-to-GM prerequisites into an actionable builder status. */
  function workerSetupProblem() {
    if (game.user.isGM) return null;
    if (!game.users.activeGM) {
      return "An active GM must be logged into the world for player PF2e Zone operations.";
    }
    if (!game.socket?.connected) {
      return "The PF2e Zone module socket is not connected. Refresh Foundry and try again.";
    }
    return null;
  }

  /** Explains whether this user can create a zone before they invest time configuring one. */
  function currentOperationStatus() {
    if (!selectionStillMatchesSource()) {
      return {
        text: "Source token changed",
        detail: "Click Use Current Selection before previewing or creating a zone.",
        icon: "fa-triangle-exclamation",
        ready: false
      };
    }

    if (game.user.isGM) {
      return {
        text: "GM connected",
        detail: "This GM can create zones directly.",
        icon: "fa-user-shield",
        ready: true
      };
    }

    const problem = workerSetupProblem();
    if (!problem) {
      return {
        text: "Player creation available",
        detail: "An active GM is available to create the requested zone.",
        icon: "fa-user-check",
        ready: true
      };
    }

    return {
      text: "Player creation unavailable",
      detail: problem,
      icon: "fa-triangle-exclamation",
      ready: false
    };
  }

  /** Keeps player creation requests on the same privileged path as direct GM actions. */
  async function callGMWorker(action, data = {}) {
    const problem = workerSetupProblem();
    if (problem) throw new Error(problem);

    const request = {
      ...clone(data),
      protocol: 1,
      builderVersion: BUILDER_VERSION,
      action,
      requesterUserId: game.user.id
    };

    const response = await requestGMWorker(request);
    if (!response?.ok) {
      throw new Error(response?.error || `PF2e Zone GM Worker failed '${action}'.`);
    }
    return response;
  }

  /** Avoids reporting success before Foundry has made the newly created Region available. */
  async function waitForRegion(sceneId, regionId, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const region = game.scenes.get(sceneId)?.regions.get(regionId) ?? null;
      if (region) return region;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return game.scenes.get(sceneId)?.regions.get(regionId) ?? null;
  }

  /** Removes the dialog from the canvas while placing an area so it cannot intercept the click. */
  function hideBuilderForAreaPlacement() {
    const element = dialog?.element ?? dialog?.window?.element ?? null;
    if (!element?.style) return () => {};

    const prior = {
      display: element.style.display,
      visibility: element.style.visibility,
      pointerEvents: element.style.pointerEvents
    };
    let restored = false;
    element.style.display = "none";

    return () => {
      if (restored) return;
      restored = true;
      if (!element?.style || !element.isConnected) return;
      element.style.display = prior.display;
      element.style.visibility = prior.visibility;
      element.style.pointerEvents = prior.pointerEvents;
    };
  }

  /** Makes fixed-area placement explicit and safely restores canvas input after completion or cancellation. */
  async function pickAreaCenter(name, radius) {
    if (!canvas?.ready || !canvas.scene) throw new Error("An active Scene is required to place an area.");
    const canvasElement = canvas.app?.canvas ?? canvas.app?.view;
    if (!canvasElement) throw new Error("Foundry canvas element is unavailable.");

    ui.notifications.info(`Click the center of the ${radius}-foot ${name} area. Press Escape to cancel.`);
    const priorCursor = canvasElement.style.cursor;
    canvasElement.style.cursor = "crosshair";

    return await new Promise((resolve) => {
      let done = false;
      /** Restores canvas input after an area-placement interaction ends. */
      const cleanup = () => {
        canvasElement.removeEventListener("pointerdown", onPointer, true);
        window.removeEventListener("keydown", onKey, true);
        canvasElement.style.cursor = priorCursor;
      };
      /** Ensures area placement resolves once even when multiple input events occur. */
      const finish = (value) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      };
      /** Consumes the placement click so creating an area does not also move or select a token. */
      const onPointer = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
        finish({ x: Number(point.x), y: Number(point.y) });
      };
      /** Lets users cancel placement without needing to close and reopen the builder. */
      const onKey = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        finish(null);
      };
      canvasElement.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("keydown", onKey, true);
    });
  }

  /** Prevents players from ending zones that their source ownership does not authorize them to dismiss. */
  async function canCurrentUserDismiss(payload) {
    if (game.user.isGM) return true;
    const actor = payload?.state?.sourceActorUuid ? await fromUuid(payload.state.sourceActorUuid) : null;
    return Boolean(actor?.testUserPermission?.(game.user, "OWNER"));
  }


  /**
   * Self-contained Region runtime entrypoint. The function is serialized into
   * every created Region's Execute Script behavior. It therefore must not rely
   * on lexical variables from the builder module.
   */
  const COMMON_TRAITS = [
    "aura",
    "auditory",
    "death",
    "emotion",
    "fear",
    "holy",
    "incapacitation",
    "mental",
    "olfactory",
    "poison",
    "unholy",
    "vitality",
    "visual",
    "void"
  ];

  // These are common triggers for reactive auras and zones. The user can add
  // any other PF2e trait slug in the field below this checklist.
  const WATCHED_TRAITS = [
    "auditory",
    "concentrate",
    "divine",
    "emotion",
    "fear",
    "healing",
    "holy",
    "manipulate",
    "mental",
    "move",
    "spirit",
    "unholy",
    "vitality",
    "void"
  ];

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

  const FALLBACK_CONDITIONS = [
    "blinded", "clumsy", "concealed", "confused", "controlled", "dazzled",
    "deafened", "doomed", "drained", "dying", "encumbered", "enfeebled",
    "fascinated", "fatigued", "fleeing", "frightened", "grabbed", "hidden",
    "immobilized", "invisible", "off-guard", "paralyzed", "petrified", "prone",
    "quickened", "restrained", "sickened", "slowed", "stunned", "stupefied",
    "unconscious", "undetected", "wounded"
  ];

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

  /** Uses the installed PF2e condition catalog so the builder follows the active system version. */
  function getConditionChoices() {
    const config = CONFIG.PF2E?.conditionTypes ?? {};
    const keys = new Set([...FALLBACK_CONDITIONS, ...Object.keys(config)]);
    return [...keys]
      .filter((k) => !["persistent-damage"].includes(k))
      .map((slug) => {
        const raw = config[slug];
        let label = titleCase(slug);
        if (typeof raw === "string") label = localize(raw, label);
        else if (raw && typeof raw === "object") {
          const candidate = raw.label ?? raw.name;
          if (typeof candidate === "string") label = localize(candidate, titleCase(slug));
        }
        return { slug, label };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Prevents the UI from asking for meaningless numeric values on binary conditions. */
  function isValuedCondition(slug) {
    return VALUED_CONDITIONS.has(String(slug ?? ""));
  }

  /** Uses PF2e damage types so zone automation does not maintain a stale duplicate list. */
  function getDamageChoices() {
    const config = CONFIG.PF2E?.damageTypes ?? {};
    const values = Object.entries(config).map(([slug, labelKey]) => ({
      slug,
      label: typeof labelKey === "string" ? localize(labelKey, titleCase(slug)) : titleCase(slug)
    }));
    if (!values.some((x) => x.slug === "untyped")) values.push({ slug: "untyped", label: "Untyped" });
    return values.sort((a, b) => a.label.localeCompare(b.label));
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
      repeat: "every",
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
      radius: 15,
      visibility: "all",
      targeting: {
        affects: "enemies",
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
  function normalizeConfig(input) {
    const base = defaultConfig();
    const cfg = input && typeof input === "object" ? input : {};

    const traits = Array.isArray(cfg.traits)
      ? normalizeTraitSlugs(cfg.traits)
      : base.traits;

    const importedVisibility = cfg.visibility === "gm" ? "creator" : cfg.visibility;
    const result = {
      schemaVersion: SCHEMA_VERSION,
      name: String(cfg.name ?? base.name).trim(),
      mode: ["area", "emanation"].includes(cfg.mode) ? cfg.mode : base.mode,
      radius: Math.max(1, Number(cfg.radius) || base.radius),
      visibility: ["all", "creator"].includes(importedVisibility) ? importedVisibility : base.visibility,
      targeting: {
        affects: ["enemies", "allies", "both"].includes(cfg.targeting?.affects)
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
          : normalizeDurationRounds(cfg.duration?.rounds, 1)
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
          : "every",
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

  let state = defaultConfig();
  let loadedPreset = null; // { id, createdBy, modifiedBy, revision, ... } for the currently loaded/saved library entry

  /** Protects shared presets from being overwritten by users who did not create them. */
  function canOverwritePreset(record = loadedPreset) {
    if (!record) return true;
    return game.user.isGM || record.createdBy?.userId === game.user.id;
  }

  /** Shows ownership alongside a preset name so similarly named shared records remain distinguishable. */
  function presetLabel(record) {
    return `${record?.name ?? "Unnamed Zone"} (${record?.createdBy?.name ?? "Unknown"})`;
  }

  /** Detects a changed token selection before it can create a zone from the wrong actor. */
  function selectionStillMatchesSource() {
    const current = selectedSourceToken({ notify: false });
    return Boolean(current && current.document.uuid === sourceToken.document.uuid);
  }

  /** Keeps the save UI aligned with the source actor that is currently selected. */
  function dcOptionsHtml(selectedDc) {
    const choices = getDcChoices(sourceActor);
    const selectedMode = selectedDc?.mode ?? "custom";
    const selectedStat = selectedDc?.statistic ?? "";

    let html = `<option value="custom" ${selectedMode === "custom" ? "selected" : ""}>Custom DC</option>`;
    for (const option of choices) {
      const value = `stat:${option.statistic}`;
      const selected = selectedMode === "actorStatistic" && selectedStat === option.statistic;
      html += `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(option.label)} — DC ${option.dc}</option>`;
    }

    if (selectedMode === "actorStatistic" && !choices.some((x) => x.statistic === selectedStat)) {
      html += `<option value="stat:${esc(selectedStat)}" selected>Unavailable on ${esc(sourceActor.name)}: ${esc(selectedStat)}</option>`;
    }
    return html;
  }

  /** Keeps condition dropdowns consistent with the current PF2e catalog. */
  function conditionOptions(selected) {
    return getConditionChoices().map(({ slug, label }) =>
      `<option value="${esc(slug)}" ${slug === selected ? "selected" : ""}>${esc(label)}</option>`
    ).join("");
  }

  /** Keeps damage-type dropdowns consistent with the current PF2e catalog. */
  function damageOptions(selected) {
    return getDamageChoices().map(({ slug, label }) =>
      `<option value="${esc(slug)}" ${slug === selected ? "selected" : ""}>${esc(label)}</option>`
    ).join("");
  }

  /** Keeps condition controls and their removal choices together so outcomes remain legible. */
  function renderConditionRow(condition, blockId, outcomeKey, index) {
    const valued = isValuedCondition(condition.slug);
    const value = valued ? (condition.value ?? 1) : "";
    const linkedCondition = String(condition.condition ?? "sickened");
    return `
      <div class="zb-subrow zb-condition-row" data-condition-index="${index}">
        <select data-field="condition-slug">${conditionOptions(condition.slug)}</select>
        <label class="zb-inline">Value
          <input data-field="condition-value" type="number" min="1" step="1" value="${value}" placeholder="${valued ? "1" : "—"}" ${valued ? "" : "disabled"}>
        </label>
        <select data-field="condition-removal" title="When should the condition be removed?">
          <option value="normal" ${condition.removal === "normal" ? "selected" : ""}>Normal PF2e handling</option>
          <option value="on-exit" ${condition.removal === "on-exit" ? "selected" : ""}>Remove on exit</option>
          <option value="zone-end" ${condition.removal === "zone-end" ? "selected" : ""}>Remove when zone ends</option>
          <option value="condition-end" ${condition.removal === "condition-end" ? "selected" : ""}>Remove when another condition ends</option>
        </select>
        <label class="zb-inline zb-condition-link">When
          <select data-field="condition-link">${conditionOptions(linkedCondition)}</select>
          ends
        </label>
        <button type="button" class="icon zb-remove-condition" data-block="${blockId}" data-outcome="${outcomeKey}" data-index="${index}" title="Remove condition"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }

  /** Hides unsupported condition inputs so stale controls cannot mislead the user. */
  function refreshConditionRow(row) {
    if (!row) return;
    const removal = row.querySelector('[data-field="condition-removal"]')?.value ?? "normal";
    const link = row.querySelector(".zb-condition-link");
    if (link) link.style.display = removal === "condition-end" ? "flex" : "none";
  }

  /** Keeps an effect UUID and its cleanup rule together because they describe one application. */
  function renderEffectRow(effect, blockId, outcomeKey, index) {
    return `
      <div class="zb-subrow zb-effect-row" data-effect-index="${index}">
        <input data-field="effect-uuid" type="text" value="${esc(effect.uuid)}" placeholder="Item UUID, e.g. Compendium.pf2e...Item...">
        <select data-field="effect-removal" title="When should the Effect Item be removed?">
          <option value="item-duration" ${effect.removal === "item-duration" ? "selected" : ""}>Use Effect Item duration</option>
          <option value="on-exit" ${effect.removal === "on-exit" ? "selected" : ""}>Remove on exit</option>
          <option value="zone-end" ${effect.removal === "zone-end" ? "selected" : ""}>Remove when zone ends</option>
        </select>
        <button type="button" class="icon zb-remove-effect" data-block="${blockId}" data-outcome="${outcomeKey}" data-index="${index}" title="Remove effect"><i class="fa-solid fa-trash"></i></button>
      </div>`;
  }

  /** Groups each possible result so users can see exactly when a payload will apply. */
  function renderOutcome(block, key, label) {
    const outcome = block.outcomes[key] ?? emptyOutcome(key);
    const isNoSave = key === "noSave";
    const basicLocked = block.save.enabled && block.save.basic && !isNoSave;
    return `
      <section class="zb-outcome" data-outcome="${key}">
        <div class="zb-outcome-head">
          <strong>${esc(label)}</strong>
          <label class="zb-inline zb-damage-multiplier">Damage / Healing ×
            <select data-field="damage-multiplier" ${basicLocked ? "disabled" : ""}>
              ${[
                [0, "0 (none)"], [0.5, "½"], [1, "1×"], [2, "2×"]
              ].map(([value, text]) => `<option value="${value}" ${Number(outcome.damageMultiplier) === value ? "selected" : ""}>${text}</option>`).join("")}
            </select>
          </label>
        </div>

        <div class="zb-outcome-group">
          <div class="zb-subhead">Conditions</div>
          <div class="zb-condition-list">
            ${outcome.conditions.map((c, i) => renderConditionRow(c, block.id, key, i)).join("") || `<div class="zb-empty">No conditions</div>`}
          </div>
          <button type="button" class="zb-small zb-add-condition" data-block="${block.id}" data-outcome="${key}"><i class="fa-solid fa-plus"></i> Condition</button>
        </div>

        <div class="zb-outcome-group">
          <div class="zb-subhead">PF2e Effect Items</div>
          <div class="zb-effect-list">
            ${outcome.effects.map((e, i) => renderEffectRow(e, block.id, key, i)).join("") || `<div class="zb-empty">No Effect Items</div>`}
          </div>
          <button type="button" class="zb-small zb-add-effect" data-block="${block.id}" data-outcome="${key}"><i class="fa-solid fa-plus"></i> Effect Item</button>
        </div>
      </section>`;
  }

  /** Makes collapsed blocks reviewable without forcing users to reopen every configuration detail. */
  function blockSummary(block) {
    const triggers = triggerLabels(block);
    const outcomeKeys = block.save.enabled
      ? ["criticalSuccess", "success", "failure", "criticalFailure"]
      : ["noSave"];
    const outcomes = outcomeKeys.map((key) => block.outcomes?.[key] ?? emptyOutcome(key));
    const conditions = outcomes.reduce((count, outcome) => count + (outcome.conditions?.length ?? 0), 0);
    const effects = outcomes.reduce((count, outcome) => count + (outcome.effects?.length ?? 0), 0);
    const results = [];

    if (block.save.enabled) {
      results.push(`${block.save.type === "choice" ? "Target-choice" : titleCase(block.save.type)} save`);
    }
    if (block.damage.enabled) results.push(`Damage ${block.damage.formula || "formula needed"}`);
    if (block.healing?.enabled) results.push(`Healing ${block.healing.formula || "formula needed"}`);
    if (conditions) results.push(`${conditions} condition${conditions === 1 ? "" : "s"}`);
    if (effects) results.push(`${effects} Effect Item${effects === 1 ? "" : "s"}`);
    if (block.chatAlert?.enabled) results.push("Chat alert");

    return `${triggers.length ? triggers.join(", ") : "Choose when this happens"} · ${results.length ? results.join(", ") : "Choose what happens"}`;
  }

  /** Rebuilds a block from state so validation, import, and dynamic rows stay synchronized. */
  function renderBlock(block, index) {
    const watchedTraits = watchedTraitSlugs(block.traitUse);
    const watchedTraitSet = new Set(watchedTraits);
    const customWatchedTraits = watchedTraits.filter((trait) => !WATCHED_TRAITS.includes(trait)).join(", ");
    /** Uses one checkbox shape so every trigger communicates the same opt-in behavior. */
    const trigger = (key, label) => `
      <label class="zb-check"><input type="checkbox" data-trigger="${key}" ${block.triggers[key] ? "checked" : ""}> ${esc(label)}</label>`;

    return `
      <details class="zb-block" data-block-id="${esc(block.id)}" ${index === 0 ? "open" : ""}>
        <summary>
          <span class="zb-block-title">${esc(block.name || `Effect Block ${index + 1}`)}</span>
          <span class="zb-block-summary" data-block-summary>${esc(blockSummary(block))}</span>
        </summary>
        <div class="zb-block-body">
          <div class="zb-grid two">
            <label>Block name
              <input data-field="block-name" type="text" value="${esc(block.name)}">
            </label>
            <label>How often a creature can be affected
              <select data-field="repeat">
                <option value="every" ${block.repeat === "every" ? "selected" : ""}>Every time this happens</option>
                <option value="once-per-round" ${block.repeat === "once-per-round" ? "selected" : ""}>Once each round</option>
                <option value="once-per-zone" ${block.repeat === "once-per-zone" ? "selected" : ""}>Once for this zone</option>
              </select>
            </label>
          </div>

          <fieldset>
            <legend>Triggers</legend>
            <div class="zb-check-grid">
              ${trigger("activation", "When the zone is created")}
              ${trigger("enter", "When a creature enters after creation")}
              ${trigger("turnStart", "At the start of a creature's turn")}
              ${trigger("sourceTurnStart", "At the start of the source's turn")}
              ${trigger("turnEnd", "At the end of a creature's turn")}
              ${trigger("continuous", "While a creature is inside")}
              ${trigger("spellCast", "When a creature casts a spell")}
              ${trigger("traitUse", "When a creature uses a selected trait")}
            </div>
            <p class="notes">Choose one or more events. “When the zone is created” affects eligible creatures already inside. “When a creature enters” only affects a creature that crosses into the zone later. The source-turn event follows the source combatant even when it is outside a fixed area, and does not run on the turn the zone is created.</p>
          </fieldset>

          <fieldset class="zb-trait-use-options">
            <legend>Trait Use Trigger</legend>
            <div class="zb-traits">
              ${WATCHED_TRAITS.map((trait) => `<label class="zb-check"><input type="checkbox" data-trait-use-trait="${trait}" ${watchedTraitSet.has(trait) ? "checked" : ""}> ${titleCase(trait)}</label>`).join("")}
            </div>
            <label>Other trait slugs (comma-separated)
              <input data-field="trait-use-custom-traits" type="text" value="${esc(customWatchedTraits)}" placeholder="e.g. curse, fire">
            </label>
            <p class="notes">Choose one or more traits. The block runs once when a creature inside the zone uses an item, spell, or ability with any selected trait. For spells, PF2e must mark the spell as actually cast; generic abilities are detected from their PF2e chat card.</p>
          </fieldset>

          <fieldset>
            <legend>Chat Alert</legend>
            <label class="zb-check"><input type="checkbox" data-field="chat-alert-enabled" ${block.chatAlert?.enabled ? "checked" : ""}> Post a chat alert when this Effect Block triggers</label>
            <div class="zb-chat-alert-options">
              <label>Chat alert text
                <input data-field="chat-alert-text" type="text" value="${esc(block.chatAlert?.text ?? "")}">
              </label>
              <p class="notes">Chat alerts post once per trigger event. Available placeholders: <b>{zone}</b>, <b>{block}</b>, <b>{creature}</b>, <b>{count}</b>, <b>{source}</b>, and <b>{trigger}</b>. Trait-use and spell-cast triggers provide <b>{item}</b>; trait-use triggers also provide <b>{trait}</b>. For multi-target events, <b>{creature}</b> becomes “affected creatures” and <b>{count}</b> gives the number of targets.</p>
            </div>
          </fieldset>

          <fieldset>
            <legend>Saving Throw</legend>
            <label class="zb-check"><input type="checkbox" data-field="save-enabled" ${block.save.enabled ? "checked" : ""}> Require a saving throw</label>
            <div class="zb-save-options">
              <div class="zb-grid three">
                <label>Save
                  <select data-field="save-type">
                    <option value="fortitude" ${block.save.type === "fortitude" ? "selected" : ""}>Fortitude</option>
                    <option value="reflex" ${block.save.type === "reflex" ? "selected" : ""}>Reflex</option>
                    <option value="will" ${block.save.type === "will" ? "selected" : ""}>Will</option>
                    <option value="choice" ${block.save.type === "choice" ? "selected" : ""}>Target chooses...</option>
                  </select>
                </label>
                <label>DC source
                  <select data-field="dc-source">${dcOptionsHtml(block.save.dc)}</select>
                </label>
                <label class="zb-custom-dc">Custom DC
                  <input data-field="custom-dc" type="number" min="0" step="1" value="${block.save.dc.mode === "custom" ? block.save.dc.value : ""}">
                </label>
              </div>
              <div class="zb-save-choice-options">
                <div class="zb-subhead">Allowed saves</div>
                <div class="zb-check-grid">
                  ${[
                    ["fortitude", "Fortitude"],
                    ["reflex", "Reflex"],
                    ["will", "Will"]
                  ].map(([slug, label]) => `<label class="zb-check"><input type="checkbox" data-save-choice="${slug}" ${(block.save.choices ?? []).includes(slug) ? "checked" : ""}> ${label}</label>`).join("")}
                </div>
                <div class="notes">The affected creature chooses one of these saves when the request is posted.</div>
              </div>
              <label class="zb-check"><input type="checkbox" data-field="basic-save" ${block.save.basic ? "checked" : ""}> Basic save (standard 0 / half / full / double amount)</label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Damage</legend>
            <label class="zb-check"><input type="checkbox" data-field="damage-enabled" ${block.damage.enabled ? "checked" : ""}> This block deals damage</label>
            <div class="zb-damage-options">
              <div class="zb-grid three">
                <label>Damage formula
                  <input data-field="damage-formula" type="text" value="${esc(block.damage.formula)}" placeholder="e.g. 6d8">
                </label>
                <label>Damage type source
                  <select data-field="damage-type-mode">
                    <option value="fixed" ${block.damage.typeMode !== "activation-choice" ? "selected" : ""}>Fixed damage type</option>
                    <option value="activation-choice" ${block.damage.typeMode === "activation-choice" ? "selected" : ""}>Shared activation choice</option>
                  </select>
                </label>
                <label class="zb-fixed-damage-type">Damage type
                  <select data-field="damage-type">${damageOptions(block.damage.type)}</select>
                </label>
              </div>
              <div class="zb-shared-damage-note notes">Uses the zone's shared damage type chosen when the zone activates.</div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Healing</legend>
            <label class="zb-check"><input type="checkbox" data-field="healing-enabled" ${block.healing?.enabled ? "checked" : ""}> This block rolls healing</label>
            <div class="zb-healing-options">
              <label>Healing formula
                <input data-field="healing-formula" type="text" value="${esc(block.healing?.formula ?? "")}" placeholder="e.g. 1d8">
              </label>
              <p class="notes">Creates a normal PF2e healing roll with the standard Apply Healing button. If damage and healing are both enabled, both cards are posted and the GM can apply the appropriate one.</p>
            </div>
          </fieldset>

          <fieldset>
            <legend>Degree-of-success payloads</legend>
            <p class="notes">Conditions and Effect Items can be added to each result. Damage and Healing use the formulas above and the multiplier shown for that result.</p>
            <div class="zb-save-outcomes">
              ${OUTCOMES.filter(([key]) => key !== "noSave").map(([key, label]) => renderOutcome(block, key, label)).join("")}
            </div>
            <div class="zb-nosave-outcomes">
              ${renderOutcome(block, "noSave", "No Save")}
            </div>
          </fieldset>

          <fieldset>
            <legend>Temporary Immunity</legend>
            <div class="zb-grid two">
              <label>Immunity duration
                <select data-field="immunity-duration">
                  <option value="none" ${block.immunity.duration === "none" ? "selected" : ""}>None</option>
                  <option value="1-round" ${block.immunity.duration === "1-round" ? "selected" : ""}>1 round</option>
                  <option value="1-minute" ${block.immunity.duration === "1-minute" ? "selected" : ""}>1 minute</option>
                  <option value="10-minutes" ${block.immunity.duration === "10-minutes" ? "selected" : ""}>10 minutes</option>
                </select>
              </label>
              <label class="zb-recovery-condition">Recovery condition
                <select data-field="recovery-condition">${conditionOptions(block.immunity.recoveryCondition)}</select>
              </label>
            </div>
            <div class="zb-immunity-starts">
              <div class="zb-subhead">Immunity begins when</div>
              <div class="zb-immunity-options">
                ${[
                  ["after-save", "After any save"],
                  ["success-or-better", "On success or better"],
                  ["failure-or-worse", "On failure or worse"],
                  ["affected", "When actually affected"],
                  ["condition-recovery", "After recovering from condition"]
                ].map(([value, label]) => `<label class="zb-check"><input type="checkbox" data-immunity-start="${value}" ${block.immunity.starts.includes(value) ? "checked" : ""}> ${label}</label>`).join("")}
              </div>
              <div class="notes">Choose at least one start condition when immunity duration is not None.</div>
            </div>
          </fieldset>

          <div class="zb-block-actions">
              <button type="button" class="zb-duplicate-block" data-block="${esc(block.id)}"><i class="fa-solid fa-copy"></i> Duplicate Block</button>
              <button type="button" class="zb-add-block"><i class="fa-solid fa-plus"></i> Add Effect Block</button>
            <button type="button" class="zb-remove-block danger" data-block="${esc(block.id)}" ${state.effects.length <= 1 ? "disabled" : ""}><i class="fa-solid fa-trash"></i> Remove Block</button>
          </div>
        </div>
      </details>`;
  }

  /** Rebuilds the dialog from canonical state instead of preserving potentially stale DOM values. */
  function renderRoot() {
    const commonSet = new Set(COMMON_TRAITS);
    const customTraits = state.traits.filter((t) => !commonSet.has(t)).join(", ");
    const selectionWarning = selectionStillMatchesSource()
      ? ""
      : `<div class="zb-warning"><i class="fa-solid fa-triangle-exclamation"></i> The controlled token has changed since this builder was opened. Click <b>Use Current Selection</b> before previewing or creating a zone.</div>`;

    return `

      <div class="pf2e-zone-builder">
        <div class="zb-source">
          <img src="${esc(sourceToken.document.texture?.src ?? sourceActor.img)}" alt="">
          <div class="zb-source-main">
            <div class="zb-source-name"><b>Source:</b> ${esc(sourceToken.name === sourceActor.name ? sourceActor.name : `${sourceToken.name} (${sourceActor.name})`)}</div>
          </div>
          <button type="button" class="zb-use-selection"><i class="fa-solid fa-crosshairs"></i> Use Current Selection</button>
        </div>
        ${selectionWarning}

        <div class="zb-toolbar">
          <button type="button" class="zb-load-saved"><i class="fa-solid fa-folder-open"></i> Load Saved Zone</button>
          <button type="button" class="zb-save"${loadedPreset && !canOverwritePreset() ? " disabled" : ""}><i class="fa-solid fa-floppy-disk"></i> Save</button>
          <button type="button" class="zb-save-as"><i class="fa-solid fa-copy"></i> Save As</button>
          <button type="button" class="zb-import"><i class="fa-solid fa-file-import"></i> Import JSON</button>
          <button type="button" class="zb-export"><i class="fa-solid fa-file-export"></i> Export JSON</button>
          <button type="button" class="zb-manage"><i class="fa-solid fa-map-location-dot"></i> Manage Existing Zones</button>
        </div>
        ${loadedPreset ? `<div class="zb-summary-note">Loaded saved zone: <b>${esc(presetLabel(loadedPreset))}</b>${canOverwritePreset() ? "" : " · read-only; use Save As to create your own copy"}</div>` : ""}

        <div class="zb-scroll">
          <section class="zb-section">
            <h3>Zone</h3>
            <div class="zb-grid two">
              <label>Name
                <input data-zone="name" type="text" value="${esc(state.name)}" required aria-required="true">
              </label>
              <label>Zone type
                <select data-zone="mode">
                  <option value="emanation" ${state.mode === "emanation" ? "selected" : ""}>Emanation — follows source token</option>
                  <option value="area" ${state.mode === "area" ? "selected" : ""}>Area — fixed circular burst</option>
                </select>
              </label>
              <label>Radius (feet)
                <input data-zone="radius" type="number" min="1" step="5" value="${state.radius}">
              </label>
              <label>Visibility
                <select data-zone="visibility">
                  <option value="all" ${state.visibility === "all" ? "selected" : ""}>Visible to everyone</option>
                  <option value="creator" ${state.visibility === "creator" ? "selected" : ""}>Creator only</option>
                </select>
              </label>
              <label>Affects
                <select data-zone="affects">
                  <option value="enemies" ${state.targeting.affects === "enemies" ? "selected" : ""}>Enemies</option>
                  <option value="allies" ${state.targeting.affects === "allies" ? "selected" : ""}>Allies</option>
                  <option value="both" ${state.targeting.affects === "both" ? "selected" : ""}>Both</option>
                </select>
              </label>
            </div>
            <label class="zb-check" style="margin-top:8px"><input data-zone="include-self" type="checkbox" ${state.targeting.includeSelf ? "checked" : ""}> Include source actor</label>
          </section>

          <section class="zb-section">
            <h3>Traits</h3>
            <div class="zb-traits">
              ${COMMON_TRAITS.map((trait) => `<label class="zb-check"><input type="checkbox" data-trait="${trait}" ${state.traits.includes(trait) ? "checked" : ""}> ${titleCase(trait)}</label>`).join("")}
            </div>
            <label>Other trait slugs (comma-separated)
              <input data-zone="custom-traits" type="text" value="${esc(customTraits)}" placeholder="e.g. disease, magical">
            </label>
          </section>

          <section class="zb-section">
            <h3>Duration</h3>
            <div class="zb-grid two">
              <label>Duration
                <select data-zone="duration-type">
                  <option value="custom-rounds" ${state.duration.type === "custom-rounds" ? "selected" : ""}>X rounds</option>
                  <option value="1-minute" ${state.duration.type === "1-minute" ? "selected" : ""}>1 minute</option>
                  <option value="10-minutes" ${state.duration.type === "10-minutes" ? "selected" : ""}>10 minutes</option>
                  <option value="unlimited" ${state.duration.type === "unlimited" ? "selected" : ""}>Unlimited</option>
                </select>
              </label>
              <label class="zb-duration-rounds">Rounds or dice formula
                <input data-zone="duration-rounds" type="text" inputmode="text" spellcheck="false" value="${esc(state.duration.rounds)}" placeholder="e.g. 6 or 2d4">
              </label>
            </div>
          </section>

          <section class="zb-section">
            <h3>Activation Choices</h3>
            <label class="zb-check"><input data-zone="damage-choice-enabled" type="checkbox" ${state.activationChoices?.damageType?.enabled ? "checked" : ""}> Choose one shared damage type (ex. Shadow Raid) when the zone activates</label>
            <div class="zb-activation-damage-choice" style="margin-top:8px">
              <p class="notes">Any damage block set to <b>Shared activation choice</b> will use the same selected type.</p>
              <div class="zb-check-grid">
                ${getDamageChoices().map(({ slug, label }) => `<label class="zb-check"><input type="checkbox" data-damage-choice-type="${esc(slug)}" ${(state.activationChoices?.damageType?.options ?? []).includes(slug) ? "checked" : ""}> ${esc(label)}</label>`).join("")}
              </div>
            </div>
          </section>

          <section class="zb-section">
            <h3>Effect Blocks</h3>
            <p class="notes">Each block says when something happens and what it does. Add a second block when the same zone needs a different trigger or result.</p>
            <div class="zb-block-list">
              ${state.effects.map((block, i) => renderBlock(block, i)).join("")}
            </div>
          </section>

        </div>

        <div class="zb-bottom">
          <div class="zb-bottom-info">
            <div class="zb-readiness" data-validation-status-container role="status" aria-live="polite">
              <i class="fa-solid fa-circle-check" data-validation-status-icon></i>
              <span data-validation-status>Checking configuration…</span>
            </div>
            <div class="zb-operation-status" data-operation-status-container role="status" aria-live="polite">
              <i class="fa-solid fa-circle-notch fa-spin" data-operation-status-icon></i>
              <span data-operation-status>Checking connection…</span>
            </div>
          </div>
          <div class="right">
            <button type="button" class="zb-close"><i class="fa-solid fa-xmark"></i> Close</button>
            <button type="button" class="zb-validate"><i class="fa-solid fa-list-check"></i> Validate</button>
            <button type="button" class="zb-preview"><i class="fa-solid fa-message"></i> Post Preview to Chat</button>
            <button type="button" class="zb-create"><i class="fa-solid fa-circle-plus"></i> Create Zone</button>
          </div>
        </div>
      </div>`;
  }

  /** Keeps selector lookup in one place so form reads fail consistently if the UI changes. */
  function field(root, selector) {
    return root.querySelector(selector);
  }

  /** Converts outcome controls into portable data before validation or saving. */
  function readOutcome(outcomeEl, key) {
    const conditions = [...outcomeEl.querySelectorAll(".zb-condition-row")].map((row) => {
      const slug = row.querySelector('[data-field="condition-slug"]').value;
      const rawValue = row.querySelector('[data-field="condition-value"]').value.trim();
      const removal = row.querySelector('[data-field="condition-removal"]').value;
      return {
        slug,
        value: isValuedCondition(slug)
          ? Math.max(1, Math.floor(Number(rawValue) || 1))
          : null,
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
  function readConfig(root) {
    const commonTraits = [...root.querySelectorAll("[data-trait]:checked")].map((x) => x.dataset.trait);
    const customTraits = field(root, '[data-zone="custom-traits"]').value
      .split(",")
      .map((x) => x.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter(Boolean);

    const cfg = {
      schemaVersion: SCHEMA_VERSION,
      name: field(root, '[data-zone="name"]').value.trim(),
      mode: field(root, '[data-zone="mode"]').value,
      radius: Number(field(root, '[data-zone="radius"]').value),
      visibility: field(root, '[data-zone="visibility"]').value,
      targeting: {
        affects: field(root, '[data-zone="affects"]').value,
        includeSelf: field(root, '[data-zone="include-self"]').checked
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
          spellCast: blockEl.querySelector('[data-trigger="spellCast"]').checked
        },
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
          recoveryCondition: blockEl.querySelector('[data-field="recovery-condition"]').value
        }
      });
    }

    return normalizeConfig(cfg);
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
  function validateConfig(cfg, { requireCurrentSource = false } = {}) {
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

    if (requireCurrentSource && !selectionStillMatchesSource()) {
      error("The controlled token has changed. Click 'Use Current Selection' before continuing.", { scope: "source" });
    }
    if (!cfg.name) error("Zone name is required.", { scope: "zone", field: "name" });
    if (!(cfg.radius > 0)) error("Radius must be greater than 0.", { scope: "zone", field: "radius" });
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

      if (block.damage.enabled && !block.damage.formula) {
        error(`${prefix} damage is enabled but no formula was entered.`, blockTarget(index, "damage-formula"));
      }
      if (block.healing?.enabled && !block.healing.formula) {
        error(`${prefix} healing is enabled but no formula was entered.`, blockTarget(index, "healing-formula"));
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

  /** Finds the most useful UI element for each validation problem instead of showing only a global list. */
  function validationTarget(root, issue) {
    const target = issue?.target;
    if (!target) return null;
    if (target.scope === "source") return root.querySelector(".zb-source");
    if (target.scope === "blocks") return root.querySelector(".zb-block-list");
    if (target.scope === "activation-damage-choice") return root.querySelector(".zb-activation-damage-choice");
    if (target.scope === "zone") return root.querySelector(`[data-zone="${target.field}"]`);
    if (target.scope !== "block") return null;

    const block = [...root.querySelectorAll("[data-block-id]")][target.index];
    if (!block) return null;
    if (target.field === "triggers") return block.querySelector("fieldset");
    if (target.field === "trait-use-traits") return block.querySelector(".zb-trait-use-options");
    if (target.field === "save-choices") return block.querySelector(".zb-save-choice-options");
    if (target.field === "immunity-starts") return block.querySelector(".zb-immunity-starts");
    if (target.field === "condition-link") {
      const rows = [...block.querySelectorAll(`[data-outcome="${target.outcomeKey}"] .zb-condition-row`)];
      return rows[target.conditionIndex]?.querySelector('[data-field="condition-link"]') ?? null;
    }
    if (target.field === "effect-uuid") {
      const rows = [...block.querySelectorAll(`[data-outcome="${target.outcomeKey}"] .zb-effect-row`)];
      return rows[target.effectIndex]?.querySelector('[data-field="effect-uuid"]') ?? null;
    }
    return block.querySelector(`[data-field="${target.field}"]`);
  }

  /** Places inline feedback beside the control users need to change. */
  function validationErrorHost(target) {
    if (!target) return null;
    if (target.matches("fieldset, .zb-trait-use-options, .zb-chat-alert-options, .zb-save-choice-options, .zb-immunity-starts, .zb-activation-damage-choice, .zb-source, .zb-block-list, .zb-condition-row, .zb-effect-row")) return target;
    return target.closest("label") ?? target.closest(".zb-subrow") ?? target;
  }

  /** Removes stale warnings before rendering the current configuration state. */
  function clearInlineValidation(root) {
    for (const message of root.querySelectorAll(".zb-field-error")) message.remove();
    for (const element of root.querySelectorAll(".zb-invalid")) {
      element.classList.remove("zb-invalid");
      element.removeAttribute("aria-invalid");
    }
  }

  /** Makes blocking errors visible where they occur so users do not have to interpret a summary list. */
  function renderInlineValidation(root, validation) {
    clearInlineValidation(root);
    for (const issue of validation.issues ?? []) {
      const target = validationTarget(root, issue);
      const host = validationErrorHost(target);
      if (!target || !host) continue;

      target.classList.add("zb-invalid");
      target.setAttribute("aria-invalid", "true");
      host.classList.add("zb-invalid");
      const message = document.createElement("div");
      message.className = "zb-field-error";
      message.textContent = issue.message;
      host.append(message);
    }
  }

  /** Keeps readiness accurate as the user edits rather than waiting for a failed create attempt. */
  function refreshLiveValidation(root) {
    const cfg = readConfig(root);
    const validation = validateConfig(cfg, { requireCurrentSource: true });
    renderInlineValidation(root, validation);

    const status = root.querySelector("[data-validation-status]");
    const statusContainer = root.querySelector("[data-validation-status-container]");
    const icon = root.querySelector("[data-validation-status-icon]");
    const create = root.querySelector(".zb-create");
    const errorCount = validation.errors.length;
    const warningCount = validation.warnings.length;

    if (status && statusContainer && icon) {
      statusContainer.classList.toggle("is-ready", errorCount === 0);
      statusContainer.classList.toggle("has-errors", errorCount > 0);
      icon.className = `fa-solid ${errorCount ? "fa-triangle-exclamation" : "fa-circle-check"}`;
      status.textContent = errorCount
        ? `Fix ${errorCount} field${errorCount === 1 ? "" : "s"} to create`
        : `Ready to create${warningCount ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`;
    }
    if (create) create.disabled = errorCount > 0;
    refreshOperationStatus(root);
    return validation;
  }

  /** Hides controls that cannot affect the current configuration so the editor stays approachable. */
  function refreshVisibility(root) {
    const durationType = field(root, '[data-zone="duration-type"]').value;
    field(root, ".zb-duration-rounds").style.display = durationType === "custom-rounds" ? "flex" : "none";

    const activationDamageEnabled = field(root, '[data-zone="damage-choice-enabled"]').checked;
    field(root, ".zb-activation-damage-choice").style.display = activationDamageEnabled ? "block" : "none";

    for (const blockEl of root.querySelectorAll("[data-block-id]")) {
      const saveEnabled = blockEl.querySelector('[data-field="save-enabled"]').checked;
      const saveType = blockEl.querySelector('[data-field="save-type"]').value;
      const basic = blockEl.querySelector('[data-field="basic-save"]').checked;
      const dcSource = blockEl.querySelector('[data-field="dc-source"]').value;
      const damageEnabled = blockEl.querySelector('[data-field="damage-enabled"]').checked;
      const healingEnabled = blockEl.querySelector('[data-field="healing-enabled"]').checked;
      const damageTypeMode = blockEl.querySelector('[data-field="damage-type-mode"]').value;
      const immunityDuration = blockEl.querySelector('[data-field="immunity-duration"]').value;
      const recoveryChecked = Boolean(blockEl.querySelector('[data-immunity-start="condition-recovery"]:checked'));
      const traitUseEnabled = blockEl.querySelector('[data-trigger="traitUse"]').checked;
      const chatAlertEnabled = blockEl.querySelector('[data-field="chat-alert-enabled"]').checked;

      blockEl.querySelector(".zb-trait-use-options").style.display = traitUseEnabled ? "block" : "none";
      blockEl.querySelector(".zb-chat-alert-options").style.display = chatAlertEnabled ? "block" : "none";
      blockEl.querySelector(".zb-save-options").style.display = saveEnabled ? "block" : "none";
      blockEl.querySelector(".zb-save-choice-options").style.display = saveEnabled && saveType === "choice" ? "block" : "none";
      blockEl.querySelector(".zb-custom-dc").style.display = dcSource === "custom" ? "flex" : "none";
      blockEl.querySelector(".zb-damage-options").style.display = damageEnabled ? "block" : "none";
      blockEl.querySelector(".zb-healing-options").style.display = healingEnabled ? "block" : "none";
      blockEl.querySelector(".zb-fixed-damage-type").style.display = damageTypeMode === "fixed" ? "flex" : "none";
      blockEl.querySelector(".zb-shared-damage-note").style.display = damageTypeMode === "activation-choice" ? "block" : "none";
      blockEl.querySelector(".zb-save-outcomes").style.display = saveEnabled ? "block" : "none";
      blockEl.querySelector(".zb-nosave-outcomes").style.display = saveEnabled ? "none" : "block";

      const immunityStarts = blockEl.querySelector(".zb-immunity-starts");
      immunityStarts.classList.toggle("is-disabled", immunityDuration === "none");
      for (const input of immunityStarts.querySelectorAll("[data-immunity-start]")) {
        input.disabled = immunityDuration === "none";
      }
      blockEl.querySelector(".zb-recovery-condition").style.display = immunityDuration !== "none" && recoveryChecked ? "flex" : "none";

      for (const el of blockEl.querySelectorAll(".zb-damage-multiplier")) {
        el.style.display = (damageEnabled || healingEnabled) ? "flex" : "none";
      }

      for (const row of blockEl.querySelectorAll(".zb-condition-row")) {
        refreshConditionRow(row);
      }

      if (saveEnabled && basic) {
        for (const key of ["criticalSuccess", "success", "failure", "criticalFailure"]) {
          const select = blockEl.querySelector(`[data-outcome="${key}"] [data-field="damage-multiplier"]`);
          select.value = String(BASIC_MULTIPLIERS[key]);
          select.disabled = true;
        }
      } else {
        for (const key of ["criticalSuccess", "success", "failure", "criticalFailure"]) {
          blockEl.querySelector(`[data-outcome="${key}"] [data-field="damage-multiplier"]`).disabled = false;
        }
      }
    }
  }

  /** Lets users copy export data without opening developer tools or altering live zones. */
  async function showJson(title, json) {
    const content = document.createElement("div");
    content.innerHTML = `
      <p class="notes"><b>To copy:</b> click inside the JSON box, press <b>Ctrl+A</b> to select all, then press <b>Ctrl+C</b>. This JSON contains only the portable zone configuration and intentionally contains no source Actor or Token UUID.</p>
      <textarea class="zb-json" style="width:100%;height:360px;max-height:45vh;font-family:monospace;white-space:pre" readonly>${esc(json)}</textarea>`;

    const dlg = new DialogV2({
      window: { title },
      position: { width: Math.max(620, Math.min(760, globalThis.innerWidth - 100)) },
      content,
      buttons: [
        { action: "close", label: "Close", icon: "fa-solid fa-xmark" }
      ]
    });
    await dlg.render({ force: true });
  }

  /** Keeps source ownership out of imported data so a preset cannot redirect a zone to another actor. */
  async function importJson() {
    const content = document.createElement("div");
    content.innerHTML = `
      <p>Paste a PF2e Zone Builder configuration below. The current selected source actor is <b>${esc(sourceActor.name)}</b>; source information is never read from the JSON.</p>
      <textarea name="json" style="width:100%;height:320px;max-height:42vh;font-family:monospace" placeholder="Paste JSON here"></textarea>`;

    const fd = await DialogV2.input({
      window: { title: "Import PF2e Zone JSON" },
      position: { width: Math.max(600, Math.min(720, globalThis.innerWidth - 100)) },
      content,
      ok: { label: "Import", icon: "fa-solid fa-file-import" },
      rejectClose: false
    });
    if (!fd) return null;

    try {
      const parsed = JSON.parse(String(fd.json ?? ""));
      if (parsed?.schemaVersion && Number(parsed.schemaVersion) > SCHEMA_VERSION) {
        ui.notifications.error(`This preset uses schema version ${parsed.schemaVersion}; this builder supports version ${SCHEMA_VERSION}.`);
        return null;
      }
      return normalizeConfig(parsed);
    } catch (err) {
      console.error("PF2e Zone Builder import error", err);
      ui.notifications.error(`Could not parse zone JSON: ${err.message}`);
      return null;
    }
  }

  /** Condenses validation into a review dialog while preserving warnings that do not block creation. */
  function validationMessage({ errors, warnings }) {
    if (!errors.length && !warnings.length) return "Configuration is valid.";
    const parts = [];
    if (errors.length) parts.push(`Errors:\n• ${errors.join("\n• ")}`);
    if (warnings.length) parts.push(`Warnings:\n• ${warnings.join("\n• ")}`);
    return parts.join("\n\n");
  }

  /** Gives users an explicit review step when they ask to validate rather than create. */
  async function showValidation(result) {
    const content = document.createElement("div");
    const errors = result.errors.map((x) => `<li>${esc(x)}</li>`).join("");
    const warnings = result.warnings.map((x) => `<li>${esc(x)}</li>`).join("");
    content.innerHTML = `
      ${result.errors.length ? `<h3>Errors</h3><ul>${errors}</ul>` : `<p><i class="fa-solid fa-circle-check"></i> No validation errors.</p>`}
      ${result.warnings.length ? `<h3>Warnings</h3><ul>${warnings}</ul>` : `<p><i class="fa-solid fa-circle-check"></i> No warnings.</p>`}`;
    await DialogV2.prompt({
      window: { title: result.errors.length ? "Zone Configuration Problems" : "Zone Configuration Validation" },
      content,
      ok: { label: "Close" },
      rejectClose: false
    });
  }


  /** Keeps Region behavior creation compatible with Foundry internal type changes. */
  function executeScriptBehaviorType() {
    const match = Object.entries(CONFIG.RegionBehavior?.dataModels ?? {})
      .find(([, cls]) => cls?.name === "ExecuteScriptRegionBehaviorType");
    return match?.[0] ?? "executeScript";
  }

  /** Makes each Region call the installed module runtime so later module fixes apply to existing zones. */
  function runtimeScriptSource() {
    return `
const api = game.modules.get("pf2e-zone-automation")?.api;
if (!api?.handleRegionEvent) throw new Error("PF2e Zone Automation module is not active.");
await api.handleRegionEvent({ behavior, event, region, scene: typeof scene !== "undefined" ? scene : region?.parent });
`;
  }

  /** Separates automatic cleanup schedules from zones that are meant to continue indefinitely. */
  function finiteDurationRounds(cfg) {
    switch (cfg.duration.type) {
      case "1-round": return 1;
      case "custom-rounds": {
        const rounds = Number(cfg.duration?.rounds);
        return Number.isSafeInteger(rounds) && rounds > 0 ? rounds : null;
      }
      case "1-minute": return 10;
      case "10-minutes": return 100;
      default: return null;
    }
  }

  /** Captures source and duration facts at creation so future events can be resolved authoritatively. */
  function initialRuntimeState(cfg, chosenDamageType, durationResolution = null) {
    const combat = game.combat;
    const sourceCombatant = sourceActor.combatant ?? null;
    const rounds = durationResolution?.rounds ?? finiteDurationRounds(cfg);
    const currentIsSource = Boolean(combat && sourceCombatant && combat.combatant?.id === sourceCombatant.id);
    const currentTurnKey = currentIsSource
      ? `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${sourceCombatant.id}`
      : null;

    return {
      createdWorldTime: Number(game.time?.worldTime ?? 0),
      createdBy: { userId: game.user.id, name: game.user.name },
      sourceActorUuid: sourceActor.uuid,
      sourceTokenUuid: sourceToken.document.uuid,
      activation: { damageType: chosenDamageType ?? null },
      activationProcessed: false,
      activationPending: true,
      activationFinalizeScheduled: false,
      activationTargets: {},
      initialOccupants: {},
      deactivated: false,
      pendingSaves: {},
      repeat: {},
      immunities: {},
      applied: {},
      damageRolls: {},
      healingRolls: {},
      recoveryWatchers: {},
      turnStartEvents: {},
      lastSourceTriggerTurnKey: currentTurnKey,
      duration: rounds ? {
        rounds,
        formula: durationResolution?.formula ?? null,
        worldExpires: Number(game.time?.worldTime ?? 0) + rounds * 6,
        combatId: combat?.id ?? null,
        sourceCombatantId: sourceCombatant?.id ?? null,
        sourceTurnsElapsed: 0,
        lastSourceTurnKey: currentTurnKey
      } : {}
    };
  }

  /** Asks once for shared damage type choices so every block uses the same activation decision. */
  async function chooseActivationDamageType(cfg) {
    const choice = cfg.activationChoices?.damageType;
    if (!choice?.enabled) return null;
    if (choice.options.length === 1) return choice.options[0];
    const options = choice.options.map((slug) =>
      `<option value="${esc(slug)}">${esc(titleCase(slug))}</option>`
    ).join("");
    const fd = await DialogV2.input({
      window: { title: `${cfg.name} — Choose Damage Type` },
      content: `<p>Choose the shared damage type for this zone activation.</p><label>Damage type<select name="damageType">${options}</select></label>`,
      ok: { label: "Use Damage Type", icon: "fa-solid fa-check" },
      rejectClose: false
    });
    return fd ? String(fd.damageType ?? "") : undefined;
  }

  /** Limits Region hooks to the events zone automation actually needs to observe. */
  function regionBehaviorData() {
    return {
      name: "PF2e Zone Runtime",
      type: executeScriptBehaviorType(),
      system: {
        events: [
          "behaviorActivated",
          "behaviorDeactivated",
          "behaviorViewed",
          "tokenEnter",
          "tokenExit",
          "tokenTurnStart",
          "tokenTurnEnd"
        ],
        source: runtimeScriptSource()
      },
      disabled: false,
      flags: {}
    };
  }

  /** Keeps direct GM creation on the same data shape and runtime activation path as player creation. */
  async function createZoneRegion(cfg, chosenDamageType) {
    if (!game.user.isGM) {
      let areaCenter = null;
      if (cfg.mode === "area") {
        areaCenter = await pickAreaCenter(cfg.name, cfg.radius);
        if (!areaCenter) return null;
      }

      const response = await callGMWorker("create", {
        sceneId: canvas.scene.id,
        sourceTokenUuid: sourceToken.document.uuid,
        config: clone(cfg),
        chosenDamageType: chosenDamageType ?? null,
        color: game.user.color,
        areaCenter
      });
      if (response.duration?.formula) {
        ui.notifications.info(`PF2e Zone duration: ${response.duration.rounds} rounds (rolled ${response.duration.formula}).`);
      }

      return await waitForRegion(response.sceneId, response.regionId);
    }

    const durationResolution = await resolveDurationRounds(cfg.duration);
    const payload = {
      runtimeVersion: RUNTIME_VERSION,
      config: clone(cfg),
      state: initialRuntimeState(cfg, chosenDamageType, durationResolution)
    };
    const regionData = {
      name: cfg.name,
      color: lightenZoneColor(game.user.color),
      visibility: cfg.visibility === "creator"
        ? (CONST.REGION_VISIBILITY?.OBSERVER ?? 3)
        : (CONST.REGION_VISIBILITY?.ALWAYS ?? 2),
      ownership: cfg.visibility === "creator"
        ? {
            default: CONST.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0,
            [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2
          }
        : undefined,
      behaviors: [regionBehaviorData()],
      flags: { world: { pf2eZone: payload } }
    };

    let region = null;
    if (cfg.mode === "emanation") {
      const RegionDocument = CONFIG.Region.documentClass;
      if (typeof RegionDocument?.createTokenEmanation !== "function") {
        throw new Error("Foundry V14 RegionDocument.createTokenEmanation is unavailable.");
      }
      region = await RegionDocument.createTokenEmanation(sourceToken.document, cfg.radius, regionData);
    } else {
      ui.notifications.info(`Place the ${cfg.radius}-foot ${cfg.name} area on the Scene.`);
      region = await canvas.regions.placeRegion({
        ...regionData,
        shapes: [{
          type: "circle",
          x: 0,
          y: 0,
          radius: cfg.radius * canvas.dimensions.distancePixels,
          gridBased: true
        }]
      });
    }

    if (!region) return null;
    const runtime = await zoneRuntimeEntrypoint();
    await runtime.activateRegion(region);
    await postFormulaDurationMessage({
      zoneName: cfg.name,
      duration: durationResolution,
      visibility: cfg.visibility,
      creatorUserId: game.user.id,
      actor: sourceActor,
      token: sourceToken.document
    });
    if (durationResolution?.formula) {
      ui.notifications.info(`PF2e Zone duration: ${durationResolution.rounds} rounds (rolled ${durationResolution.formula}).`);
    }
    return region;
  }


  /** Reads shared presets through the GM worker so players do not need Journal write permissions. */
  async function fetchSavedZoneRecords() {
    const response = await callGMWorker("library-list");
    return Array.isArray(response.records) ? response.records : [];
  }

  /** Preserves ownership and revision checks when users save a zone for later reuse. */
  async function saveCurrentPreset(root, { asNew = false } = {}) {
    const cfg = syncState(root);
    const validation = validateConfig(cfg);
    if (validation.errors.length) {
      await showValidation(validation);
      return false;
    }

    if (!asNew && loadedPreset && !canOverwritePreset(loadedPreset)) {
      ui.notifications.warn(`You can load ${presetLabel(loadedPreset)}, but only its creator or a GM can overwrite it. Use Save As instead.`);
      return false;
    }

    const response = await callGMWorker("library-save", {
      recordId: asNew ? null : (loadedPreset?.id ?? null),
      config: clone(cfg)
    });
    loadedPreset = clone(response.record);
    state = normalizeConfig(response.record.config);
    ui.notifications.info(`${asNew ? "Saved copy" : "Saved"} '${presetLabel(loadedPreset)}' to ${LIBRARY_JOURNAL_NAME}.`);
    rerenderInsideDialog();
    return true;
  }

  /** Lets users choose a shared preset without exposing the implementation details of the Library Journal. */
  async function showSavedZones() {
    const records = await fetchSavedZoneRecords();
    records.sort((a, b) => {
      const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
      if (byName) return byName;
      return String(a.createdBy?.name ?? "").localeCompare(String(b.createdBy?.name ?? ""), undefined, { sensitivity: "base" });
    });

    if (!records.length) {
      ui.notifications.info(`There are no saved zones in ${LIBRARY_JOURNAL_NAME}.`);
      return;
    }

    const rows = records.map((record) => {
      const canDelete = game.user.isGM || record.createdBy?.userId === game.user.id;
      return `<div class="pza-saved-row" data-record-id="${esc(record.id)}">
        <div>
          <b>${esc(presetLabel(record))}</b>
        </div>
        <button type="button" data-action="load"><i class="fa-solid fa-folder-open"></i> Load</button>
        ${canDelete ? `<button type="button" data-action="delete" class="danger"><i class="fa-solid fa-trash"></i> Delete</button>` : `<span></span>`}
      </div>`;
    }).join("");

    const content = document.createElement("div");
    content.innerHTML = `
      <style>
        .pza-saved-list { max-height:55vh; overflow:auto; }
        .pza-saved-row { display:grid; grid-template-columns:minmax(240px,1fr) auto auto; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid rgba(127,127,127,.3); }
        .pza-saved-row:last-child { border-bottom:0; }
        .pza-saved-row button.danger { border-color:#a22; }
      </style>
      <div class="pza-saved-list">${rows}</div>`;

    const dlg = new DialogV2({
      window: { title: "Saved PF2e Zones" },
      position: { width: Math.max(520, Math.min(720, globalThis.innerWidth - 100)) },
      content,
      buttons: [{ action: "close", label: "Close", icon: "fa-solid fa-xmark" }]
    });

    dlg.addEventListener("render", () => {
      const list = dlg.window.content.querySelector(".pza-saved-list");
      list?.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        const row = button?.closest("[data-record-id]");
        if (!button || !row) return;
        const record = records.find((r) => r.id === row.dataset.recordId);
        if (!record) return;

        if (button.dataset.action === "load") {
          state = normalizeConfig(record.config);
          loadedPreset = clone(record);
          await dlg.close();
          rerenderInsideDialog();
          ui.notifications.info(`Loaded '${presetLabel(record)}'.`);
          return;
        }

        if (button.dataset.action === "delete") {
          const allowed = game.user.isGM || record.createdBy?.userId === game.user.id;
          if (!allowed) {
            ui.notifications.warn("Only the zone's creator or a GM can delete that saved zone.");
            return;
          }
          if (!window.confirm(`Delete saved zone '${presetLabel(record)}'?`)) return;

          button.disabled = true;
          try {
            await callGMWorker("library-delete", { recordId: record.id });
            row.remove();
            const index = records.findIndex((r) => r.id === record.id);
            if (index >= 0) records.splice(index, 1);
            if (loadedPreset?.id === record.id) {
              loadedPreset = null;
              rerenderInsideDialog();
            }
            ui.notifications.info(`Deleted '${presetLabel(record)}'.`);
            if (!list.querySelector("[data-record-id]")) await dlg.close();
          } catch (error) {
            console.error("PF2e Zone saved-zone deletion failed", error);
            ui.notifications.error(`Could not delete saved zone: ${error.message ?? error}`);
            button.disabled = false;
          }
        }
      });
    }, { once: true });

    await dlg.render({ force: true });
  }

  /** Provides a safe lifecycle view for active zones instead of requiring users to find Regions manually. */
  async function manageExistingZones() {
    const runtime = await zoneRuntimeEntrypoint();
    const zones = [...canvas.scene.regions].filter((r) => r.getFlag("world", "pf2eZone"));
    if (!zones.length) {
      ui.notifications.info("There are no PF2e Zone Automation Regions on this Scene.");
      return;
    }

    const zoneRows = [];
    for (const region of zones) {
      const payload = region.getFlag("world", "pf2eZone");
      const cfg = payload?.config ?? {};
      const canEnd = await canCurrentUserDismiss(payload);
      zoneRows.push(`<div class="pza-zone-row" data-region-id="${esc(region.id)}">
        <div><b>${esc(region.name)}</b><div class="pza-zone-meta">Created by ${esc(payload?.state?.createdBy?.name ?? "Unknown")} · ${esc(titleCase(cfg.mode))} · ${esc(cfg.radius)} ft · ${esc(titleCase(cfg.duration?.type))}</div></div>
        <button type="button" data-action="load-config"><i class="fa-solid fa-folder-open"></i> Load Config</button>
        ${canEnd ? `<button type="button" data-action="end" class="danger"><i class="fa-solid fa-trash"></i> Dismiss</button>` : `<span></span>`}
      </div>`);
    }

    const content = document.createElement("div");
    content.innerHTML = `
      <style>
        .pza-manage { max-height:55vh; overflow:auto; }
        .pza-zone-row { display:grid; grid-template-columns:minmax(180px,1fr) auto auto; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid rgba(127,127,127,.3); }
        .pza-zone-row:last-child { border-bottom:0; }
        .pza-zone-meta { opacity:.72; font-size:.9em; }
      </style>
      <div class="pza-manage">${zoneRows.join("")}</div>`;

    const dlg = new DialogV2({
      window: { title: "Manage PF2e Zones" },
      position: { width: Math.max(560, Math.min(760, globalThis.innerWidth - 100)) },
      content,
      buttons: [{ action: "close", label: "Close", icon: "fa-solid fa-xmark" }]
    });
    dlg.addEventListener("render", () => {
      const root = dlg.window.content.querySelector(".pza-manage");
      root?.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        const row = button?.closest("[data-region-id]");
        const region = row ? canvas.scene.regions.get(row.dataset.regionId) : null;
        if (!button || !region) return;
        const payload = region.getFlag("world", "pf2eZone");
        if (button.dataset.action === "load-config") {
          if (!payload?.config) {
            ui.notifications.warn(`PF2e Zone '${region.name}' has no saved configuration to load.`);
            return;
          }
          state = normalizeConfig(payload.config);
          loadedPreset = null;
          await dlg.close();
          rerenderInsideDialog();
          ui.notifications.info(`Loaded the configuration from '${region.name}'. Source actor was not changed.`);
        } else if (button.dataset.action === "end") {
          button.disabled = true;
          try {
            if (game.user.isGM) {
              await runtime.endZone(region, "manager");
            } else {
              await callGMWorker("end", { sceneId: canvas.scene.id, regionId: region.id });
            }
            row.remove();
            if (!root.querySelector("[data-region-id]")) await dlg.close();
          } catch (error) {
            console.error("PF2e Zone dismissal failed", error);
            ui.notifications.error(`PF2e Zone dismissal failed: ${error.message ?? error}`);
            button.disabled = false;
          }
        }
      });
    }, { once: true });
    await dlg.render({ force: true });
  }

  /** Keeps previews and collapsed summaries understandable without exposing internal trigger keys. */
  function triggerLabels(block) {
    const triggers = block?.triggers ?? {};
    const labels = [];
    if (triggers.activation) labels.push("When created");
    if (triggers.enter) labels.push("When a creature enters");
    if (triggers.turnStart) labels.push("At creature turn start");
    if (triggers.sourceTurnStart) labels.push("At source turn start");
    if (triggers.turnEnd) labels.push("At creature turn end");
    if (triggers.continuous) labels.push("While inside");
    if (triggers.spellCast) labels.push("When a creature casts a spell");
    if (triggers.traitUse) {
      const watchedTraits = watchedTraitSlugs(block?.traitUse);
      labels.push(`When ${watchedTraits.length ? watchedTraits.map(titleCase).join(" or ") : "a selected trait"} is used`);
    }
    return labels;
  }

  /** Lets users review the actual serialized configuration before it changes the Scene. */
  function previewHtml(cfg, validation) {
    const durationInput = cfg.duration?.type === "custom-rounds"
      ? parseDurationRounds(cfg.duration.rounds)
      : null;
    const durationText = cfg.duration?.type === "custom-rounds"
      ? `${cfg.duration.rounds} round${String(cfg.duration.rounds) === "1" ? "" : "s"}${durationInput?.kind === "formula" ? " (rolled when created)" : ""}`
      : titleCase(cfg.duration?.type);
    const blocks = cfg.effects.map((block) => {
      const saveKind = block.save.type === "choice"
        ? `Target chooses ${block.save.choices.map(titleCase).join(" or ")}`
        : titleCase(block.save.type);
      const saveText = block.save.enabled
        ? `${saveKind} — ${block.save.dc.mode === "custom" ? `DC ${block.save.dc.value}` : esc(block.save.dc.statistic)}${block.save.basic ? " (basic)" : ""}`
        : "None";
      const damageTypeText = block.damage.typeMode === "activation-choice"
        ? "shared activation type"
        : titleCase(block.damage.type);
      const damageText = block.damage.enabled ? `${esc(block.damage.formula)} ${esc(damageTypeText)}` : "None";
      const healingText = block.healing?.enabled ? esc(block.healing.formula) : "None";
      const alertText = block.chatAlert?.enabled ? "Yes" : "No";
      return `<li><b>${esc(block.name)}</b>: ${esc(triggerLabels(block).join(", "))}<br><span style="opacity:.8">Save: ${saveText}; Damage: ${damageText}; Healing: ${healingText}; Chat Alert: ${alertText}; Immunity: ${esc(titleCase(block.immunity.duration))}</span></li>`;
    }).join("");

    return `
      <div class="pf2e-zone-preview">
        <h3>${esc(cfg.name)}</h3>
        <p><b>Source:</b> ${esc(sourceActor.name)} (${esc(sourceToken.name)})<br>
        <b>Zone:</b> ${esc(titleCase(cfg.mode))}, ${cfg.radius}-foot radius<br>
        <b>Targets:</b> ${esc(titleCase(cfg.targeting.affects))}${cfg.targeting.includeSelf ? ", including source" : ""}<br>
        <b>Traits:</b> ${cfg.traits.length ? cfg.traits.map(esc).join(", ") : "None"}<br>
        <b>Visibility:</b> ${cfg.visibility === "creator" ? "Creator only" : "Everyone"}<br>
        <b>Duration:</b> ${esc(durationText)}<br>
        <b>Shared activation damage type:</b> ${cfg.activationChoices?.damageType?.enabled ? cfg.activationChoices.damageType.options.map(titleCase).join(", ") : "None"}</p>
        <h4>Effect Blocks</h4>
        <ol>${blocks}</ol>
        ${validation.warnings.length ? `<p><b>Builder warnings:</b> ${validation.warnings.map(esc).join("; ")}</p>` : ""}
        <p style="opacity:.7"><i>Preview only. Use Create Zone to create the Region and activate runtime automation.</i></p>
      </div>`;
  }

  /** Captures current form input before actions that rerender, save, preview, or create. */
  function syncState(root) {
    state = readConfig(root);
    return state;
  }

  let dialog;
  let operationStatusTimer = null;

  /** Keeps connection and ownership limits visible while the builder remains open. */
  function refreshOperationStatus(root) {
    const operation = currentOperationStatus();
    const status = root.querySelector("[data-operation-status]");
    const container = root.querySelector("[data-operation-status-container]");
    const icon = root.querySelector("[data-operation-status-icon]");

    if (status && container && icon) {
      container.classList.toggle("is-ready", operation.ready);
      container.classList.toggle("has-errors", !operation.ready);
      icon.className = `fa-solid ${operation.icon}`;
      status.textContent = operation.text;
      status.title = operation.detail;
    }
    return operation;
  }

  /** Prevents background timers from surviving after the dialog is closed. */
  function stopOperationStatusPolling() {
    if (operationStatusTimer === null) return;
    globalThis.clearInterval(operationStatusTimer);
    operationStatusTimer = null;
  }

  /** Refreshes player availability when a GM connects or disconnects while the dialog is open. */
  function startOperationStatusPolling(root) {
    stopOperationStatusPolling();
    operationStatusTimer = globalThis.setInterval(() => {
      if (!root.isConnected) {
        stopOperationStatusPolling();
        return;
      }
      refreshOperationStatus(root);
    }, 1000);
  }

  /** Updates dynamic content without losing the current dialog context or its event wiring. */
  function rerenderInsideDialog() {
    const content = dialog.window.content;
    content.innerHTML = renderRoot();
    wire(content.querySelector(".pf2e-zone-builder"));
  }

  /** Finds the canonical block before mutations so UI buttons cannot edit an obsolete copy. */
  function findBlock(blockId) {
    return state.effects.find((b) => b.id === blockId);
  }

  /** Connects the rendered controls to state changes while keeping validation current after every edit. */
  function wire(root) {
    if (!root) return;
    refreshVisibility(root);
    refreshLiveValidation(root);
    startOperationStatusPolling(root);

    for (const blockElement of root.querySelectorAll("details.zb-block")) {
      blockElement.addEventListener("toggle", () => {
        if (blockElement.open) return;
        const block = readConfig(root).effects.find((entry) => entry.id === blockElement.dataset.blockId);
        const summary = blockElement.querySelector("[data-block-summary]");
        if (block && summary) summary.textContent = blockSummary(block);
      });
    }

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (target.matches('[data-field="condition-slug"]')) {
        const row = target.closest(".zb-condition-row");
        const valueInput = row?.querySelector('[data-field="condition-value"]');
        if (valueInput) {
          const valued = isValuedCondition(target.value);
          valueInput.disabled = !valued;
          valueInput.placeholder = valued ? "1" : "—";
          if (valued && !valueInput.value) valueInput.value = "1";
          if (!valued) valueInput.value = "";
        }
        refreshLiveValidation(root);
        return;
      }

      if (target.matches('[data-field="condition-removal"]')) {
        refreshConditionRow(target.closest(".zb-condition-row"));
        refreshLiveValidation(root);
        return;
      }

      if (target.matches('[data-zone="duration-type"], [data-zone="damage-choice-enabled"], [data-trigger="traitUse"], [data-trigger="spellCast"], [data-field="chat-alert-enabled"], [data-field="save-enabled"], [data-field="save-type"], [data-field="dc-source"], [data-field="basic-save"], [data-field="damage-enabled"], [data-field="healing-enabled"], [data-field="damage-type-mode"], [data-field="immunity-duration"], [data-immunity-start]')) {
        refreshVisibility(root);
      }
      refreshLiveValidation(root);
    });

    root.addEventListener("input", (event) => {
      if (event.target instanceof HTMLElement) refreshLiveValidation(root);
    });

    root.querySelector(".zb-use-selection").addEventListener("click", () => {
      syncState(root);
      const current = selectedSourceToken();
      if (!current) return;
      sourceToken = current;
      sourceActor = current.actor;
      rerenderInsideDialog();
      ui.notifications.info(`PF2e Zone Builder source set to ${sourceActor.name}.`);
    });

    for (const button of root.querySelectorAll(".zb-add-block")) {
      button.addEventListener("click", () => {
        syncState(root);
        state.effects.push(newBlock(state.effects.length + 1));
        rerenderInsideDialog();
      });
    }

    for (const button of root.querySelectorAll(".zb-remove-block")) {
      button.addEventListener("click", () => {
        syncState(root);
        if (state.effects.length <= 1) return;
        state.effects = state.effects.filter((b) => b.id !== button.dataset.block);
        rerenderInsideDialog();
      });
    }

    for (const button of root.querySelectorAll(".zb-duplicate-block")) {
      button.addEventListener("click", () => {
        syncState(root);
        const block = findBlock(button.dataset.block);
        if (!block) return;
        const copy = clone(block);
        copy.id = newId();
        copy.name = `${copy.name} Copy`;
        const idx = state.effects.findIndex((b) => b.id === block.id);
        state.effects.splice(idx + 1, 0, copy);
        rerenderInsideDialog();
      });
    }

    // Degree-of-success payload rows are edited in place so adding/removing a
    // Condition or Effect Item does not rerender the builder and reset scroll.
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || !root.contains(button)) return;

      if (button.matches(".zb-add-condition")) {
        const outcomeEl = button.closest(".zb-outcome");
        const list = outcomeEl?.querySelector(".zb-condition-list");
        if (!outcomeEl || !list) return;

        list.querySelector(".zb-empty")?.remove();

        const holder = document.createElement("div");
        const index = list.querySelectorAll(".zb-condition-row").length;
        holder.innerHTML = renderConditionRow(
          { slug: "frightened", value: 1, removal: "normal", condition: null },
          button.dataset.block,
          button.dataset.outcome,
          index
        );
        const row = holder.firstElementChild;
        if (row) {
          list.append(row);
          refreshConditionRow(row);
        }
        refreshLiveValidation(root);
        return;
      }

      if (button.matches(".zb-remove-condition")) {
        const row = button.closest(".zb-condition-row");
        const list = row?.closest(".zb-condition-list");
        if (!row || !list) return;

        row.remove();
        if (!list.querySelector(".zb-condition-row")) {
          list.innerHTML = `<div class="zb-empty">No conditions</div>`;
        }
        refreshLiveValidation(root);
        return;
      }

      if (button.matches(".zb-add-effect")) {
        const outcomeEl = button.closest(".zb-outcome");
        const list = outcomeEl?.querySelector(".zb-effect-list");
        if (!outcomeEl || !list) return;

        list.querySelector(".zb-empty")?.remove();

        const holder = document.createElement("div");
        const index = list.querySelectorAll(".zb-effect-row").length;
        holder.innerHTML = renderEffectRow(
          { uuid: "", removal: "item-duration" },
          button.dataset.block,
          button.dataset.outcome,
          index
        );
        const row = holder.firstElementChild;
        if (row) list.append(row);
        refreshLiveValidation(root);
        return;
      }

      if (button.matches(".zb-remove-effect")) {
        const row = button.closest(".zb-effect-row");
        const list = row?.closest(".zb-effect-list");
        if (!row || !list) return;

        row.remove();
        if (!list.querySelector(".zb-effect-row")) {
          list.innerHTML = `<div class="zb-empty">No Effect Items</div>`;
        }
        refreshLiveValidation(root);
      }
    });

    root.querySelector(".zb-load-saved").addEventListener("click", async () => {
      syncState(root);
      try {
        await showSavedZones();
      } catch (error) {
        console.error("PF2e Zone saved-zone load failed", error);
        ui.notifications.error(`Could not open saved zones: ${error.message ?? error}`);
      }
    });

    root.querySelector(".zb-save").addEventListener("click", async () => {
      try {
        await saveCurrentPreset(root, { asNew: false });
      } catch (error) {
        console.error("PF2e Zone save failed", error);
        ui.notifications.error(`Could not save zone: ${error.message ?? error}`);
      }
    });

    root.querySelector(".zb-save-as").addEventListener("click", async () => {
      try {
        await saveCurrentPreset(root, { asNew: true });
      } catch (error) {
        console.error("PF2e Zone Save As failed", error);
        ui.notifications.error(`Could not save zone copy: ${error.message ?? error}`);
      }
    });

    root.querySelector(".zb-manage").addEventListener("click", async () => {
      syncState(root);
      await manageExistingZones();
    });

    root.querySelector(".zb-import").addEventListener("click", async () => {
      syncState(root);
      const imported = await importJson();
      if (!imported) return;
      state = imported;
      loadedPreset = null;
      rerenderInsideDialog();
      ui.notifications.info("Zone configuration imported. Source actor was not changed.");
    });

    root.querySelector(".zb-close").addEventListener("click", async () => {
      await dialog.close();
    });

    root.querySelector(".zb-export").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = validateConfig(cfg);
      if (validation.errors.length) {
        await showValidation(validation);
        return;
      }
      const json = JSON.stringify(cfg, null, 2);
      console.log("PF2e Zone Builder exported configuration", cfg);
      await showJson(`Export Zone JSON — ${cfg.name}`, json);
    });

    root.querySelector(".zb-validate").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = refreshLiveValidation(root);
      console.log("PF2e Zone Builder validation", { cfg, validation });
      await showValidation(validation);
    });

    root.querySelector(".zb-preview").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = refreshLiveValidation(root);
      if (validation.errors.length) {
        await showValidation(validation);
        return;
      }

      // Useful during phase-one testing. This is intentionally not persistent game data.
      globalThis.PF2EZoneBuilderLastConfig = clone(cfg);
      console.log("PF2e Zone Builder normalized configuration", cfg);

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken.document }),
        content: previewHtml(cfg, validation)
      });
      ui.notifications.info("Zone configuration is valid. Preview posted to chat and config written to console.");
    });

    root.querySelector(".zb-create").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = refreshLiveValidation(root);
      if (validation.errors.length) {
        await showValidation(validation);
        return;
      }
      const chosenDamageType = await chooseActivationDamageType(cfg);
      if (cfg.activationChoices?.damageType?.enabled && chosenDamageType === undefined) return;

      const button = root.querySelector(".zb-create");
      button.disabled = true;
      /** Gives the creation flow one safe restoration callback whether or not the builder was hidden for placement. */
      const restoreBuilder = cfg.mode === "area" ? hideBuilderForAreaPlacement() : () => {};
      try {
        globalThis.PF2EZoneBuilderLastConfig = clone(cfg);
        const region = await createZoneRegion(cfg, chosenDamageType);
        if (!region) {
          restoreBuilder();
          ui.notifications.info("Zone creation was cancelled.");
          return;
        }
        console.log("PF2e Zone created", { region, config: cfg });
        ui.notifications.info(`PF2e Zone '${cfg.name}' created.`);
        await dialog.close();
      } catch (error) {
        restoreBuilder();
        console.error("PF2e Zone creation failed", error);
        ui.notifications.error(`PF2e Zone creation failed: ${error.message ?? error}`);
      } finally {
        refreshLiveValidation(root);
      }
    });
  }

  await zoneRuntimeEntrypoint();

  if (!game.user.isGM) {
    const workerProblem = workerSetupProblem();
    if (workerProblem) console.warn("PF2e Zone player setup:", workerProblem);
  }

  if (globalThis.PF2EZoneRuntimeLegacyHooksDetected) {
    ui.notifications.warn(
      "PF2e Zone: hooks from an older test build are still active in this browser session. Refresh Foundry once before further duration testing."
    );
  }

  const content = document.createElement("div");
  content.innerHTML = renderRoot();

  const builderWidth = Math.max(720, Math.min(980, globalThis.innerWidth - 120));

  dialog = new DialogV2({
    window: { title: `PF2e Zone Automation v${game.modules.get("pf2e-zone-automation")?.version ?? "unknown"}` },
    position: { width: builderWidth },
    content,
    // DialogV2 requires at least one native button. The builder has its own
    // sticky Close/Validate bar, so this native footer is hidden after render.
    buttons: [
      { action: "close", label: "Close", icon: "fa-solid fa-xmark", default: true }
    ]
  });

  dialog.addEventListener("close", () => stopOperationStatusPolling(), { once: true });

  dialog.addEventListener("render", () => {
    // Do not override DialogV2's internal form/layout. The builder itself is the
    // scroll container, which also behaves cleanly when the window is detached.
    const root = dialog.window.content.querySelector(".pf2e-zone-builder");

    // DialogV2 insists on a native button entry. Hide that native footer so the
    // visible controls are only the builder's sticky Close/Validate bar.
    // If Foundry changes this selector later, the harmless fallback is simply
    // that an additional native Close button remains visible.
    const dialogElement = dialog.element ?? dialog.window?.element ?? null;
    const nativeFooter =
      dialogElement?.querySelector?.("footer.form-footer, .form-footer") ??
      dialog.form?.querySelector?.("footer.form-footer, .form-footer") ??
      null;
    if (nativeFooter) nativeFooter.style.display = "none";

    wire(root);
  }, { once: true });

  await dialog.render({ force: true });
}
