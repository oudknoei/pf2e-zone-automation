import { canonicalJson, cloneData, readDocumentFlag } from "./utils.js";
import {
  SESSION_MODULE,
  SESSION_FLAG,
  sessionData,
  sessionJournals,
  sessionDocumentId,
  noteHtml
} from "./session-notes-data.js";
import {
  CLOCK_SETTING,
  CLOCK_ACTIVITIES,
  campaignAt,
  campaignTime,
  campaignLabel,
  sessionClockState,
  previewAdvance,
  durationLabel
} from "./session-clock-data.js";

export const CLOCK_COMMANDS = new Set(["clock", "set-clock", "advance-clock", "observe-clock", "clock-sync", "reconcile-clock", "correct-event-time"]);

/** Refuses to invent elapsed time when Foundry's shared clock is unavailable. */
function worldTime() {
  if (!Number.isFinite(game.time?.worldTime)) throw new Error("Foundry's world clock is unavailable.");

  return game.time.worldTime;
}

/** Persists clock provenance before side effects and confirms lost setting acknowledgments by exact state. */
async function persist(state, request, workerId, services) {
  services.authority(request, workerId);

  const keys = Object.keys(state.completed);

  for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete state.completed[key];

  state.revision++;

  const intended = cloneData(state);

  try {
    await game.settings.set(SESSION_MODULE, CLOCK_SETTING, intended);
  } catch (error) {
    if (canonicalJson(sessionClockState()) !== canonicalJson(intended)) throw error;
  }

  if (canonicalJson(sessionClockState()) !== canonicalJson(intended))
    throw new Error("The campaign clock state could not be confirmed. Reopen Advance Time to review it.");
}

/** Anchors an existing campaign at its supplied Day/time without changing Foundry's world timestamp. */
export async function ensureSessionClock(request, workerId, services, initial = null) {
  let state = sessionClockState();

  if (state) return cloneData(state);

  const journals = sessionJournals();
  const data = sessionData(journals.find(journal => sessionData(journal).state !== "ended") ?? journals.at(-1));
  const value = data?.campaign ?? initial;

  if (!value) return null;

  state = {
    schemaVersion: 1,
    revision: 0,
    anchorRevision: 1,
    anchor: { ...value, worldTime: worldTime() },
    observedWorldTime: worldTime(),
    sequence: 0,
    pending: null,
    events: [],
    completed: {},
    lastActivity: "Searching",
    initialization: {
      source: data ? "legacy-session" : "supplied",
      recordedAt: Date.now(),
      note: data ? "Imported the last saved Day/time at the current world timestamp; earlier elapsed time was not reconstructed." : "Day/time supplied by the GM."
    }
  };

  await persist(state, request, workerId, services);

  return state;
}

/** Gives out-of-session time its own private Journal rather than attaching it to a past session. */
async function clockJournal(event, request, workerId, services) {
  if (event.journalId) {
    const journal = game.journal.get(event.journalId);

    if (!sessionData(journal))
      throw new Error("A clock event's session Journal is missing. Restore it before retrying.");

    return journal;
  }

  const id = await sessionDocumentId("campaign-clock");
  let journal = game.journal.get(id);

  if (journal && !readDocumentFlag(journal, SESSION_MODULE, "campaignClock"))
    throw new Error("The Campaign Clock Journal ID is already in use.");
  if (!journal) {
    const folder = await services.ensureFolder(request, workerId);

    services.authority(request, workerId);
    await services.confirmedWrite(() => CONFIG.JournalEntry.documentClass.create({
      _id: id,
      name: "Campaign Clock",
      folder: folder.id,
      ownership: { default: 0 },
      pages: [],
      flags: { [SESSION_MODULE]: { campaignClock: true } }
    }, { keepId: true }), () => Boolean(readDocumentFlag(game.journal.get(id), SESSION_MODULE, "campaignClock")));

    journal = game.journal.get(id);
  }

  return journal;
}

