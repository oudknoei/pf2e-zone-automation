import { escapeHtml as esc, newOperationId, readDocumentFlag } from "./utils.js";
import { requestGMWorker } from "./transport.js";
import { SESSION_MODULE, SESSION_FLAG, NOTE_TYPES, requireSessionGM, sessionJournals, sessionData,
  campaignLabel, campaignTime, noteContext, visibleNoteActors, appendActorName, sessionNotesPackage } from "./session-notes-data.js";
import { openRecapPrompt, recapPrompt } from "./session-notes-settings.js";

let dashboard = null;
let quickNote = null;

/** Builds an attribute-free wrapper because DialogV2 clones its content into a form. */
function content(html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<div class="pza-session-notes">${html}</div>`;
  return wrapper;
}

/** Finds the current session or an intentionally selected historical session. */
function selectedJournal(id) {
  const journals = sessionJournals();
  if (id) return journals.find(journal => journal.id === id) ?? null;
  return journals.find(journal => sessionData(journal).state !== "ended") ?? journals.at(-1) ?? null;
}

/** Sends GM-only mutations with immutable operation IDs retained by their dialog until confirmed. */
export async function requestSessionNotes(details) {
  requireSessionGM();
  const response = await requestGMWorker({ protocol: 1, action: "session-notes", requesterUserId: game.user.id, ...details });
  if (!response?.ok) throw new Error(response?.error ?? "Session Notes could not be saved.");
  return response;
}

/** Opens the actual Journal editor for a session or one of its pages. */
function openJournal(journal, pageId) {
  requireSessionGM();
  if (!journal) throw new Error("No session is selected.");
  journal.sheet.render(true, pageId ? { pageId } : {});
}

/** Uses a real dialog as a clipboard fallback without exposing private text to players or chat. */
async function copyNotes(journal) {
  const text = sessionNotesPackage(journal, recapPrompt());
  try {
    await navigator.clipboard.writeText(text);
    ui.notifications.info("Session notes copied. This GM package may contain secrets.");
  } catch {
    const dialog = new foundry.applications.api.DialogV2({ window: { title: "Copy Session Notes — GM only" },
      position: { width: 760 }, content: content(`<p>Select and copy this text. Review secrets before sharing.</p>
        <textarea readonly name="copy-notes" rows="20">${esc(text)}</textarea>`),
      buttons: [{ action: "close", label: "Close" }] });
    dialog.addEventListener("render", () => {
      const field = dialog.element.querySelector("textarea");
      field.focus(); field.select();
    }, { once: true });
    await dialog.render({ force: true });
  }
}

/** Renders metadata, manual clock fields, and native page links without regenerating stored prose. */
function dashboardHtml(journal) {
  const journals = sessionJournals();
  const data = sessionData(journal);
  const current = data?.campaign ?? { day: 1, time: "09:00" };
  const party = [...(game.actors?.contents ?? game.actors?.values?.() ?? [])].filter(actor => actor.type === "character");
  const breaks = (data?.breaks ?? []).reduce((sum, interval) => sum + (interval.end ?? Date.now()) - interval.start, 0);
  const minutes = data ? Math.max(0, Math.floor(((data.endedAt ?? Date.now()) - data.startedAt - breaks) / 60000)) : 0;
  return `<label>Session <select name="session">${!journals.length ? '<option value="">No sessions yet</option>' : journals.map(entry =>
    `<option value="${esc(entry.id)}" ${entry.id === journal?.id ? "selected" : ""}>${esc(entry.name)} (${esc(sessionData(entry).state)})</option>`).join("")}</select></label>
    <section class="pza-session-summary">${data ? `<strong>${esc(journal.name)}</strong>
      <span>${esc(data.state === "active" ? "Session active" : data.state === "paused" ? "Session paused" : "Session ended")}</span>
      <span>${esc(campaignLabel(data.campaign))} · Real play time: ${Math.floor(minutes / 60)}h ${minutes % 60}m</span>
      <span>Start: ${esc(campaignLabel(data.startCampaign))}${data.endCampaign ? ` · End: ${esc(campaignLabel(data.endCampaign))}` : ""}</span>`
      : "Start a session to keep notes in a private Journal."}</section>
    <p class="pza-session-muted">F1: manual notes and Day/time. Gameplay events are not recorded automatically.</p>
    <div class="pza-session-clock"><label>Day <input name="day" type="number" min="0" step="1" value="${current.day}"></label>
      <label>Time of day <input name="time" type="time" value="${esc(current.time)}" required></label>
      ${data?.state !== "ended" && data ? '<button type="button" data-session-action="clock">Set Day/Time</button>' : ""}</div>
    <div class="pza-session-toolbar">
      ${data ? `<button type="button" data-session-action="journal">Open Journal</button><button type="button" data-session-action="copy">Copy Notes</button>
        <button type="button" data-session-action="note">${data.state === "ended" ? "Add Addendum" : "Quick Note"}</button>
        ${data.state !== "ended" ? `<button type="button" data-session-action="${data.state === "active" ? "pause" : "resume"}">${data.state === "active" ? "Pause Session" : "Resume Session"}</button>
          <button type="button" data-session-action="end">End Session</button>` : ""}` : ""}
      <button type="button" data-session-action="prompt">Edit Recap Prompt</button>
      <button type="button" data-session-action="refresh">Refresh</button>
    </div>
    ${data ? `<div class="pza-session-pages">${[...journal.pages].sort((a, b) => a.sort - b.sort).map(page => {
      const info = readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG);
      return `<button type="button" data-session-page="${esc(page.id)}">${esc(page.name)}${info?.campaign ? ` · ${esc(campaignLabel(info.campaign))}` : ""}</button>`;
    }).join("")}</div>` : ""}
    <details ${!data ? "open" : ""}><summary>Start a new session</summary>
      <p class="pza-session-muted">End the current session before starting another. The Day/time above is manual and carries forward.</p>
      <label>Title <input name="title" type="text" maxlength="200" placeholder="The Old Mill"></label>
      <label>Session number (optional) <input name="number" type="text" maxlength="30"></label>
      <fieldset><legend>Party (optional)</legend><div class="pza-session-party">${party.map(actor =>
        `<label><input name="party" value="${esc(actor.id)}" type="checkbox" ${data?.party.some(member => member.id === actor.id) ? "checked" : ""}> ${esc(actor.name)}</label>`).join("")}</div></fieldset>
      <button type="button" data-session-action="start" ${journals.some(entry => sessionData(entry).state !== "ended") ? "disabled" : ""}>Start Session</button>
    </details>
    <p data-session-status role="status"></p>`;
}

/** Opens a single compact management window with private Journals as its saved source. */
export async function openSessionNotes() {
  requireSessionGM();
  if (dashboard) { dashboard.bringToFront(); return dashboard; }
  let journal = selectedJournal();
  let pending = null;
  let busy = false;
  const dialog = new foundry.applications.api.DialogV2({ window: { title: "Session Notes" },
    position: { width: 740 }, content: content(dashboardHtml(journal)), form: { closeOnSubmit: false },
    buttons: [{ action: "close", label: "Close", callback: async () => { await dialog.close(); } }] });
  const permissionHook = Hooks.on("updateUser", () => { if (!game.user?.isGM) void dialog.close(); });
  /** Refreshes only this management view after a confirmed save or deliberate navigation. */
  function refresh(id = journal?.id) {
    journal = selectedJournal(id);
    dialog.element.querySelector(".pza-session-notes").innerHTML = dashboardHtml(journal);
  }
  dialog.addEventListener("render", () => {
    const root = dialog.element.querySelector(".pza-session-notes");
    root.addEventListener("change", event => {
      if (event.target.name === "session") { pending = null; refresh(event.target.value); }
    });
    root.addEventListener("input", () => { if (!busy) pending = null; });
    root.addEventListener("click", async event => {
      const button = event.target.closest("button");
      if (!button || busy) return;
      const action = button.dataset.sessionAction;
      const status = root.querySelector("[data-session-status]");
      try {
        requireSessionGM();
        if (button.dataset.sessionPage) return openJournal(journal, button.dataset.sessionPage);
        if (!action) return;
        if (action === "journal") return openJournal(journal);
        if (action === "copy") return await copyNotes(journal);
        if (action === "prompt") return await openRecapPrompt();
        if (action === "note") return await openQuickNote({ journalId: journal.id, addendum: sessionData(journal).state === "ended" });
        if (action === "refresh") { pending = null; return refresh(); }
        if (pending && pending.command !== action) throw new Error("Retry or refresh the pending action before starting a different one.");
        if (!pending) {
          pending = { command: action, operationId: newOperationId(), journalId: journal?.id,
            revision: sessionData(journal)?.revision };
          if (action === "clock" || action === "start") Object.assign(pending, {
            day: root.querySelector("[name=day]").value, time: root.querySelector("[name=time]").value
          });
          if (action === "start") Object.assign(pending, {
            title: root.querySelector("[name=title]").value, number: root.querySelector("[name=number]").value,
            partyIds: [...root.querySelectorAll("[name=party]:checked")].map(input => input.value),
            predecessorId: sessionJournals().at(-1)?.id ?? null
          });
        }
        busy = true;
        for (const control of root.querySelectorAll("button, input, select")) control.disabled = true;
        status.textContent = "Saving…";
        const result = await requestSessionNotes(pending);
        pending = null;
        refresh(result.journalId);
        root.querySelector("[data-session-status]").textContent = "Saved.";
      } catch (error) { status.textContent = `${error.message} Your draft has been kept. Retry the same action or choose Refresh to review saved state.`; }
      finally {
        busy = false;
        for (const control of root.querySelectorAll("button, input, select")) control.disabled = false;
        const start = root.querySelector('[data-session-action="start"]');
        if (start) start.disabled = sessionJournals().some(entry => sessionData(entry).state !== "ended");
      }
    });
  }, { once: true });
  dialog.addEventListener("close", () => {
    Hooks.off("updateUser", permissionHook);
    if (dashboard === dialog) dashboard = null;
  }, { once: true });
  dashboard = dialog;
  await dialog.render({ force: true });
  return dialog;
}

/** Builds the note form with portrait insertion and explicit OK-only saving. */
function quickNoteHtml(journal, addendum) {
  const data = sessionData(journal);
  const context = noteContext();
  return `<p data-note-session>${esc(journal?.name ?? "No active session")}${data ? ` · ${esc(campaignLabel(data.campaign))}` : ""}</p>
    <div class="pza-note-layout"><div><label>Note <textarea name="note" rows="12" maxlength="50000" autofocus></textarea></label>
      <p class="pza-session-muted">Enter adds a new line. Click OK to save.</p></div>
      <aside><strong>Actors on Screen</strong><div class="pza-note-actors" data-note-actors></div>
        <small>Click a portrait to add their name.</small></aside></div>
    <div class="pza-session-fields"><label>Type <select name="note-type">${NOTE_TYPES.map(type => `<option>${type}</option>`).join("")}</select></label>
      <label><input name="important" type="checkbox"> Important</label>
      <label>Visibility <select name="visibility"><option value="gm">GM only</option><option value="player">Marked player-safe (Journal stays private)</option></select></label>
      <label><input name="excluded" type="checkbox"> Exclude from recap</label></div>
    <details><summary>Context${addendum ? " and addendum time" : " (optional)"}</summary>
      <label>Location <input name="location" value="${esc(context.location)}"></label>
      <label>Related document UUID (optional) <input name="related" type="text"></label>
      ${addendum ? `<p>Late addendum: choose when this happened. Entry time is recorded separately.</p>
        <label>Day <input name="day" type="number" min="0" value="${data.campaign.day}"></label>
        <label>Time <input name="time" type="time" value="${esc(data.campaign.time)}"></label>` : ""}
    </details>
    <p data-note-status role="status"></p>
    ${!journal ? '<button type="button" data-note-start>Start Session</button>' : ""}`;
}

/** Keeps the draft and textarea intact while replacing only the viewport Actor list. */
function renderActorButtons(root) {
  const list = root.querySelector("[data-note-actors]");
  const rows = visibleNoteActors();
  const signature = JSON.stringify(rows);
  if (list.dataset.signature === signature) {
    for (const button of list.querySelectorAll("button")) button.disabled = root.dataset.notePending === "true";
    return;
  }
  list.dataset.signature = signature;
  list.replaceChildren();
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "pza-note-actor";
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = root.dataset.notePending === "true";
    button.title = `Add ${row.name} to note`;
    button.setAttribute("aria-label", button.title);
    const image = document.createElement("img");
    image.src = row.image;
    image.alt = "";
    image.addEventListener("error", () => { image.src = "icons/svg/mystery-man.svg"; }, { once: true });
    button.append(image);
    button.addEventListener("click", () => appendActorName(root.querySelector("[name=note]"), row.name));
    const label = document.createElement("span");
    label.textContent = row.name;
    const sameNames = rows.filter(other => other.name === row.name);
    if (sameNames.length > 1) label.append(` (${row.qualifier && row.qualifier !== row.name
      && sameNames.every(other => other === row || other.qualifier !== row.qualifier) ? row.qualifier : sameNames.indexOf(row) + 1})`);
    line.append(button, label);
    list.append(line);
  }
  if (!rows.length) list.textContent = "No Actors on Screen";
}

/** Opens one draft, attaches viewport listeners, and closes only after a confirmed Journal save. */
export async function openQuickNote({ journalId, addendum = false } = {}) {
  requireSessionGM();
  if (quickNote) { quickNote.bringToFront(); quickNote.element?.querySelector("[name=note]")?.focus(); return quickNote; }
  const active = sessionJournals().find(journal => sessionData(journal).state !== "ended");
  let journal = journalId ? selectedJournal(journalId) : active;
  if (journalId && !journal) throw new Error("The requested Session Notes Journal no longer exists.");
  if (journal && sessionData(journal).state === "ended" && !addendum) journal = null;
  let pending = null;
  let saving = false;
  const hooks = [];
  const dialog = new foundry.applications.api.DialogV2({ window: { title: addendum ? "Quick Note — Addendum" : "Quick Note" },
    position: { width: 840 }, content: content(quickNoteHtml(journal, addendum)), form: { closeOnSubmit: false },
    buttons: [
      { action: "ok", label: "OK", callback: async (_event, button) => {
        if (saving) return;
        const root = dialog.element.querySelector(".pza-session-notes");
        const status = root.querySelector("[data-note-status]");
        try {
          requireSessionGM();
          if (!journal) throw new Error("Start a session first. Your note is still here.");
          if (!pending && !root.querySelector("[name=note]").value.trim()) throw new Error("Enter a note before saving.");
          if (!pending && root.querySelector("[name=note]").value.length > 50000) throw new Error("Notes must contain at most 50,000 characters.");
          if (!pending && addendum) campaignTime(root.querySelector("[name=day]").value, root.querySelector("[name=time]").value);
          if (!pending) pending = {
            command: "note", journalId: journal.id, operationId: newOperationId(),
            text: root.querySelector("[name=note]").value, noteType: root.querySelector("[name=note-type]").value,
            important: root.querySelector("[name=important]").checked, excluded: root.querySelector("[name=excluded]").checked,
            playerSafe: root.querySelector("[name=visibility]").value === "player", location: root.querySelector("[name=location]").value,
            related: root.querySelector("[name=related]").value, context: noteContext(), addendum,
            ...(addendum ? { day: root.querySelector("[name=day]").value, time: root.querySelector("[name=time]").value } : {})
          };
          root.dataset.notePending = "true";
          saving = true;
          for (const control of dialog.element.querySelectorAll("input, select, textarea, button")) control.disabled = true;
          status.textContent = "Saving…";
          const result = await requestSessionNotes(pending);
          ui.notifications.info(result.deleted ? "This note was already saved and later deleted; it was not recreated." : "Note saved.");
          saving = false;
          await dialog.close();
        } catch (error) {
          status.textContent = `${error.message} Note not confirmed. Your draft is retained; click OK to retry the same save.`;
        } finally {
          saving = false;
          // An uncertain request is immutable: don't discard edited text by retrying an older payload.
          for (const control of dialog.element.querySelectorAll("input, select, textarea")) control.disabled = Boolean(pending);
          const area = root.querySelector("[name=note]");
          area.disabled = false;
          area.readOnly = Boolean(pending);
          for (const control of dialog.element.querySelectorAll("button")) control.disabled = Boolean(pending && control.closest("[data-note-actors]"));
          button.disabled = false;
        }
      } },
      { action: "cancel", label: "Cancel", callback: async () => { if (!saving) await dialog.close(); } }
    ] });
  const closeDialog = dialog.close.bind(dialog);
  /** Keeps the original draft alive if the title-bar close control is used during an in-flight save. */
  dialog.close = async (...args) => saving ? dialog : closeDialog(...args);
  dialog.addEventListener("render", () => {
    const root = dialog.element.querySelector(".pza-session-notes");
    const area = root.querySelector("[name=note]");
    // Stop DialogV2's default submit key while leaving the textarea's native newline action intact.
    dialog.element.addEventListener("keydown", event => {
      if ((event.key === "Enter" && event.target === area)
        || (["Enter", " "].includes(event.key) && event.target.closest("[data-note-actors] button"))) event.stopPropagation();
    }, { capture: true });
    root.addEventListener("input", () => {
      if (pending && !saving) root.querySelector("[data-note-status]").textContent = "A save is awaiting confirmation. OK retries the original text; edits remain in this draft.";
    });
    /** Refreshes the Actor panel without rebuilding or refocusing the note area. */
    const refresh = () => {
      if (!game.user?.isGM) { void dialog.close(); return; }
      renderActorButtons(root);
      if (!journal) {
        journal = sessionJournals().find(entry => sessionData(entry).state !== "ended") ?? null;
        if (journal) {
          root.querySelector("[data-note-session]").textContent = `${journal.name} · ${campaignLabel(sessionData(journal).campaign)}`;
          root.querySelector("[data-note-start]")?.remove();
        }
      }
    };
    for (const name of ["canvasPan", "canvasReady", "canvasTearDown", "createToken", "updateToken", "deleteToken", "refreshToken",
      "updateActor", "deleteActor", "updateUser", "createJournalEntry"]) hooks.push([name, Hooks.on(name, refresh)]);
    root.querySelector("[data-note-start]")?.addEventListener("click", () => { void openSessionNotes(); });
    refresh();
    area.focus();
  }, { once: true });
  dialog.addEventListener("close", () => {
    for (const [name, id] of hooks) Hooks.off(name, id);
    if (quickNote === dialog) quickNote = null;
  }, { once: true });
  quickNote = dialog;
  await dialog.render({ force: true });
  return dialog;
}

/** Records deliberate native deletions and decorates Journal views without rewriting editable page content. */
export function registerSessionNotesHooks() {
  Hooks.on("deleteJournalEntryPage", page => {
    const metadata = readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG);
    if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id || metadata?.role !== "event" || !sessionData(page.parent)) return;
    void requestSessionNotes({ command: "forget-note", operationId: newOperationId(), journalId: page.parent.id,
      receiptKey: metadata.key, pageId: page.id }).catch(() => {
      ui.notifications.warn("The note was deleted, but its deletion receipt could not be saved. Do not retry an unconfirmed save for that note until the Journal has been reviewed.");
    });
  });
  Hooks.on("renderJournalEntrySheet", (application, html) => {
    const data = sessionData(application.document);
    const root = html?.[0] ?? html;
    if (!data || !game.user?.isGM || !root?.querySelector) return;
    root.querySelector("[data-session-journal-status]")?.remove();
    const panel = document.createElement("aside");
    panel.dataset.sessionJournalStatus = "";
    panel.className = "pza-session-summary";
    panel.textContent = `${data.state === "ended" ? "Session ended" : data.state === "paused" ? "Session paused" : "Session active"} · Start: ${campaignLabel(data.startCampaign)} · ${data.endCampaign ? "End" : "Current"}: ${campaignLabel(data.endCampaign ?? data.campaign)}`;
    (root.querySelector(".journal-entry-content") ?? root).prepend(panel);
  });
}
