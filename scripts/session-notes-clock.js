import { escapeHtml as esc, newOperationId } from "./utils.js";
import { requestGMWorker } from "./transport.js";
import {
  SESSION_MODULE,
  SESSION_ENABLED_HOOK,
  requireSessionNotes,
  sessionNotesEnabled,
  sessionData,
  sessionJournals
} from "./session-notes-data.js";
import {
  CLOCK_CHANGED_HOOK,
  CLOCK_ACTIVITIES,
  sessionClockState,
  currentCampaign,
  campaignLabel,
  previewAdvance,
  campaignTime,
  durationLabel
} from "./session-clock-data.js";

let clockDialog = null;
let openingClock = null;

/** Uses the same authenticated, serialized worker as manual session notes. */
async function sendClockRequest(details) {
  requireSessionNotes();

  const response = await requestGMWorker({
    protocol: 1,
    action: "session-notes",
    requesterUserId: game.user.id,
    operationId: newOperationId(),
    ...details
  });

  if (!response?.ok) throw new Error(response?.error ?? "The campaign clock could not be saved.");

  return response;
}

/** Limits automatic world-clock recording to the elected GM while the feature is enabled. */
function recorderAvailable() {
  return game.user?.isGM && game.users.activeGM?.id === game.user.id && sessionNotesEnabled();
}

/** Installs observation-only hooks; combat and other integrations remain responsible for advancing their clock. */
export function registerSessionClockHooks() {
  /** Recovers pending saved records and marks unobserved time as a reviewable gap. */
  function recover() {
    if (!recorderAvailable()) return;

    void sendClockRequest({ command: "clock-sync" }).catch(error => ui.notifications.warn(`Campaign clock needs review: ${error.message}`));
  }

  const hooks = [
    ["updateWorldTime", Hooks.on("updateWorldTime", (worldTime, delta, options = {}, userId) => {
      if (!recorderAvailable()) return;

      void sendClockRequest({
        command: "observe-clock",
        worldTime,
        delta,
        sourceUserId: userId,
        provenance: options.pf2eZoneSessionClock
      }).catch(error => ui.notifications.warn(`Clock change is not confirmed in the Journal: ${error.message}`));
    })],
    ["updateUser", Hooks.on("updateUser", recover)],
    [SESSION_ENABLED_HOOK, Hooks.on(SESSION_ENABLED_HOOK, recover)]
  ];

  recover();

  return () => {
    for (const [name, id] of hooks) Hooks.off(name, id);
  };
}