/** Saves each clock event once, preserving native prose edits and deletion receipts across retries. */
async function saveEvent(event, request, workerId, services) {
  const journal = await clockJournal(event, request, workerId, services);
  const receiptPath = `flags.${SESSION_MODULE}.sessionOperations.${event.id}`;
  const saved = readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[event.id];

  if (saved && saved.fingerprint !== event.fingerprint) throw new Error("Clock event identity collision.");
  if (["complete", "deleted"].includes(saved?.status)) return;

  const pageId = await sessionDocumentId("clock-page", event.id);

  services.authority(request, workerId);
  if (!saved)
    await services.confirmedWrite(() => journal.update({
      [receiptPath]: {
        status: "reserved",
        fingerprint: event.fingerprint,
        pageId,
        sort: Math.max(
          0,
          ...[...journal.pages].filter(page => readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG)?.role === "event").map(page => page.sort ?? 0)
        ) + 1000
      }
    }), () => Boolean(readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[event.id]));

  const reservation = readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")[event.id];

  if (event.correctionTarget) {
    const correction = event.correctionTarget;
    const target = journal.pages.get(correction.pageId), metadata = readDocumentFlag(target, SESSION_MODULE, SESSION_FLAG);

    if (!metadata || metadata.role !== "event")
      throw new Error("The event being corrected no longer exists. Restore it before retrying.");
    if (!metadata.timeCorrections?.some(value => value.id === event.id)) {
      if (canonicalJson(metadata.campaign) !== canonicalJson(correction.before))
        throw new Error("The event time changed. Review it before applying a historical correction.");

      services.authority(request, workerId);
      await services.confirmedWrite(() => target.update({
        [`flags.${SESSION_MODULE}.${SESSION_FLAG}.campaign`]: correction.after,
        [`flags.${SESSION_MODULE}.${SESSION_FLAG}.timeCorrections`]: [...(metadata.timeCorrections ?? []), {
          id: event.id,
          before: correction.before,
          after: correction.after,
          reason: correction.reason,
          author: event.author,
          recordedAt: event.recordedAt
        }]
      }), () => Boolean(readDocumentFlag(target, SESSION_MODULE, SESSION_FLAG)?.timeCorrections?.some(value => value.id === event.id)));
    }
  }

  const page = journal.pages.get(pageId);

  if (page && readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG)?.fingerprint !== event.fingerprint)
    throw new Error("Clock page identity collision.");
  if (!page) {
    services.authority(request, workerId);
    await services.confirmedWrite(() => journal.createEmbeddedDocuments("JournalEntryPage", [{
      _id: pageId,
      name: `${event.clock.kind === "activity" ? event.clock.activity : "Clock"} — ${campaignLabel(event.campaign)}`,
      type: "text",
      sort: reservation.sort,
      ownership: { default: -1 },
      text: { content: noteHtml(event.text), format: 1 },
      flags: {
        [SESSION_MODULE]: {
          [SESSION_FLAG]: {
            role: "event",
            key: event.id,
            fingerprint: event.fingerprint,
            campaign: event.campaign,
            recordedAt: event.recordedAt,
            worldTime: event.clock.worldEnd,
            anchorRevision: event.anchorRevision,
            noteType: "Time",
            author: event.author,
            clock: event.clock
          }
        }
      }
    }], { keepId: true }), () => readDocumentFlag(journal.pages.get(pageId), SESSION_MODULE, SESSION_FLAG)?.fingerprint === event.fingerprint);
  }

  services.authority(request, workerId);
  await services.confirmedWrite(
    () => journal.update({ [receiptPath]: { ...reservation, status: "complete" } }),
    () => readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[event.id]?.status === "complete"
  );
}

/** Drains durable pending Journal writes before allowing another clock mutation. */
async function flushEvents(state, request, workerId, services) {
  while (state.events.length) {
    await saveEvent(state.events[0], request, workerId, services);
    state.events.shift();
    await persist(state, request, workerId, services);
  }
}

