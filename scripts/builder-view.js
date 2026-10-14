import { OUTCOMES, emptyOutcome, watchedTraitSlugs, isValuedCondition } from "./zone-config.js";
import { targetingChoices, targetLabels } from "./targeting.js";
import { zoneTypeChoice } from "./area-shape.js";
import { parseDurationRounds } from "./duration.js";
import { escapeHtml as esc, titleCase } from "./utils.js";
import { COMMON_TRAITS, WATCHED_TRAITS } from "./builder-catalog.js";

/** Shows ownership alongside a preset name so similarly named shared records remain distinguishable. */
export function presetLabel(record) {
  return `${record?.name ?? "Unnamed Zone"} (${record?.createdBy?.name ?? "Unknown"})`;
}

/** Makes collapsed blocks reviewable without forcing users to reopen every configuration detail. */
export function blockSummary(block) {
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

/** Keeps previews and collapsed summaries understandable without exposing internal trigger keys. */
export function triggerLabels(block) {
  const triggers = block?.triggers ?? {};
  const labels = [];
  if (triggers.activation) labels.push("When created");
  if (triggers.enter) labels.push("When a creature enters");
  if (triggers.turnStart) labels.push("At creature turn start");
  if (triggers.sourceTurnStart) labels.push("At source turn start");
  if (triggers.turnEnd) labels.push("At creature turn end");
  if (triggers.continuous) labels.push("While inside");
  if (triggers.spellCast) labels.push("When a creature casts a spell");
  if (triggers.hpThreshold) labels.push(`When HP drops to ${block?.hitPoints?.threshold ?? "?"} or less`);
  if (triggers.traitUse) {
    const watchedTraits = watchedTraitSlugs(block?.traitUse);
    labels.push(`When ${watchedTraits.length ? watchedTraits.map(titleCase).join(" or ") : "a selected trait"} is used`);
  }
  return labels;
}

/** Keeps an effect UUID and its cleanup rule together because they describe one application. */
export function renderEffectRow(effect, blockId, outcomeKey, index) {
  return `
    <div class="zb-subrow zb-effect-row" data-effect-index="${index}">
      <input data-field="effect-uuid" type="text" value="${esc(effect.uuid)}" placeholder="Drop a PF2e Effect Item or paste its UUID">
      <div class="zb-effect-info" aria-live="polite">Drop a PF2e Effect Item here or paste its UUID.</div>
      <select data-field="effect-removal" title="When should the Effect Item be removed?">
        <option value="item-duration" ${effect.removal === "item-duration" ? "selected" : ""}>Use Effect Item duration</option>
        <option value="on-exit" ${effect.removal === "on-exit" ? "selected" : ""}>Remove on exit</option>
        <option value="zone-end" ${effect.removal === "zone-end" ? "selected" : ""}>Remove when zone ends</option>
      </select>
      <button type="button" class="icon zb-remove-effect" data-block="${blockId}" data-outcome="${outcomeKey}" data-index="${index}" title="Remove effect"><i class="fa-solid fa-trash"></i></button>
    </div>`;
}

/** Condenses validation into a review dialog while preserving warnings that do not block creation. */
export function validationMessage({ errors, warnings }) {
  if (!errors.length && !warnings.length) return "Configuration is valid.";
  const parts = [];
  if (errors.length) parts.push(`Errors:\n• ${errors.join("\n• ")}`);
  if (warnings.length) parts.push(`Warnings:\n• ${warnings.join("\n• ")}`);
  return parts.join("\n\n");
}

/** Renders editor and preview markup from an explicit snapshot without reading or changing Foundry state. */
export function createBuilderView({ state, sourceActor, sourceToken, loadedPreset, conditionChoices, damageChoices, dcChoices, sourceMatches, canOverwrite }) {
  /** Uses only the condition catalog supplied with this rendering snapshot. */
  function getConditionChoices() { return conditionChoices; }
  /** Uses only the damage catalog supplied with this rendering snapshot. */
  function getDamageChoices() { return damageChoices; }
  /** Supplies statistic choices captured by the operation controller. */
  function getDcChoices() { return dcChoices; }
  /** Preserves unknown condition values against the supplied catalog. */
  function conditionSlugs() { return conditionChoices.map(choice => choice.slug); }
  /** Renders a selection warning from the controller's current source check. */
  function selectionStillMatchesSource() { return sourceMatches; }
  /** Renders preset access from the controller's current ownership check. */
  function canOverwritePreset() { return canOverwrite; }

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
    const slug = String(selected ?? "");
    const choices = getConditionChoices();
    const unavailable = choices.some((choice) => choice.slug === slug)
      ? ""
      : `<option value="${esc(slug)}" selected>${slug ? `Unavailable condition: ${esc(slug)}` : "Choose a condition"}</option>`;
    return unavailable + choices.map(({ slug: choiceSlug, label }) =>
      `<option value="${esc(choiceSlug)}" ${choiceSlug === slug ? "selected" : ""}>${esc(label)}</option>`
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
    const valued = isValuedCondition(condition.slug) || (!conditionSlugs().includes(condition.slug) && condition.value != null);
    const value = valued ? (condition.value ?? 1) : "";
    const linkedCondition = String(condition.condition ?? "");
    return `
      <div class="zb-subrow zb-condition-row" data-condition-index="${index}">
        <select data-field="condition-slug">${conditionOptions(condition.slug)}</select>
        <label class="zb-inline">Value
          <input data-field="condition-value" type="number" min="1" step="1" value="${esc(value)}" placeholder="${valued ? "1" : "—"}" ${valued ? "" : "disabled"}>
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
          <div class="zb-effect-list" title="Drop a PF2e Effect Item here">
            ${outcome.effects.map((e, i) => renderEffectRow(e, block.id, key, i)).join("") || `<div class="zb-empty">No Effect Items</div>`}
          </div>
          <button type="button" class="zb-small zb-add-effect" data-block="${block.id}" data-outcome="${key}"><i class="fa-solid fa-plus"></i> Effect Item</button>
        </div>
      </section>`;
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
              ${trigger("hpThreshold", "When a creature drops to or below a Hit Point amount")}
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

          <fieldset class="zb-hp-threshold-options">
            <legend>Hit Point Trigger</legend>
            <label>Hit Points at or below
              <input data-field="hp-threshold" type="text" inputmode="numeric" value="${esc(block.hitPoints?.threshold ?? "")}" placeholder="e.g. 25">
            </label>
            <p class="notes">Use a separate Effect Block for this trigger. It runs only when an eligible creature inside the zone crosses down to this HP or lower. A creature already at or below it when the zone starts or it enters will not trigger. For troop thresholds, enter one less than the printed threshold because a troop loses a segment below it.</p>
          </fieldset>

          <fieldset>
            <legend>Chat Alert</legend>
            <label class="zb-check"><input type="checkbox" data-field="chat-alert-enabled" ${block.chatAlert?.enabled ? "checked" : ""}> Post a chat alert when this Effect Block triggers</label>
            <div class="zb-chat-alert-options">
              <label>Chat alert text
                <input data-field="chat-alert-text" type="text" value="${esc(block.chatAlert?.text ?? "")}">
              </label>
              <p class="notes">Chat alerts post once per trigger event. Available placeholders: <b>{zone}</b>, <b>{block}</b>, <b>{creature}</b>, <b>{count}</b>, <b>{source}</b>, and <b>{trigger}</b>. Trait-use and spell-cast triggers provide <b>{item}</b>; trait-use triggers also provide <b>{trait}</b>. The Hit Point trigger provides <b>{hp}</b>, <b>{previousHp}</b>, and <b>{threshold}</b>. For multi-target events, <b>{creature}</b> becomes “affected creatures” and <b>{count}</b> gives the number of targets.</p>
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
              <label>Applies to
                <select data-field="immunity-scope">
                  <option value="effect-block" ${block.immunity.scope === "effect-block" ? "selected" : ""}>This Effect Block</option>
                  <option value="shared-group" ${block.immunity.scope === "shared-group" ? "selected" : ""}>Shared immunity group</option>
                </select>
              </label>
              <label class="zb-recovery-condition">Recovery condition
                <select data-field="recovery-condition">${conditionOptions(block.immunity.recoveryCondition)}</select>
              </label>
              <label class="zb-immunity-group">Immunity group
                <input data-field="immunity-group" type="text" value="${esc(block.immunity.group)}" placeholder="e.g. stench">
              </label>
            </div>
            <p class="zb-immunity-group-note notes">Creatures with immunity ignore every zone using this exact group. Use <b>stench</b> for all Stench auras or a narrower key such as <b>stench:ghonhatine</b>.</p>
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
    const targetChoices = targetingChoices(state.targeting);
    const selectedZoneType = zoneTypeChoice(state);
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
          <button type="button" class="zb-load-saved"><i class="fa-solid fa-folder-open"></i> Open</button>
          <button type="button" class="zb-clear"><i class="fa-solid fa-eraser"></i> Clear</button>
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
                  <option value="emanation" ${selectedZoneType === "emanation" ? "selected" : ""}>Emanation — follows source token</option>
                  <option value="area-circle" ${selectedZoneType === "area-circle" ? "selected" : ""}>Area - Circle — placed on the Scene</option>
                  <option value="area-square" ${selectedZoneType === "area-square" ? "selected" : ""}>Area - Square — placed on the Scene</option>
                </select>
              </label>
              <label class="zb-area-radius">Radius (feet)
                <input data-zone="radius" type="number" min="1" step="5" value="${state.radius}">
              </label>
              <label class="zb-area-side-length">Side length (feet)
                <input data-zone="side-length" type="number" min="1" step="5" value="${state.sideLength}">
              </label>
              <label>Visibility
                <select data-zone="visibility">
                  <option value="all" ${state.visibility === "all" ? "selected" : ""}>Visible to everyone</option>
                  <option value="creator" ${state.visibility === "creator" ? "selected" : ""}>Creator only</option>
                </select>
              </label>
              <label>Duration
                <select data-zone="duration-type">
                  ${!["custom-rounds", "1-minute", "10-minutes", "unlimited"].includes(state.duration.type)
                    ? `<option value="${esc(state.duration.type)}" selected>Unavailable duration: ${esc(state.duration.type)}</option>`
                    : ""}
                  <option value="custom-rounds" ${state.duration.type === "custom-rounds" ? "selected" : ""}>X rounds</option>
                  <option value="1-minute" ${state.duration.type === "1-minute" ? "selected" : ""}>1 minute</option>
                  <option value="10-minutes" ${state.duration.type === "10-minutes" ? "selected" : ""}>10 minutes</option>
                  <option value="unlimited" ${state.duration.type === "unlimited" ? "selected" : ""}>Unlimited</option>
                </select>
              </label>
              <label class="zb-duration-rounds">Rounds or dice formula
                <input data-zone="duration-rounds" type="text" inputmode="text" spellcheck="false" value="${esc(state.duration.rounds)}" placeholder="e.g. 6 or 2d4">
              </label>
              <fieldset class="zb-targeting" data-zone="targeting">
                <legend>Affects</legend>
                <div class="zb-check-grid">
                  <label class="zb-check"><input data-zone="affects-allies" type="checkbox" ${targetChoices.allies ? "checked" : ""}> Allies</label>
                  <label class="zb-check"><input data-zone="affects-enemies" type="checkbox" ${targetChoices.enemies ? "checked" : ""}> Enemies</label>
                  <label class="zb-check"><input data-zone="affects-self" type="checkbox" ${targetChoices.self ? "checked" : ""}> Self (Source Actor)</label>
                </div>
              </fieldset>
              <label>Line of effect
                <select data-zone="line-of-effect">
                  <option value="respect" ${state.targeting.lineOfEffect === "respect" ? "selected" : ""}>Respect line of effect</option>
                  <option value="ignore" ${state.targeting.lineOfEffect === "ignore" ? "selected" : ""}>Ignore line of effect</option>
                </select>
                <span class="notes">Closed physical walls block affected creatures.</span>
              </label>
            </div>
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
            <h3>Activation Choices</h3>
            <label class="zb-check"><input data-zone="damage-choice-enabled" type="checkbox" ${state.activationChoices?.damageType?.enabled ? "checked" : ""}> Choose one shared damage type (ex. Shadow Raid) when the zone activates</label>
            <div class="zb-activation-damage-choice">
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
            <button type="button" class="zb-preview" title="Only you will see the preview message"><i class="fa-solid fa-message"></i> Post Preview to Chat</button>
            <button type="button" class="zb-create"><i class="fa-solid fa-circle-plus"></i> Create Zone</button>
          </div>
        </div>
      </div>`;
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
      return `<li><b>${esc(block.name)}</b>: ${esc(triggerLabels(block).join(", "))}<br><span class="zb-preview-details">Save: ${saveText}; Damage: ${damageText}; Healing: ${healingText}; Chat Alert: ${alertText}; Immunity: ${esc(titleCase(block.immunity.duration))}</span></li>`;
    }).join("");

    return `
      <div class="pf2e-zone-preview">
        <h3>${esc(cfg.name)}</h3>
        <p><b>Source:</b> ${esc(sourceActor.name)} (${esc(sourceToken.name)})<br>
        <b>Zone:</b> ${esc(cfg.mode === "area" && cfg.areaShape === "square" ? `${cfg.sideLength}-foot square` : `${cfg.radius}-foot radius ${cfg.mode === "emanation" ? "emanation" : "circle"}`)}<br>
        <b>Targets:</b> ${esc(targetLabels(cfg.targeting).join(", "))}<br>
        <b>Traits:</b> ${cfg.traits.length ? cfg.traits.map(esc).join(", ") : "None"}<br>
        <b>Visibility:</b> ${cfg.visibility === "creator" ? "Creator only" : "Everyone"}<br>
        <b>Duration:</b> ${esc(durationText)}<br>
        <b>Shared activation damage type:</b> ${cfg.activationChoices?.damageType?.enabled ? cfg.activationChoices.damageType.options.map(titleCase).join(", ") : "None"}</p>
        <h4>Effect Blocks</h4>
        <ol>${blocks}</ol>
        ${validation.warnings.length ? `<p><b>Builder warnings:</b> ${validation.warnings.map(esc).join("; ")}</p>` : ""}
        <p class="zb-preview-note"><i>Preview only. Use Create Zone to create the Region and activate runtime automation.</i></p>
      </div>`;
  }

  return { renderRoot, renderConditionRow, previewHtml };
}

/** Shows shared presets using already-resolved requester permissions and literal record labels. */
export function renderSavedZones(records, { isGM, userId }) {
  const rows = records.map((record) => {
    const canDelete = isGM || record.createdBy?.userId === userId;
    return `<div class="pza-saved-row" data-record-id="${esc(record.id)}">
        <div>
          <b>${esc(presetLabel(record))}</b>
        </div>
        <button type="button" data-action="load"><i class="fa-solid fa-folder-open"></i> Load</button>
        ${canDelete ? `<button type="button" data-action="delete" class="danger"><i class="fa-solid fa-trash"></i> Delete</button>` : `<span></span>`}
      </div>`;
  }).join("");
  return `<div class="pza-saved-list">${rows}</div>`;
}

/** Renders the manager from display data while keeping permission checks and document operations in its controller. */
export function renderManagedZones(zones) {
  const rows = zones.map(({ id, name, config: cfg, createdByName, canMove, canEnd, cleanupPending, pendingRows }) => {
    const pendingMarkup = pendingRows.length
      ? `<div class="pza-pending-list"><b class="pza-pending-count">Pending saves (${pendingRows.length})</b>${pendingRows.map(({ pendingId, targetName, blockName, saveTypes, dc }) => `<div class="pza-pending-row" data-pending-id="${esc(pendingId)}">
            <span>${esc(targetName)} — ${esc(blockName)} · ${esc(saveTypes)} DC ${esc(dc)}</span>
            <button type="button" data-action="cancel-save" data-pending-id="${esc(pendingId)}">Cancel request</button>
          </div>`).join("")}</div>` : "";
    return `<div class="pza-zone-entry" data-region-id="${esc(id)}">
        <div class="pza-zone-row">
          <div><b>${esc(name)}</b><div class="pza-zone-meta">Created by ${esc(createdByName)} · ${esc(cfg.mode === "area" && cfg.areaShape === "square" ? `${cfg.sideLength}-foot square` : `${cfg.radius}-foot ${cfg.mode === "emanation" ? "emanation" : "circle"}`)} · ${esc(titleCase(cfg.duration?.type))}${cleanupPending ? " · Cleanup pending" : ""}</div></div>
          <div class="pza-zone-actions">
            ${canMove ? `<button type="button" data-action="move"><i class="fa-solid fa-arrows-up-down-left-right"></i> Move</button>` : ""}
            ${canEnd ? `<button type="button" data-action="end" class="danger"><i class="fa-solid fa-trash"></i> ${cleanupPending ? "Retry Dismiss" : "Dismiss"}</button>` : ""}
          </div>
        </div>
        ${pendingMarkup}
      </div>`;
  }).join("");
  return `<div class="pza-manage">${rows}</div>`;
}

/** Keeps exported JSON literal and portable while its presentation is controlled by the module stylesheet. */
export function renderJsonExport(json) {
  return `<div class="pza-zone-json-dialog">
      <p class="notes"><b>To copy:</b> click inside the JSON box, press <b>Ctrl+A</b> to select all, then press <b>Ctrl+C</b>. This JSON contains only the portable zone configuration and intentionally contains no source Actor or Token UUID.</p>
      <textarea class="zb-json" readonly>${esc(json)}</textarea></div>`;
}

/** Identifies the current source without letting pasted JSON supply source ownership or identity. */
export function renderJsonImport(sourceName) {
  return `<div class="pza-zone-json-dialog">
      <p>Paste a PF2e Zone Builder configuration below. The current selected source actor is <b>${esc(sourceName)}</b>; source information is never read from the JSON.</p>
      <textarea class="zb-json-import" name="json" placeholder="Paste JSON here"></textarea></div>`;
}

/** Formats explicit validation results without performing checks or mutating editor data. */
export function renderValidationDialog(result) {
  const errors = result.errors.map((message) => `<li>${esc(message)}</li>`).join("");
  const warnings = result.warnings.map((message) => `<li>${esc(message)}</li>`).join("");
  return `${result.errors.length ? `<h3>Errors</h3><ul>${errors}</ul>` : `<p><i class="fa-solid fa-circle-check"></i> No validation errors.</p>`}
      ${result.warnings.length ? `<h3>Warnings</h3><ul>${warnings}</ul>` : `<p><i class="fa-solid fa-circle-check"></i> No warnings.</p>`}`;
}

/** Presents the available shared damage types without choosing or storing an activation result. */
export function renderActivationDamageChoice(choices) {
  const options = choices.map((slug) => `<option value="${esc(slug)}">${esc(titleCase(slug))}</option>`).join("");
  return `<p>Choose the shared damage type for this zone activation.</p><label>Damage type<select name="damageType">${options}</select></label>`;
}

/** Keeps empty outcome placeholders consistent when rows are removed from a live editor. */
export function renderEmptyResults(label) {
  return `<div class="zb-empty">${esc(label)}</div>`;
}
