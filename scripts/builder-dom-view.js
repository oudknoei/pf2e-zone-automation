import { BASIC_MULTIPLIERS } from "./zone-config.js";
import { zoneTypeFields } from "./area-shape.js";
import { field } from "./builder-form.js";

/** Hides the native Close footer only in the editor, which already supplies its own sticky actions. */
export function hideBuilderNativeFooter(dialog) {
  const dialogElement = dialog.element ?? dialog.window?.element ?? null;
  const nativeFooter =
    dialogElement?.querySelector?.("footer.form-footer, .form-footer") ??
    dialog.form?.querySelector?.("footer.form-footer, .form-footer") ??
    null;
  if (nativeFooter) nativeFooter.style.display = "none";
}

/** Displays readiness and disables actions using the controller's validated state and retained save attempt. */
export function renderBuilderReadiness(root, { validation, pendingCount, pendingMutation, creationCompleted, loadedPreset, canOverwrite, saveAttempt }) {
  const status = root.querySelector("[data-validation-status]");
  const statusContainer = root.querySelector("[data-validation-status-container]");
  const icon = root.querySelector("[data-validation-status-icon]");
  const create = root.querySelector(".zb-create");
  const errorCount = validation.errors.length;
  const warningCount = validation.warnings.length;

  if (status && statusContainer && icon) {
    statusContainer.classList.toggle("is-ready", errorCount === 0 && pendingCount === 0);
    statusContainer.classList.toggle("has-errors", errorCount > 0);
    icon.className = "fa-solid " + (errorCount ? "fa-triangle-exclamation" : pendingCount ? "fa-spinner fa-spin" : "fa-circle-check");
    status.textContent = errorCount
      ? "Fix " + errorCount + " field" + (errorCount === 1 ? "" : "s") + " to create"
      : pendingCount ? "Checking Effect Items…"
      : "Ready to create" + (warningCount ? " · " + warningCount + " warning" + (warningCount === 1 ? "" : "s") : "");
  }
  if (create) create.disabled = errorCount > 0 || pendingCount > 0 || Boolean(pendingMutation) || creationCompleted;
  const save = root.querySelector(".zb-save");
  if (save) save.disabled = Boolean(pendingMutation) || (saveAttempt?.uncertain
    ? saveAttempt.asNew : Boolean(loadedPreset && !canOverwrite));
  const saveAs = root.querySelector(".zb-save-as");
  if (saveAs) saveAs.disabled = Boolean(pendingMutation) || Boolean(saveAttempt?.uncertain && !saveAttempt.asNew);
}

/** Displays the current source and GM-availability status without querying game or transport state. */
export function renderOperationStatus(root, operation) {
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
}

/** Hides unsupported condition inputs so stale controls cannot mislead the user. */
export function refreshConditionRow(row) {
  if (!row) return;
  const removal = row.querySelector('[data-field="condition-removal"]')?.value ?? "normal";
  const link = row.querySelector(".zb-condition-link");
  if (link) link.style.display = removal === "condition-end" ? "flex" : "none";
}

/** Finds the most useful UI element for each validation problem instead of showing only a global list. */
export function validationTarget(root, issue) {
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
  if (target.field === "immunity-group") return block.querySelector(".zb-immunity-group");
  if (target.field === "condition-link" || target.field === "condition-slug") {
    const rows = [...block.querySelectorAll(`[data-outcome="${target.outcomeKey}"] .zb-condition-row`)];
    return rows[target.conditionIndex]?.querySelector(`[data-field="${target.field}"]`) ?? null;
  }
  if (target.field === "effect-uuid") {
    const rows = [...block.querySelectorAll(`[data-outcome="${target.outcomeKey}"] .zb-effect-row`)];
    return rows[target.effectIndex]?.querySelector('[data-field="effect-uuid"]') ?? null;
  }
  return block.querySelector(`[data-field="${target.field}"]`);
}

/** Places inline feedback beside the control users need to change. */
export function validationErrorHost(target) {
  if (!target) return null;
  if (target.matches("fieldset, .zb-trait-use-options, .zb-chat-alert-options, .zb-save-choice-options, .zb-immunity-starts, .zb-activation-damage-choice, .zb-source, .zb-block-list, .zb-condition-row, .zb-effect-row")) return target;
  return target.closest("label") ?? target.closest(".zb-subrow") ?? target;
}

/** Removes stale warnings before rendering the current configuration state. */
export function clearInlineValidation(root) {
  for (const message of root.querySelectorAll(".zb-field-error")) message.remove();
  for (const element of root.querySelectorAll(".zb-invalid")) {
    element.classList.remove("zb-invalid");
    element.removeAttribute("aria-invalid");
  }
}

/** Makes blocking errors visible where they occur so users do not have to interpret a summary list. */
export function renderInlineValidation(root, validation) {
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

/** Gives a dragged or pasted UUID a recognizable label without adding display data to the saved config. */
export function showEffectDetails(row, entry) {
  const info = row?.querySelector(".zb-effect-info");
  if (!info) return;
  info.replaceChildren();
  const result = entry?.result;
  if (!entry) {
    info.textContent = "Drop a PF2e Effect Item here or paste its UUID.";
  } else if (entry.status === "pending") {
    info.textContent = "Looking up Effect Item…";
  } else if (result.error) {
    info.textContent = result.error;
  } else {
    if (result.img) {
      const image = document.createElement("img");
      image.src = result.img;
      image.alt = "";
      info.append(image);
    }
    const name = document.createElement("span");
    name.textContent = result.name;
    info.append(name);
  }
  if (entry?.status === "done") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "zb-small zb-retry-effect";
    retry.textContent = result.error ? "Retry lookup" : "Refresh details";
    info.append(retry);
  }
}

/** Hides controls that cannot affect the current configuration so the editor stays approachable. */
export function refreshVisibility(root) {
  const { mode, areaShape } = zoneTypeFields(field(root, '[data-zone="mode"]').value);
  field(root, ".zb-area-radius").style.display = mode !== "area" || areaShape === "circle" ? "flex" : "none";
  field(root, ".zb-area-side-length").style.display = mode === "area" && areaShape === "square" ? "flex" : "none";
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
    const immunityScope = blockEl.querySelector('[data-field="immunity-scope"]').value;
    const recoveryChecked = Boolean(blockEl.querySelector('[data-immunity-start="condition-recovery"]:checked'));
    const traitUseEnabled = blockEl.querySelector('[data-trigger="traitUse"]').checked;
    const hpThresholdEnabled = blockEl.querySelector('[data-trigger="hpThreshold"]').checked;
    const chatAlertEnabled = blockEl.querySelector('[data-field="chat-alert-enabled"]').checked;

    blockEl.querySelector(".zb-trait-use-options").style.display = traitUseEnabled ? "block" : "none";
    blockEl.querySelector(".zb-hp-threshold-options").style.display = hpThresholdEnabled ? "block" : "none";
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
    const sharedImmunityVisible = immunityDuration !== "none" && immunityScope === "shared-group";
    blockEl.querySelector(".zb-immunity-group").style.display = sharedImmunityVisible ? "flex" : "none";
    blockEl.querySelector(".zb-immunity-group-note").style.display = sharedImmunityVisible ? "block" : "none";

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