/** Captures the session and paused state at observation time, before any asynchronous persistence. */
function eventContext() {
  const journal = sessionJournals().find(entry => sessionData(entry).state !== "ended");

  return { journalId: journal?.id ?? null, outsidePlay: !journal || sessionData(journal).state === "paused" };
}

/** Builds one immutable interval whose editable Journal text remains authoritative after saving. */
function eventRecord(state, id, fingerprint, clock, text, requester, context = eventContext()) {
  return {
    id,
    fingerprint,
    journalId: context.journalId,
    recordedAt: Date.now(),
    anchorRevision: state.anchorRevision,
    campaign: clock.end,
    clock: { ...clock, outsidePlay: context.outsidePlay },
    author: { id: requester.id, name: requester.name },
    text: `${text}${context.outsidePlay ? "\nOutside recorded play." : ""}`
  };
}

/** Updates only live session clock metadata; historical pages and ended sessions remain untouched. */
async function updateCurrentSession(state, request, workerId, services) {
  const journal = sessionJournals().find(entry => sessionData(entry).state !== "ended");

  if (!journal) return;

  services.authority(request, workerId);

  const campaign = campaignAt(state.anchor, worldTime());

  if (canonicalJson(sessionData(journal).campaign) !== canonicalJson(campaign) || sessionData(journal).clockAnchorRevision !== state.anchorRevision) {
    await services.confirmedWrite(() => journal.update({
      [`flags.${SESSION_MODULE}.${SESSION_FLAG}.campaign`]: campaign,
      [`flags.${SESSION_MODULE}.${SESSION_FLAG}.clockAnchorRevision`]: state.anchorRevision
    }), () => canonicalJson(sessionData(journal).campaign) === canonicalJson(campaign));
  }
  if (request.command === "clock" && journal.id === request.journalId && sessionData(journal).revision === request.revision) {
    services.authority(request, workerId);
    await journal.update({ [`flags.${SESSION_MODULE}.${SESSION_FLAG}.revision`]: request.revision + 1 });
  }
}

/** Finds a durable receipt even after its bounded recent-operation index has been pruned. */
function completedOperation(state, id, fingerprint) {
  const receipt = state.completed[id] ?? [...(game.journal?.contents ?? [])]
    .map(journal => readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[id]).find(value => value && ["complete", "deleted"].includes(value.status));

  if (receipt && receipt.fingerprint !== fingerprint)
    throw new Error("Clock operation ID was reused with different details.");

  return Boolean(receipt);
}

/** Commits confirmed clock provenance before attempting the explained Journal entry. */
async function finishAdvance(state, request, workerId, services, requester) {
  const pending = state.pending;

  state.observedWorldTime = pending.interval.worldEnd;
  state.events.push(eventRecord(
    state,
    pending.id,
    pending.fingerprint,
    {
      kind: "activity",
      ...pending.interval,
      activity: pending.activity,
      participants: pending.participants,
      explanation: pending.explanation,
      reconciled: Boolean(pending.reconciled)
    },
`${campaignLabel(pending.interval.start)} → ${campaignLabel(pending.interval.end)} — ${durationLabel(pending.interval.seconds)} — ${pending.activity}${pending.explanation ? `: ${pending.explanation}` : ""}${pending.participants.length ? `\nParticipants: ${pending.participants.map(actor => actor.name).join(", ")}` : ""}${pending.reconciled ? `\nManually reconciled: ${pending.reconciled}` : ""}`,
pending.author ?? requester,
pending.context
  ));

  state.lastActivity = pending.activity;
  state.completed[pending.id] = { fingerprint: pending.fingerprint };
  state.pending = null;
  await persist(state, request, workerId, services);
  await flushEvents(state, request, workerId, services);
  await updateCurrentSession(state, request, workerId, services);
}

