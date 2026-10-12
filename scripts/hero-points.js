import { escapeHtml as escapeHTML } from "./utils.js";
import { createHeroPointReminder, reminderTimestamp } from "./hero-point-reminders.js";

let heroPointsDialog = null;

/** Lists player-owned characters, including characters who have no token on the viewed Scene. */
function playerCharacters() {
  return [...(game.actors ?? [])]
    .filter((actor) => actor.type === "character" && actor.hasPlayerOwner)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads PF2e's Hero Point resource and respects characters whose maximum differs from three. */
function heroPointState(actor) {
  const resource = actor.system?.resources?.heroPoints;
  return {
    value: Number(resource?.value ?? 0),
    max: Math.min(3, Math.max(0, Number(resource?.max ?? 3)))
  };
}

/** Computes the same bounded total for previews and saved changes. */
function nextTotal(actor, amount, mode) {
  const { value, max } = heroPointState(actor);
  const total = mode === "set" ? amount : value + (mode === "remove" ? -amount : amount);
  return Math.min(max, Math.max(0, total));
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

/** Applies exact planned totals so retrying a partially failed operation never adds points twice. */
async function applyHeroPointChanges(plan, chatVisibility = "gm") {
  if (!game.user.isGM) throw new Error("Only a GM can change Hero Points.");
  if (!["gm", "public"].includes(chatVisibility)) throw new Error("Choose Public or GM Whisper for the chat results.");
  const changes = [];
  const failures = [];
  for (const { actor, total } of plan) {
    const before = heroPointState(actor).value;
    const after = nextTotal(actor, total, "set");
    if (before === after) continue;
    try {
      resolveCharacters(actor);
      await actor.update({ "system.resources.heroPoints.value": after });
      changes.push({ actorId: actor.id, name: actor.name, before, after });
    } catch (error) {
      failures.push(`${actor.name}: ${error?.message ?? error}`);
    }
  }
  if (changes.length) {
    try {
      await ChatMessage.create({
        content: `<p><strong>Hero Points updated</strong></p><ul>${changes.map(({ name, before, after }) =>
          `<li>${escapeHTML(name)}: ${before} → ${after}</li>`).join("")}</ul>`,
        user: game.user.id,
        whisper: chatVisibility === "public" ? [] : [...game.users].filter((user) => user.isGM).map((user) => user.id)
      });
    } catch (error) {
      console.error("PF2e Zone Hero Point announcement failed", error);
      ui.notifications.warn("Hero Points were updated, but the chat summary could not be posted.");
    }
  }
  if (failures.length) throw new Error(`Some Hero Points could not be updated. Retry to finish the same change. ${failures.join("; ")}`);
  return changes;
}

/** Updates PF2e's actual Hero Point totals, keeping the existing API's additive default. */
export async function setHeroPoints(amount, character, { mode = "add", chatVisibility = "gm" } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can change Hero Points.");
  if (!Number.isInteger(amount) || !["add", "remove", "set"].includes(mode)
      || (mode !== "add" && amount < 0)) {
    throw new Error("Enter a whole number of Hero Points and choose Add, Remove, or Set total.");
  }
  const actors = resolveCharacters(character);
  return applyHeroPointChanges(actors.map((actor) => ({ actor, total: nextTotal(actor, amount, mode) })), chatVisibility);
}

/** Presents one guided screen with explicit recipients and a preview of their resulting totals. */
export async function promptSetHeroPoints() {
  if (!game.user.isGM) {
    ui.notifications.error("Only a GM can change Hero Points.");
    return null;
  }
  const actors = playerCharacters();
  if (!actors.length) {
    ui.notifications.error("No player characters found. Assign a player as an owner of a character, then try again.");
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
    <p>Choose an action and check the characters to update. Review the totals, then apply.</p>
    <fieldset>
      <legend>1. Choose the change</legend>
      <div class="pza-hp-change">
        <label>Action
          <select name="hero-action">
            <option value="add">Add points</option>
            <option value="remove">Remove points</option>
            <option value="set">Set total</option>
          </select>
        </label>
        <label>Points
          <input type="number" name="hero-amount" value="1" min="1" max="3" step="1" required>
        </label>
      </div>
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
    <fieldset>
      <legend>3. Share results</legend>
      <label class="pza-hp-field">Chat results
        <select name="hero-chat">
          <option value="gm">GM Whisper</option>
          <option value="public">Public</option>
        </select>
      </label>
      <p class="pza-hp-help">Public shares the changes with everyone. GM Whisper shares them with GMs only.</p>
    </fieldset>
    <p class="pza-hp-summary" data-hp-summary aria-live="polite"></p>
    <fieldset>
      <legend>Award reminder</legend>
      <div class="pza-hp-reminder">
        <label class="pza-hp-field">Reminder time (local)
          <input type="time" name="hero-reminder-time" value="${defaultTime}" step="60">
        </label>
        <button type="button" data-hp-reminder>Create reminder</button>
      </div>
      <p class="pza-hp-help">Whisper only to you: it's time to award everyone 1 Hero Point. Uses the next occurrence of this time.</p>
      <p class="pza-hp-help">Keep Foundry open with a GM online. Missed reminders appear when a GM returns.</p>
      <p class="pza-hp-help" data-hp-reminder-status aria-live="polite"></p>
    </fieldset>
    </div>`;

  let applying = false;
  let reminderCreating = false;
  let pendingPlan = null;
  const dialog = new foundry.applications.api.DialogV2({
    window: { title: "Set Hero Points" },
    position: { width: 520 },
    content,
    form: { closeOnSubmit: false },
    buttons: [
      {
        action: "apply", label: "Add 1 Hero Point", default: true,
        callback: async (_event, button) => {
          if (applying || reminderCreating) return;
          const root = button.form.querySelector(".pza-hero-points");
          const amount = root.querySelector('[name="hero-amount"]').valueAsNumber;
          const mode = root.querySelector('[name="hero-action"]').value;
          const chatVisibility = root.querySelector('[name="hero-chat"]').value;
          const selected = [...root.querySelectorAll('[name="hero-character"]:checked')]
            .map((input) => actors.find((actor) => actor.id === input.value));
          if (!selected.length || !Number.isInteger(amount) || amount < (mode === "set" ? 0 : 1) || amount > 3) {
            ui.notifications.error("Select at least one character and enter a whole number from " + (mode === "set" ? "0" : "1") + " to 3.");
            return;
          }
          applying = true;
          pendingPlan ??= selected.map((actor) => ({ actor, total: nextTotal(actor, amount, mode) }));
          refreshPreview();
          try {
            const changes = await applyHeroPointChanges(pendingPlan, chatVisibility);
            await dialog.close();
            return changes;
          } catch (error) {
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
    const input = root.querySelector('[name="hero-amount"]');
    const amount = input.valueAsNumber;
    const mode = root.querySelector('[name="hero-action"]').value;
    input.min = mode === "set" ? "0" : "1";
    const valid = Number.isInteger(amount) && amount >= Number(input.min) && amount <= 3;
    root.querySelector("[data-hp-help]").textContent = {
      add: "Add this many Hero Points to each selected character. Totals cannot exceed 3.",
      remove: "Remove this many Hero Points from each selected character. Totals cannot fall below 0.",
      set: "Set each selected character to this exact total, between 0 and 3."
    }[mode];
    let count = 0;
    let changed = 0;
    for (const row of root.querySelectorAll("[data-hp-actor]")) {
      const actor = actors.find((entry) => entry.id === row.dataset.hpActor);
      const checked = row.querySelector("input").checked;
      const current = heroPointState(actor).value;
      const planned = pendingPlan?.find((entry) => entry.actor === actor);
      const after = planned ? planned.total : checked && valid ? nextTotal(actor, amount, mode) : current;
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
      : !valid ? `Enter a whole number from ${input.min} to 3.`
      : !changed ? "The selected characters already have these totals."
      : `${count} ${count === 1 ? "character" : "characters"} selected. Review the After column before applying.`;
    const apply = dialog.element.querySelector('button[data-action="apply"]');
    if (apply) {
      apply.disabled = applying || reminderCreating || !count || !valid || (!changed && !pendingPlan);
      const label = valid ? `${mode === "set" ? "Set to" : mode === "remove" ? "Remove" : "Add"} ${amount} Hero ${amount === 1 ? "Point" : "Points"}` : "Apply change";
      const labelElement = apply.querySelector(".button-label");
      (labelElement ?? apply).textContent = applying ? "Updating…" : pendingPlan ? "Retry update" : label;
    }
    for (const inputElement of root.querySelectorAll("input, select, button")) inputElement.disabled = applying || reminderCreating;
    const reminderButton = root.querySelector("[data-hp-reminder]");
    try {
      reminderTimestamp(root.querySelector('[name="hero-reminder-time"]').value);
    } catch {
      reminderButton.disabled = true;
    }
    reminderButton.textContent = reminderCreating ? "Creating…" : "Create reminder";
    const cancel = dialog.element.querySelector('button[data-action="cancel"]');
    if (cancel) cancel.disabled = applying || reminderCreating;
  }

  /** Creates a reminder independently of the selected characters or chat-summary audience. */
  async function createReminder() {
    if (applying || reminderCreating) return;
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

  dialog.addEventListener("render", () => {
    const root = dialog.element.querySelector(".pza-hero-points");
    /** Starts a new operation when the GM deliberately changes its amount, action, or recipients. */
    const editSelection = (event) => {
      if (!event || ["hero-amount", "hero-action", "hero-character"].includes(event.target.name)) pendingPlan = null;
      refreshPreview();
    };
    root.addEventListener("input", editSelection);
    root.addEventListener("change", editSelection);
    root.querySelector("[data-hp-reminder]").addEventListener("click", createReminder);
    for (const button of root.querySelectorAll("[data-hp-select]")) {
      button.addEventListener("click", () => {
        for (const input of root.querySelectorAll('[name="hero-character"]')) input.checked = button.dataset.hpSelect === "all";
        editSelection();
      });
    }
    refreshPreview();
  }, { once: true });
  dialog.addEventListener("close", () => {
    if (heroPointsDialog === dialog) heroPointsDialog = null;
  }, { once: true });
  heroPointsDialog = dialog;
  await dialog.render({ force: true });
  return dialog;
}
