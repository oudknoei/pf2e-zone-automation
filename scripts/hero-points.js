import { escapeHtml as escapeHTML } from "./utils.js";
import { clearHeroPointReminders, createHeroPointReminder, hasHeroPointReminders, reminderTimestamp } from "./hero-point-reminders.js";
import { canManageHeroPoints, heroPointState, nextHeroPointTotal as nextTotal, validateHeroPointChange } from "./hero-points-rules.js";
import { requestGMWorker } from "./transport.js";
import { newOperationId } from "./utils.js";

let heroPointsDialog = null;
const HERO_POINT_CHOICES = [
  { value: "give-1", label: "Give 1 hero point", mode: "add", amount: 1 },
  { value: "spend-1", label: "Spend 1 hero point", mode: "remove", amount: 1 },
  { value: "set-0", label: "Set hero points to 0", mode: "set", amount: 0 },
  { value: "set-1", label: "Set hero points to 1", mode: "set", amount: 1 },
  { value: "set-2", label: "Set hero points to 2", mode: "set", amount: 2 },
  { value: "set-3", label: "Set hero points to 3", mode: "set", amount: 3 }
];

/** Lists only characters the current user can manage, including owned characters without a token on this Scene. */
function playerCharacters() {
  return [...(game.actors ?? [])]
    .filter((actor) => canManageHeroPoints(actor, game.user))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves legacy token selections or names without falling back to an unrelated character. */
function resolveCharacters(character) {
  const characters = playerCharacters();
  let candidates;
  if (character === "selected" || character === "target") {
    const tokens = character === "selected" ? (globalThis.canvas?.tokens?.controlled ?? []) : [...(game.user.targets ?? [])];
    candidates = tokens.map((token) => token.actor).filter(Boolean);
  } else if (typeof character === "string") {
    const byId = characters.find((actor) => actor.id === character);
    candidates = byId ? [byId] : characters.filter((actor) => actor.name === character);
    if (candidates.length > 1) throw new Error("More than one character has that name. Choose them in the Hero Points dialog.");
  } else {
    candidates = Array.isArray(character) ? character : [character];
  }
  const actors = [...new Set(candidates.filter(Boolean))];
  if (!actors.length || actors.some((actor) => !characters.includes(actor))) {
    throw new Error("Choose at least one player character to update.");
  }
  return actors;
}

/** Sends immutable operation details to the active GM and preserves identity and plan information on failure. */
async function requestHeroPointChanges(request) {
  try {
    const response = await requestGMWorker({ protocol: 1, action: "set-hero-points", requesterUserId: game.user.id, ...request });
    for (const warning of response?.warnings ?? []) ui.notifications.warn(warning);
    if (!response?.ok) {
      const error = new Error(response?.error ?? "Hero Points could not be updated.");
      error.code = response?.errorCode;
      error.retryable = Boolean(response?.retryable);
      error.plan = response?.plan;
      throw error;
    }
    return response.changes;
  } catch (error) {
    error.operationId = request.operationId;
    if (error.code === "PF2E_ZONE_REQUEST_TIMEOUT") error.retryable = true;
    throw error;
  }
}

/** Updates PF2e's actual Hero Point totals, keeping the existing API's additive default. */
export async function setHeroPoints(amount, character, { mode = "add", operationId = newOperationId(), retry = false } = {}) {
  validateHeroPointChange(amount, mode);
  const actors = resolveCharacters(character);
  return requestHeroPointChanges({ actorIds: actors.map((actor) => actor.id), amount, mode, operationId, retry });
}

/** Presents one guided screen with explicit recipients and a preview of their resulting totals. */
export async function promptSetHeroPoints() {
  const actors = playerCharacters();
  if (!actors.length) {
    ui.notifications.error(game.user.isGM
      ? "No player characters found. Assign a player as an owner of a character, then try again."
      : "No characters you own found. Ask your GM to assign you as an owner of a character.");
    return null;
  }
  if (heroPointsDialog?.rendered) {
    heroPointsDialog.bringToFront();
    return heroPointsDialog;
  }
  const selectedActors = new Set((globalThis.canvas?.tokens?.controlled ?? []).map((token) => token.actor?.id));
  const defaultReminder = new Date(Date.now() + 60 * 60 * 1000);
  const defaultTime = `${String(defaultReminder.getHours()).padStart(2, "0")}:${String(defaultReminder.getMinutes()).padStart(2, "0")}`;
  // DialogV2 requires an attribute-free outer div and renders only its inner HTML.
  const content = document.createElement("div");
  content.innerHTML = `
    <div class="pza-hero-points">
    <div class="pza-hp-main">
    <p>Choose a change and check the characters to update. Review the totals, then apply.</p>
    <fieldset>
      <legend>1. Choose the change</legend>
      <label class="pza-hp-field">Hero points
        <select name="hero-change">
          ${HERO_POINT_CHOICES.map(({ value, label }) => `<option value="${value}">${label}</option>`).join("")}
        </select>
      </label>
      <p class="pza-hp-help" data-hp-help></p>
    </fieldset>
    <fieldset>
      <legend>2. Choose characters</legend>
      <div class="pza-hp-selection">
        <button type="button" data-hp-select="all">Select all</button>
        <button type="button" data-hp-select="none">Clear</button>
      </div>
      <div class="pza-hp-heading"><span>Character</span><span>Current</span><span>After</span></div>
      <div class="pza-hp-characters">
        ${actors.map((actor) => `<label class="pza-hp-row" data-hp-actor="${escapeHTML(actor.id)}">
          <span class="pza-hp-name"><input type="checkbox" name="hero-character" value="${escapeHTML(actor.id)}" ${selectedActors.has(actor.id) ? "checked" : ""}>
            <span>${escapeHTML(actor.name)}</span></span>
          <span data-hp-current></span><strong data-hp-after></strong>
        </label>`).join("")}
      </div>
      <p class="pza-hp-help">Characters with selected tokens are checked automatically.</p>
    </fieldset>
    </div>
    <p class="pza-hp-summary" data-hp-summary aria-live="polite"></p>
    <div class="pza-hp-actions"></div>
    <fieldset class="pza-hp-reminder-section">
      <legend>Award reminder</legend>
      <div class="pza-hp-reminder">
        <label class="pza-hp-field">Reminder time (local)
          <input type="time" name="hero-reminder-time" value="${defaultTime}" step="60">
        </label>
        <button type="button" data-hp-reminder>Create reminder</button>
        <button type="button" data-hp-clear-reminders hidden>Clear Reminders</button>
      </div>
      <p class="pza-hp-help">Whisper only to you: it's time to award ${game.user.isGM ? "everyone" : "your characters"} 1 Hero Point. Uses the next occurrence of this time.</p>
      <p class="pza-hp-help">Keep Foundry open with a GM online. Missed reminders appear when a GM returns.</p>
      <p class="pza-hp-help" data-hp-reminder-status aria-live="polite"></p>
    </fieldset>
    </div>`;

  let applying = false;
  let reminderCreating = false;
  let reminderClearing = false;
  let reminderHook = null;
  const actorHooks = [];
  let pendingPlan = null;
  let pendingRequest = null;
  const dialog = new foundry.applications.api.DialogV2({
    window: { title: "Set Hero Points" },
    position: { width: 520 },
    content,
    form: { closeOnSubmit: false },
    buttons: [
      {
        action: "apply", label: HERO_POINT_CHOICES[0].label, default: true,
        callback: async (_event, button) => {
          if (applying || reminderCreating || reminderClearing) return;
          const root = button.form.querySelector(".pza-hero-points");
          const choice = HERO_POINT_CHOICES.find((entry) => entry.value === root.querySelector('[name="hero-change"]').value);
          const selected = [...root.querySelectorAll('[name="hero-character"]:checked')]
            .map((input) => actors.find((actor) => actor.id === input.value));
          if (selected.some(actor => !canManageHeroPoints(actor, game.user))) {
            pendingPlan = pendingRequest = null;
            refreshPreview();
            ui.notifications.error("You can only change Hero Points for characters you own.");
            return;
          }
          if (!selected.length || !choice) {
            ui.notifications.error("Select at least one character and choose a Hero Point change.");
            return;
          }
          applying = true;
          pendingPlan ??= selected.map((actor) => ({ actor, total: nextTotal(actor, choice.amount, choice.mode) }));
          pendingRequest ??= { actorIds: selected.map((actor) => actor.id), amount: choice.amount,
            mode: choice.mode, operationId: newOperationId(), retry: false };
          const request = { ...pendingRequest };
          pendingRequest.retry = true;
          refreshPreview();
          try {
            const changes = await requestHeroPointChanges(request);
            await dialog.close();
            return changes;
          } catch (error) {
            if (error.plan) pendingPlan = error.plan.map(({ actorId, total }) => {
              const actor = actors.find((entry) => entry.id === actorId);
              return { actor, total: total ?? heroPointState(actor).value };
            });
            if (!error.retryable) pendingPlan = pendingRequest = null;
            console.error("PF2e Zone Hero Point update failed", error);
            ui.notifications.error(error?.message ?? "Hero Points could not be updated. Try again.");
          } finally {
            applying = false;
            if (dialog.rendered) refreshPreview();
          }
        }
      },
      { action: "cancel", label: "Cancel", callback: () => dialog.close() }
    ]
  });

  /** Keeps the operation label, recipient count, and before/after totals in sync with the form. */
  function refreshPreview() {
    const root = dialog.element.querySelector(".pza-hero-points");
    const choice = HERO_POINT_CHOICES.find((entry) => entry.value === root.querySelector('[name="hero-change"]').value);
    const valid = Boolean(choice);
    root.querySelector("[data-hp-help]").textContent = !choice ? "Choose a Hero Point change."
      : choice.mode === "add" ? "Give 1 Hero Point to each selected character. Totals cannot exceed 3."
      : choice.mode === "remove" ? "Spend 1 Hero Point for each selected character. Totals cannot fall below 0."
      : `Set each selected character to exactly ${choice.amount} Hero ${choice.amount === 1 ? "Point" : "Points"}.`;
    let count = 0;
    let changed = 0;
    for (const row of root.querySelectorAll("[data-hp-actor]")) {
      const actor = actors.find((entry) => entry.id === row.dataset.hpActor);
      if (game.actors.get(actor?.id) !== actor || !canManageHeroPoints(actor, game.user)) {
        row.remove();
        continue;
      }
      const checked = row.querySelector("input").checked;
      const current = heroPointState(actor).value;
      const planned = pendingPlan?.find((entry) => entry.actor === actor);
      const after = planned ? planned.total : checked && valid ? nextTotal(actor, choice.amount, choice.mode) : current;
      row.querySelector("[data-hp-current]").textContent = current;
      row.querySelector("[data-hp-after]").textContent = valid ? after : "—";
      row.classList.toggle("is-selected", checked);
      if (checked) count += 1;
      if (checked && current !== after) changed += 1;
    }
    const summary = root.querySelector("[data-hp-summary]");
    summary.textContent = applying ? "Updating Hero Points…"
      : pendingPlan ? "Some updates failed. Use Retry update to finish the totals shown in the After column."
      : !count ? "Select at least one character."
      : !valid ? "Choose a Hero Point change."
      : !changed ? "The selected characters already have these totals."
      : `${count} ${count === 1 ? "character" : "characters"} selected. Review the After column before applying.`;
    summary.classList.toggle("is-validation", !applying && !pendingPlan && (!count || !valid));
    const busy = applying || reminderCreating || reminderClearing;
    for (const inputElement of root.querySelectorAll("input, select, button")) inputElement.disabled = busy;
    const apply = dialog.element.querySelector('button[data-action="apply"]');
    if (apply) {
      apply.disabled = busy || !count || !valid || (!changed && !pendingPlan);
      const label = choice?.label ?? "Apply change";
      const labelElement = apply.querySelector(".button-label");
      (labelElement ?? apply).textContent = applying ? "Updating…" : pendingPlan ? "Retry update" : label;
    }
    const reminderButton = root.querySelector("[data-hp-reminder]");
    try {
      reminderTimestamp(root.querySelector('[name="hero-reminder-time"]').value);
    } catch {
      reminderButton.disabled = true;
    }
    reminderButton.textContent = reminderCreating ? "Creating…" : "Create reminder";
    const clearButton = root.querySelector("[data-hp-clear-reminders]");
    clearButton.hidden = !hasHeroPointReminders();
    clearButton.textContent = reminderClearing ? "Clearing…" : "Clear Reminders";
    const cancel = dialog.element.querySelector('button[data-action="cancel"]');
    if (cancel) cancel.disabled = busy;
  }

  /** Creates a private reminder independently of the selected characters. */
  async function createReminder() {
    if (applying || reminderCreating || reminderClearing) return;
    const root = dialog.element.querySelector(".pza-hero-points");
    const status = root.querySelector("[data-hp-reminder-status]");
    reminderCreating = true;
    status.textContent = "Saving reminder…";
    refreshPreview();
    try {
      const reminder = await createHeroPointReminder(root.querySelector('[name="hero-reminder-time"]').value);
      status.textContent = `Private reminder set for ${new Date(reminder.remindAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
    } catch (error) {
      status.textContent = error?.message ?? "The reminder could not be saved. Try again.";
      ui.notifications.error(status.textContent);
    } finally {
      reminderCreating = false;
      if (dialog.rendered) refreshPreview();
    }
  }

  /** Clears the current user's pending reminders without applying points or closing the dialog. */
  async function clearReminders() {
    if (applying || reminderCreating || reminderClearing) return;
    const root = dialog.element.querySelector(".pza-hero-points");
    const status = root.querySelector("[data-hp-reminder-status]");
    reminderClearing = true;
    status.textContent = "Clearing reminders…";
    refreshPreview();
    try {
      const count = await clearHeroPointReminders();
      status.textContent = count ? "All your Hero Point reminders cleared." : "No pending Hero Point reminders.";
    } catch (error) {
      status.textContent = error?.message ?? "The reminders could not be cleared. Try again.";
      ui.notifications.error(status.textContent);
    } finally {
      reminderClearing = false;
      if (dialog.rendered) refreshPreview();
    }
  }

  dialog.addEventListener("render", () => {
    const root = dialog.element.querySelector(".pza-hero-points");
    // Relocate Foundry's original buttons, retaining their form and event handlers.
    const buttons = [...dialog.element.querySelectorAll('button[data-action="apply"], button[data-action="cancel"]')];
    const footer = buttons[0]?.closest(".form-footer, .dialog-buttons, footer");
    root.querySelector(".pza-hp-actions").append(...(footer ? [footer] : buttons));
    /** Starts a new operation when the user deliberately changes the choice or recipients. */
    const editSelection = (event) => {
      if (!event || ["hero-change", "hero-character"].includes(event.target.name)) pendingPlan = pendingRequest = null;
      refreshPreview();
    };
    root.addEventListener("input", editSelection);
    root.addEventListener("change", editSelection);
    root.querySelector("[data-hp-reminder]").addEventListener("click", createReminder);
    root.querySelector("[data-hp-clear-reminders]").addEventListener("click", clearReminders);
    reminderHook = Hooks.on("updateUser", (user) => {
      if (user.id === game.user.id && dialog.rendered) refreshPreview();
    });
    for (const hook of ["updateActor", "deleteActor"]) {
      actorHooks.push([hook, Hooks.on(hook, () => { if (dialog.rendered) refreshPreview(); })]);
    }
    for (const button of root.querySelectorAll("[data-hp-select]")) {
      button.addEventListener("click", () => {
        for (const input of root.querySelectorAll('[name="hero-character"]')) input.checked = button.dataset.hpSelect === "all";
        editSelection();
      });
    }
    refreshPreview();
  }, { once: true });
  dialog.addEventListener("close", () => {
    if (reminderHook !== null) Hooks.off("updateUser", reminderHook);
    for (const [hook, id] of actorHooks) Hooks.off(hook, id);
    if (heroPointsDialog === dialog) heroPointsDialog = null;
  }, { once: true });
  heroPointsDialog = dialog;
  await dialog.render({ force: true });
  return dialog;
}