/** Records exact external deltas and explicit rewinds, without advancing the clock itself. */
async function observe(state, request, workerId, services, requester) {
  const target = request.worldTime ?? worldTime();

  if (!Number.isFinite(target)) throw new Error("Invalid world clock observation.");

  const proof = request.provenance;

  if (proof && state.pending?.id === proof.id && state.pending.fingerprint === proof.fingerprint
    && state.pending.interval.worldEnd === target && request.delta === state.pending.interval.seconds) {
    state.pending.status = "applied";
    await persist(state, request, workerId, services);

    return finishAdvance(state, request, workerId, services, requester);
  }
  if (proof && completedOperation(state, proof.id, proof.fingerprint)) return;
  if (state.pending) return;
  if (target === state.observedWorldTime) return;

  const expectedStart = Number.isFinite(request.delta) ? target - request.delta : null;
  const gap = request.command === "clock-sync" || (expectedStart !== null && expectedStart !== state.observedWorldTime);
  // An outdated hook without a matching baseline cannot replace the canonical current clock.
  const endWorld = gap ? worldTime() : target;

  if (endWorld === state.observedWorldTime) return;

  const from = state.observedWorldTime;
  const clock = {
    kind: gap ? "gap" : endWorld < from ? "rewind" : "external",
    seconds: endWorld - from,
    worldStart: from,
    worldEnd: endWorld,
    start: campaignAt(state.anchor, from),
    end: campaignAt(state.anchor, endWorld),
    sourceUserId: request.sourceUserId ?? null,
    explanation: gap ? "Clock changed outside confirmed recording; intermediate activities are unknown." : "Foundry world-time change"
  };
  const id = await sessionDocumentId("clock-observation", ++state.sequence, from, endWorld);

  state.events.push(eventRecord(
    state,
    id,
    id,
    clock,
`${campaignLabel(clock.start)} → ${campaignLabel(clock.end)} — ${durationLabel(clock.seconds)} — ${clock.explanation}${clock.seconds < 0 ? " (rewind/correction, not elapsed activity)" : ""}`,
requester,
{ ...eventContext(), ...(gap ? { outsidePlay: true } : {}) }
  ));

  state.observedWorldTime = endWorld;
  await persist(state, request, workerId, services);
  await flushEvents(state, request, workerId, services);
  await updateCurrentSession(state, request, workerId, services);
}

/** Reconciles missed changes at save/lifecycle boundaries without pretending to recover individual activities. */
export async function syncSessionClock(request, workerId, services) {
  const state = await ensureSessionClock(request, workerId, services);

  if (!state) return null;

  await flushEvents(state, request, workerId, services);
  if (state.pending?.status === "applied")
    await finishAdvance(state, request, workerId, services, services.authority(request, workerId));
  if (state.observedWorldTime !== worldTime() && !state.pending)
    await observe(state, { ...request, command: "clock-sync" }, workerId, services, services.authority(request, workerId));

  return state;
}

/** Applies a supplied session-start anchor while recording explicit changes to an already initialized clock. */
export async function prepareSessionClock(request, workerId, services, initial) {
  let state = await ensureSessionClock(request, workerId, services, initial);

  state = await syncSessionClock(request, workerId, services);
  if (state.pending) throw new Error("Reconcile the pending advance in Advance Time before starting a session.");

  const current = campaignAt(state.anchor, worldTime());

  if (current.day !== initial.day || current.time !== initial.time) {
    await executeSessionClock({
      ...request,
      command: "set-clock",
      reason: "Campaign time supplied when starting a session.",
      clockRevision: state.revision,
      expectedWorldTime: worldTime()
    }, workerId, services);

    return campaignAt(sessionClockState().anchor, worldTime());
  }

  return current;
}