/** Builds a compact activity form with a separate explicit resolution for uncertain advances. */
function clockHtml(mode, journalId) {
  const state = sessionClockState(), current = currentCampaign() ?? { day: 1, time: "09:00" };
  const active = sessionJournals().find(journal => sessionData(journal).state !== "ended");
  const party = sessionData(active)?.party ?? [];
  const actors = [...(game.actors?.contents ?? [])].filter(actor => actor.type === "character");
  const pages = journalId ? [...(game.journal.get(journalId)?.pages ?? [])].filter(page => page.getFlag(SESSION_MODULE, "sessionNotes")?.role === "event") : [];

  return `<div class="pza-session-notes pza-clock-dialog">
    <p><strong data-clock-current>${esc(campaignLabel(currentCampaign()))}</strong></p>
    <p data-clock-record-status class="pza-session-muted"></p>
    <div data-clock-form>
      <label class="pza-session-form-row"><span>Action</span><select name="clock-mode">
        ${[["blocks", "10-minute blocks"], ["60", "1 minute"], ["3600", "1 hour"], ["28800", "8 hours"],
    ["custom", "Custom duration"], ["until", "Advance Until"], ["set", "Set Day/Time"], ...(journalId ? [["event", "Correct event time"]] : [])].map(([value, label]) =>
    `<option value="${value}" ${value === mode ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label class="pza-session-form-row" data-clock-modes="blocks"><span>10-minute blocks</span><input name="blocks" type="number" min="1" step="1" value="1"></label>
      <div class="pza-clock-custom" data-clock-modes="custom"><label>Duration <input name="custom-duration" type="number" min="0" step="any" value="10"></label>
        <select name="custom-unit" aria-label="Duration unit"><option value="1">seconds</option><option value="60" selected>minutes</option><option value="3600">hours</option><option value="86400">days</option></select></div>
      <label class="pza-session-form-row" data-clock-modes="event"><span>Event</span><select name="event-page">${pages.map(page => `<option value="${esc(page.id)}">${esc(page.name)}</option>`).join("")}</select></label>
      <div data-clock-modes="until set event"><label class="pza-session-form-row"><span>Day</span><input name="day" type="number" min="0" step="1" value="${current.day}"></label>
        <label class="pza-session-form-row"><span>Time of day</span><input name="time" type="time" value="${esc(current.time)}"></label></div>
      <div data-clock-activity><label class="pza-session-form-row"><span>Activity</span><select name="activity">${CLOCK_ACTIVITIES.map(activity =>
    `<option ${activity === state?.lastActivity ? "selected" : ""}>${activity}</option>`).join("")}</select></label>
        <label>Details <textarea name="explanation" rows="3" maxlength="5000" placeholder="Searching the mill while others heal"></textarea></label>
        <p class="pza-session-muted">Simultaneous tasks share this interval. Choose the elapsed time once for everyone.</p>
        ${actors.length
      ? `<details><summary>Participants</summary><div class="pza-session-party">${actors.map(actor =>
    `<label><input name="participant" type="checkbox" value="${esc(actor.id)}" ${party.some(member => member.id === actor.id) ? "checked" : ""}> ${esc(actor.name)}</label>`).join("")}</div></details>`
      : ""}</div>
      <label data-clock-modes="set event">Reason <textarea name="reason" rows="3" maxlength="5000" placeholder="Explain the correction"></textarea></label>
      <output data-clock-preview aria-live="polite"></output>
    </div>
    <div data-clock-reconcile hidden><p data-clock-pending></p>
      <label class="pza-session-form-row"><span>Resolution</span><select name="resolution"><option value="">Choose after checking the clock</option><option value="applied">The advance was applied</option><option value="not-applied">The advance was not applied</option></select></label>
      <label>Explanation <textarea name="resolution-reason" rows="3" maxlength="5000"></textarea></label>
      <p class="pza-session-muted">Confirmation records your decision and never advances the clock. An unapplied advance can then be entered again.</p>
    </div><p data-clock-status role="status"></p></div>`;
}

/** Reads one shared interval from the form without summing individual character activities. */
function intervalRequest(root) {
  const mode = root.querySelector("[name=clock-mode]").value;
  let seconds;

  if (mode === "blocks") {
    const count = Number(root.querySelector("[name=blocks]").value);

    if (!Number.isSafeInteger(count) || count < 1)
      throw new Error("Enter a positive whole number of ten-minute blocks.");

    seconds = count * 600;
  } else if (mode === "custom")
    seconds = Number(root.querySelector("[name=custom-duration]").value) * Number(root.querySelector("[name=custom-unit]").value);
  else seconds = Number(mode);

  return {
    mode,
    seconds,
    day: root.querySelector("[name=day]").value,
    time: root.querySelector("[name=time]").value,
    activity: root.querySelector("[name=activity]").value,
    explanation: root.querySelector("[name=explanation]").value,
    participantIds: [...root.querySelectorAll("[name=participant]:checked")].map(input => input.value)
  };
}

/** Opens one clock window and requires a fresh preview or an explicit reconciliation before a world-time write. */
export async function promptAdvanceSessionTime(options = {}) {
  requireSessionNotes();

  if (clockDialog) {
    clockDialog.bringToFront();

    return clockDialog;
  }
  if (openingClock) return openingClock;

  openingClock = openClockDialog(options);

  try {
    return await openingClock;
  } finally {
    openingClock = null;
  }
}

/** Builds the first window after clock recovery while concurrent macro/chat requests share its promise. */
async function openClockDialog({ mode, journalId } = {}) {
  requireSessionNotes();

  if (clockDialog) {
    clockDialog.bringToFront();

    return clockDialog;
  }

  try {
    await sendClockRequest({ command: "clock-sync" });
  } catch (error) {
    ui.notifications.warn(error.message);
  }

  requireSessionNotes();
  mode ??= sessionClockState() ? "blocks" : "set";

  let pendingRequest = null, busy = false, preview = null;
  const wrapper = document.createElement("div");

  wrapper.innerHTML = clockHtml(mode, journalId);

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: mode === "set" ? "Set Day/Time" : mode === "event" ? "Correct Event Time" : "Advance Time" },
    position: { width: 570 },
    content: wrapper,
    form: { closeOnSubmit: false },
    buttons: [
      {
        action: "save",
        label: mode === "set" ? "Save" : "Advance Time",
        callback: async () => {
          if (busy) return;

          const root = dialog.element;

          try {
            requireSessionNotes();

            const state = sessionClockState();

            if (state?.events.length || state?.pending?.status === "applied")
              pendingRequest = { command: "clock-sync" };
            else if (state?.pending) {
              const resolution = root.querySelector("[name=resolution]").value, reason = root.querySelector("[name=resolution-reason]").value.trim();

              if (!resolution || !reason) throw new Error("Choose a resolution and explain what you verified.");

              pendingRequest = {
                command: "reconcile-clock",
                pendingId: state.pending.id,
                resolution,
                reason
              };
            } else if (!pendingRequest) {
              const values = intervalRequest(root);

              if (["set", "event"].includes(values.mode)) {
                campaignTime(values.day, values.time);

                const reason = root.querySelector("[name=reason]").value.trim();

                if (!reason) throw new Error("Explain the Day/time correction.");

                pendingRequest = values.mode === "event"
                  ? {
                    command: "correct-event-time",
                    journalId,
                    pageId: root.querySelector("[name=event-page]").value,
                    eventCampaign: preview?.eventCampaign,
                    day: values.day,
                    time: values.time,
                    reason
                  }
                  : {
                    command: "set-clock",
                    day: values.day,
                    time: values.time,
                    reason
                  };
              } else {
                previewAdvance(state, game.time.worldTime, values);
                pendingRequest = { command: "advance-clock", ...values };
              }

              Object.assign(pendingRequest, { clockRevision: preview?.revision, expectedWorldTime: preview?.worldTime });
            }

            pendingRequest.operationId ??= newOperationId();
            busy = true;
            refresh();
            await sendClockRequest(pendingRequest);
            pendingRequest = null;
            ui.notifications.info("Campaign time saved.");
            busy = false;
            await dialog.close();
          } catch (error) {
            root.querySelector("[data-clock-status]").textContent = `${error.message} Changes are not confirmed. Review the clock before another advance.`;
          } finally {
            busy = false;
            refresh();
          }
        }
      },
      {
        action: "cancel",
        label: "Cancel",
        callback: async () => {
          await dialog.close();
        }
      }
    ]
  });
  const closeDialog = dialog.close.bind(dialog);

  /** Keeps the request identity alive while an advance is in flight. */
  dialog.close = async (...args) => busy ? dialog : closeDialog(...args);

  /** Updates only readouts and visibility so background clock changes never replace the activity draft. */
  function refresh() {
    const root = dialog.element;

    if (!root?.querySelector) return;
    if (!game.user?.isGM || !sessionNotesEnabled()) {
      void closeDialog();

      return;
    }

    const state = sessionClockState(), mode = root.querySelector("[name=clock-mode]").value;
    const recovering = Boolean(state?.events.length || state?.pending?.status === "applied"), uncertain = Boolean(state?.pending && !recovering);

    root.querySelector("[data-clock-current]").textContent = campaignLabel(currentCampaign());
    root.querySelector("[data-clock-record-status]").textContent = recovering ? "Time record awaiting Journal save. Retry saving it before another advance." : uncertain ? "A previous clock advance needs your review." : "";
    root.querySelector("[data-clock-form]").hidden = recovering || uncertain;
    root.querySelector("[data-clock-reconcile]").hidden = !uncertain;
    if (uncertain)
      root.querySelector("[data-clock-pending]").textContent = `Requested: ${campaignLabel(state.pending.interval.start)} → ${campaignLabel(state.pending.interval.end)} (${durationLabel(state.pending.interval.seconds)}). Current: ${campaignLabel(currentCampaign())}.`;

    for (const element of root.querySelectorAll("[data-clock-modes]"))
      element.hidden = !element.dataset.clockModes.split(" ").includes(mode);

    root.querySelector("[data-clock-activity]").hidden = ["set", "event"].includes(mode);

    const output = root.querySelector("[data-clock-preview]");

    try {
      const eventCampaign = mode === "event"
        ? game.journal.get(journalId)?.pages.get(root.querySelector("[name=event-page]").value)?.getFlag(
          SESSION_MODULE,
          "sessionNotes"
        )?.campaign
        : null;

      if (["set", "event"].includes(mode))
        output.textContent = `${campaignLabel(eventCampaign ?? currentCampaign())} → ${campaignLabel(campaignTime(root.querySelector("[name=day]").value, root.querySelector("[name=time]").value))}. ${mode === "event" ? "Only this event's label changes; the current clock stays unchanged." : "World time will stay unchanged."}`;
      else {
        const value = previewAdvance(state, game.time.worldTime, intervalRequest(root));

        output.textContent = `${campaignLabel(value.start)} → ${campaignLabel(value.end)} — ${durationLabel(value.seconds)}`;
      }
      if (!pendingRequest) preview = { revision: state?.revision, worldTime: game.time.worldTime, eventCampaign };
    } catch (error) {
      output.textContent = error.message;
    }

    for (const control of root.querySelectorAll("input, select, textarea"))
      control.disabled = busy || recovering
      || (uncertain ? Boolean(control.closest("[data-clock-form]")) : Boolean(pendingRequest));

    for (const button of root.querySelectorAll("button")) button.disabled = busy;

    const save = root.querySelector('[data-action="save"]');

    if (save)
      save.textContent = recovering ? "Retry saving record" : uncertain ? "Confirm resolution" : ["set", "event"].includes(mode) ? "Save" : "Advance Time";
  }

  dialog.addEventListener("render", () => {
    dialog.element.addEventListener("input", () => {
      if (!busy && !pendingRequest) refresh();
    });

    dialog.element.addEventListener("change", event => {
      if (event.target.name === "event-page" || (event.target.name === "clock-mode" && event.target.value === "event"))
        fillEventTime();

      refresh();
    });

    if (mode === "event") fillEventTime();

    refresh();
  }, { once: true });

  const hooks = [CLOCK_CHANGED_HOOK, "updateWorldTime", "updateUser", SESSION_ENABLED_HOOK].map(name => [name, Hooks.on(name, refresh)]);

  dialog.addEventListener("close", () => {
    for (const [name, hook] of hooks) Hooks.off(name, hook);

    if (clockDialog === dialog) clockDialog = null;
  }, { once: true });

  clockDialog = dialog;
  await dialog.render({ force: true });

  return dialog;

  /** Seeds a historical correction from the selected saved event, rather than today's clock. */
  function fillEventTime() {
    const root = dialog.element;
    const campaign = game.journal.get(journalId)?.pages.get(root.querySelector("[name=event-page]").value)?.getFlag(
      SESSION_MODULE,
      "sessionNotes"
    )?.campaign;

    if (!campaign) return;

    root.querySelector("[name=day]").value = campaign.day;
    root.querySelector("[name=time]").value = campaign.time;
  }
}