/** Serializes corrections, explained advances, observations, and manual recovery under the session worker lock. */
export async function executeSessionClock(request, workerId, services) {
  const requester = services.authority(request, workerId);
  const id = await sessionDocumentId("clock-operation", requester.id, request.operationId);
  const fingerprint = canonicalJson({ ...request, protocol: undefined, action: undefined });

  if (request.command === "set-clock" && !String(request.reason ?? "").trim())
    throw new Error("Explain the Day/time correction.");
  if (!sessionClockState() && request.expectedWorldTime != null && request.expectedWorldTime !== worldTime())
    throw new Error("World time changed. Review a new preview before applying.");

  const state = await ensureSessionClock(
    request,
    workerId,
    services,
    request.command === "set-clock" ? campaignTime(request.day, request.time) : null
  );

  if (!state) {
    if (["clock-sync", "observe-clock"].includes(request.command)) return {};

    throw new Error("Set the campaign Day/time before advancing time.");
  }

  await flushEvents(state, request, workerId, services);

  if (["clock-sync", "observe-clock"].includes(request.command)) {
    if (request.command === "clock-sync" && state.pending?.status === "applied")
      await finishAdvance(state, request, workerId, services, requester);
    else await observe(state, request, workerId, services, requester);

    await updateCurrentSession(state, request, workerId, services);

    return {};
  }
  if (completedOperation(state, id, fingerprint)) {
    await updateCurrentSession(state, request, workerId, services);

    return {};
  }
  if (request.command === "correct-event-time") {
    const journal = game.journal.get(request.journalId), page = journal?.pages.get(request.pageId);
    const metadata = readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG);
    const reason = String(request.reason ?? "").trim(), after = campaignTime(request.day, request.time);

    if (!sessionData(journal) || metadata?.role !== "event" || !metadata.campaign)
      throw new Error("Choose a saved session event to correct.");
    if (!reason || reason.length > 5000) throw new Error("Explain the historical time correction.");
    if (canonicalJson(metadata.campaign) !== canonicalJson(request.eventCampaign))
      throw new Error("The event time changed. Review it before correcting it.");

    const clock = {
      kind: "event-time-correction",
      seconds: 0,
      worldStart: worldTime(),
      worldEnd: worldTime(),
      start: metadata.campaign,
      end: after,
      explanation: reason
    };
    const event = eventRecord(
      state,
      id,
      fingerprint,
      clock,
`Historical event time corrected: ${page.name}. ${campaignLabel(metadata.campaign)} → ${campaignLabel(after)}. World time and campaign anchor unchanged. ${reason}`,
requester,
{ journalId: journal.id, outsidePlay: sessionData(journal).state !== "active" }
    );

    event.correctionTarget = {
      pageId: page.id,
      before: metadata.campaign,
      after,
      reason
    };

    state.events.push(event);
    state.completed[id] = { fingerprint };
    await persist(state, request, workerId, services);
    await flushEvents(state, request, workerId, services);

    return {};
  }
  if (!state.pending && state.observedWorldTime !== worldTime())
    await observe(state, { ...request, command: "clock-sync" }, workerId, services, requester);
  if (request.command === "reconcile-clock") {
    if (!state.pending || request.pendingId !== state.pending.id || !String(request.reason ?? "").trim())
      throw new Error("Review the pending clock advance and explain its resolution.");
    if (request.resolution === "applied") {
      state.pending.reconciled = String(request.reason).slice(0, 5000);
      await finishAdvance(state, request, workerId, services, requester);
    } else if (request.resolution === "not-applied") {
      const clock = {
        kind: "reconciliation",
        worldStart: worldTime(),
        worldEnd: worldTime(),
        seconds: 0,
        start: campaignAt(state.anchor, worldTime()),
        end: campaignAt(state.anchor, worldTime()),
        explanation: String(request.reason).slice(0, 5000)
      };

      state.events.push(eventRecord(
        state,
        state.pending.id,
        state.pending.fingerprint,
        clock,
`Pending advance cancelled without changing world time. GM confirmed it was not applied: ${clock.explanation}`,
requester,
state.pending.context
      ));

      state.completed[state.pending.id] = { fingerprint: state.pending.fingerprint };
      state.pending = null;
      await persist(state, request, workerId, services);
      await flushEvents(state, request, workerId, services);
    } else throw new Error("Choose whether the pending advance was applied.");

    return {};
  }
  if (state.pending && (state.pending.id !== id || state.pending.fingerprint !== fingerprint))
    throw new Error("A clock advance needs reconciliation before another change. Open Advance Time.");
  if (state.pending?.status === "applied") {
    await finishAdvance(state, request, workerId, services, requester);

    return {};
  }
  if (state.pending?.status === "dispatching")
    throw new Error("The previous advance is uncertain. Reconcile it in Advance Time; it will not be sent again automatically.");
  if (!state.pending) {
    if (request.clockRevision != null && request.clockRevision !== state.revision)
      throw new Error("The campaign clock changed. Review a new preview before applying.");
    if (request.expectedWorldTime != null && request.expectedWorldTime !== worldTime())
      throw new Error("World time changed. Review a new preview before applying.");
    if (request.command === "clock") {
      const journal = game.journal.get(request.journalId);

      if (!sessionData(journal) || sessionData(journal).state === "ended" || sessionData(journal).revision !== request.revision)
        throw new Error("The session changed. Reopen Set Day/Time and review its current state.");
    }
    if (["clock", "set-clock"].includes(request.command)) {
      const before = campaignAt(state.anchor, worldTime()), after = campaignTime(request.day, request.time);
      const reason = String(request.reason ?? (request.command === "clock" ? "Manual Day/time correction" : "")).trim();

      if (!reason || reason.length > 5000) throw new Error("Explain the Day/time correction (up to 5,000 characters).");

      const clock = {
        kind: "display-correction",
        seconds: 0,
        worldStart: worldTime(),
        worldEnd: worldTime(),
        start: before,
        end: after,
        explanation: reason
      };

      state.anchor = { ...after, worldTime: worldTime() };
      state.anchorRevision++;
      state.events.push(eventRecord(
        state,
        id,
        fingerprint,
        clock,
`Display correction: ${campaignLabel(before)} → ${campaignLabel(after)}. World time unchanged. ${reason}`,
requester
      ));

      state.completed[id] = { fingerprint };
      state.observedWorldTime = worldTime();
      await persist(state, request, workerId, services);
      await flushEvents(state, request, workerId, services);
      await updateCurrentSession(state, request, workerId, services);

      return {};
    }
    if (request.command !== "advance-clock") throw new Error("Unsupported clock action.");
    if (!CLOCK_ACTIVITIES.includes(request.activity)) throw new Error("Choose an activity label.");

    const explanation = String(request.explanation ?? "").trim();

    if (explanation.length > 5000) throw new Error("Activity details must be at most 5,000 characters.");

    const participants = [...new Set(request.participantIds ?? [])].map(actorId => {
      const actor = game.actors.get(actorId);

      if (!actor || actor.type !== "character") throw new Error("An activity participant no longer exists.");

      return { id: actor.id, name: actor.name, uuid: actor.uuid };
    });

    state.pending = {
      id,
      fingerprint,
      status: "reserved",
      interval: previewAdvance(state, worldTime(), request),
      activity: request.activity,
      explanation,
      participants,
      context: eventContext(),
      author: { id: requester.id, name: requester.name }
    };

    await persist(state, request, workerId, services);
  }
  if (typeof game.time.advance !== "function") throw new Error("Foundry's time advance service is unavailable.");
  if (worldTime() !== state.pending.interval.worldStart)
    throw new Error("World time changed before dispatch. Reconcile the reserved advance in Advance Time.");

  state.pending.status = "dispatching";
  await persist(state, request, workerId, services);
  services.authority(request, workerId);
  if (worldTime() !== state.pending.interval.worldStart)
    throw new Error("World time changed before dispatch. Reconcile the reserved advance in Advance Time.");

  const result = await game.time.advance(state.pending.interval.seconds, { pf2eZoneSessionClock: { id, fingerprint } });

  if (result !== state.pending.interval.worldEnd)
    throw new Error("The clock result differed from the preview. Reconcile this advance before continuing.");

  state.pending.status = "applied";
  await persist(state, request, workerId, services);
  await finishAdvance(state, request, workerId, services, requester);

  return {};
}
