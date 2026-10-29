import { canonicalJson, cloneData, escapeHtml, readDocumentFlag } from "./utils.js";
import { getWorkerRequester } from "./worker-permissions.js";
import {
  SESSION_MODULE,
  SESSION_FLAG,
  NOTE_TYPES,
  campaignTime,
  campaignLabel,
  noteHtml,
  sessionData,
  sessionJournals,
  sessionDocumentId,
  requireSessionNotes
} from "./session-notes-data.js";
import { currentCampaign, sessionClockState } from "./session-clock-data.js";
import {
  CLOCK_COMMANDS,
  executeSessionClock,
  prepareSessionClock,
  syncSessionClock
} from "./session-clock-repository.js";

let tail = Promise.resolve();

/** Revalidates the authenticated requester and elected GM before each queued document operation. */
function authority(request, workerId) {
  const requester = getWorkerRequester(request);

  if (!requester.isGM || !game.user?.isGM || game.user.id !== workerId || game.users.activeGM?.id !== workerId) {
    throw new Error("Only a GM can manage Session Notes through the active GM.");
  }

  requireSessionNotes();

  return requester;
}

/** Gives all tabs in this browser one lock in addition to the elected-GM process queue. */
export function executeSessionNotes(request) {
  const frozen = cloneData(request);
  const workerId = game.user?.id;

  authority(frozen, workerId);

  /** Runs under a browser-origin lock when available, without claiming a server transaction. */
  const run = () => globalThis.navigator?.locks?.request
    ? navigator.locks.request(`${SESSION_MODULE}:sessions:${game.world?.id ?? "world"}`, () => execute(frozen, workerId))
    : execute(frozen, workerId);
  const result = tail.then(run);

  tail = result.then(() => undefined, () => undefined);

  return result;
}

/** Reads the live document after an acknowledgment failure to confirm exactly the intended save. */
async function confirmedWrite(write, confirm) {
  try {
    await write();
  } catch (error) {
    if (!confirm()) throw error;
  }

  if (!confirm()) throw new Error("The Session Notes save could not be confirmed. Retry the same operation.");
}

/** Rejects colliding receipt IDs rather than treating unrelated writes as successful retries. */
function receipt(journal, key, fingerprint) {
  const saved = readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[key];

  if (saved && saved.fingerprint !== fingerprint)
    throw new Error("Session operation ID was reused with different details.");

  return saved;
}

/** Creates a stable private folder without adopting an unrelated same-named document. */
async function ensureFolder(request, workerId) {
  const id = await sessionDocumentId("folder");

  authority(request, workerId);

  let folder = game.folders.get(id);

  if (!folder) {
    await confirmedWrite(() => CONFIG.Folder.documentClass.create({
      _id: id,
      name: "Session Notes",
      type: "JournalEntry",
      sorting: "a",
      flags: { [SESSION_MODULE]: { sessionNotesFolder: true } }
    }, { keepId: true }), () => Boolean(game.folders.get(id)));

    folder = game.folders.get(id);
  }
  if (folder.type !== "JournalEntry" || !readDocumentFlag(folder, SESSION_MODULE, "sessionNotesFolder")) {
    throw new Error("The Session Notes folder ID is already in use.");
  }

  return folder;
}

/** Persists only metadata and the matching receipt, never replacing editable Journal pages. */
async function updateSession(journal, data, key, fingerprint, request, workerId) {
  authority(request, workerId);

  const completion = { fingerprint, status: "complete", command: request.command };

  await confirmedWrite(() => journal.update({
    [`flags.${SESSION_MODULE}.${SESSION_FLAG}`]: globalThis._replace(data),
    [`flags.${SESSION_MODULE}.sessionOperations.${key}`]: completion
  }), () => receipt(journal, key, fingerprint)?.status === "complete");
}

/** Seeds all standard pages atomically with the Journal so a lost create reply is recoverable. */
function initialPages(data) {
  return [
    {
      role: "overview",
      name: "Overview",
      sort: 0,
      text: `<h1>${escapeHtml(data.title)}</h1><p>Party: ${data.party.map(actor => escapeHtml(actor.name)).join(", ") || "Not specified"}</p><p>Started: ${campaignLabel(data.startCampaign)}</p><p>Real start: ${new Date(data.startedAt).toISOString()}</p>`
    },
    {
      role: "review",
      name: "Review Notes",
      sort: 900000000,
      text: "<p>Add corrections, missing context, and unresolved questions here.</p>"
    },
    {
      role: "recap",
      name: "Recap",
      sort: 1000000000,
      text: "<p>Paste the finished read-aloud recap here.</p>"
    }
  ].map(page => ({
    name: page.name,
    sort: page.sort,
    type: "text",
    text: { content: page.text, format: 1 },
    ownership: { default: -1 },
    flags: { [SESSION_MODULE]: { [SESSION_FLAG]: { role: page.role } } }
  }));
}

/** Serializes initial creation using a deterministic successor ID shared by concurrent start attempts. */
async function startSession(request, workerId, requester, key, fingerprint) {
  const journals = sessionJournals();
  const predecessor = journals.at(-1);
  const active = journals.find(journal => sessionData(journal).state !== "ended");
  const id = await sessionDocumentId("session", request.predecessorId ?? null);

  authority(request, workerId);

  const existing = game.journal.get(id);

  if (existing) {
    if (!sessionData(existing)) throw new Error("The Session Notes Journal ID is already in use.");

    const created = sessionData(existing).creation;

    if (created.key === key && created.fingerprint === fingerprint) return { journalId: id };

    throw new Error("A session was already started. Open Session Notes and review it before starting another.");
  }
  if (active) throw new Error("A session is already active. End it before starting another.");
  if ((predecessor?.id ?? null) !== (request.predecessorId ?? null)) {
    throw new Error("The session history changed. Refresh Session Notes before starting another.");
  }

  const enteredTitle = String(request.title ?? "").trim();

  if (enteredTitle.length > 200) throw new Error("Session title must be at most 200 characters.");

  const number = String(request.number ?? "").trim();

  if (number.length > 30) throw new Error("Session number is too long.");
  if (!enteredTitle && !number) throw new Error("Enter a session title or a session number.");

  const title = enteredTitle || `Session ${number}`;
  const name = number && title !== `Session ${number}` ? `Session ${number} — ${title}` : title;
  const enteredTime = campaignTime(request.day, request.time);
  const party = [...new Set(request.partyIds ?? [])].map(actorId => {
    const actor = game.actors.get(actorId);

    if (!actor || actor.type !== "character") throw new Error("A selected party character no longer exists.");

    return { id: actor.id, name: actor.name, uuid: actor.uuid };
  });
  const current = await prepareSessionClock(request, workerId, { authority, confirmedWrite, ensureFolder }, enteredTime);
  const data = {
    kind: "session",
    schemaVersion: 1,
    generation: (sessionData(predecessor)?.generation ?? 0) + 1,
    title,
    number,
    party,
    state: "active",
    revision: 1,
    startedAt: Date.now(),
    endedAt: null,
    campaign: current,
    startCampaign: current,
    endCampaign: null,
    breaks: [],
    clockAnchorRevision: sessionClockState().anchorRevision,
    startedWorldTime: Number.isFinite(game.time?.worldTime) ? game.time.worldTime : null,
    creation: { key, fingerprint, requesterUserId: requester.id }
  };
  const folder = await ensureFolder(request, workerId);

  authority(request, workerId);
  await confirmedWrite(() => CONFIG.JournalEntry.documentClass.create({
    _id: id,
    name,
    folder: folder.id,
    ownership: { default: 0 },
    pages: initialPages(data),
    flags: { [SESSION_MODULE]: { [SESSION_FLAG]: data } }
  }, { keepId: true }), () => {
    const created = sessionData(game.journal.get(id))?.creation;

    return created?.key === key && created.fingerprint === fingerprint;
  });

  return { journalId: id };
}

/** Reserves a note before creating its stable page and keeps completed receipts after native deletion. */
async function saveNote(journal, request, workerId, requester, key, fingerprint) {
  const saved = receipt(journal, key, fingerprint);

  if (["complete", "deleted"].includes(saved?.status))
    return { journalId: journal.id, pageId: saved.pageId, deleted: !journal.pages.get(saved.pageId) };

  const data = sessionData(journal);

  if (data.state === "ended" && !request.addendum)
    throw new Error("This session has ended. Choose Add Addendum deliberately to add a late note.");

  const text = String(request.text ?? "");

  if (!text.trim() || text.length > 50000) throw new Error("Enter a note of 1–50,000 characters.");
  if (!NOTE_TYPES.includes(request.noteType)) throw new Error("Choose a valid note type.");

  await syncSessionClock(request, workerId, { authority, confirmedWrite, ensureFolder });

  const pageId = await sessionDocumentId("note", journal.id, key);

  authority(request, workerId);

  if (!saved) {
    const reservation = {
      fingerprint,
      status: "reserved",
      pageId,
      recordedAt: Date.now(),
      sort: Math.max(0, ...[...journal.pages].filter(page =>
        readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG)?.role === "event").map(page => page.sort ?? 0)) + 1000,
      campaign: request.addendum ? campaignTime(request.day, request.time) : cloneData(currentCampaign(data)),
      anchorRevision: sessionClockState()?.anchorRevision ?? null,
      worldTime: Number.isFinite(game.time?.worldTime) ? game.time.worldTime : null
    };

    await confirmedWrite(
      () => journal.update({ [`flags.${SESSION_MODULE}.sessionOperations.${key}`]: reservation }),
      () => receipt(journal, key, fingerprint)?.pageId === pageId
    );
  }

  const reservation = receipt(journal, key, fingerprint);
  const metadata = {
    role: "event",
    key,
    fingerprint,
    recordedAt: reservation.recordedAt,
    campaign: reservation.campaign,
    worldTime: reservation.worldTime,
    anchorRevision: reservation.anchorRevision,
    author: { id: requester.id, name: requester.name },
    noteType: request.noteType,
    important: Boolean(request.important),
    excluded: Boolean(request.excluded),
    playerSafe: Boolean(request.playerSafe),
    location: String(request.location ?? "").slice(0, 300),
    related: String(request.related ?? "").slice(0, 500),
    context: cloneData(request.context ?? {}),
    addendum: Boolean(request.addendum)
  };
  const existing = journal.pages.get(pageId);

  if (existing && readDocumentFlag(existing, SESSION_MODULE, SESSION_FLAG)?.fingerprint !== fingerprint) {
    throw new Error("The note page ID is already in use.");
  }
  if (!existing) {
    authority(request, workerId);
    await confirmedWrite(() => journal.createEmbeddedDocuments("JournalEntryPage", [{
      _id: pageId,
      name: `${request.noteType} — ${text.trim().split(/\r?\n/)[0].slice(0, 65)}`,
      type: "text",
      sort: reservation.sort,
      ownership: { default: -1 },
      text: { content: noteHtml(text), format: 1 },
      flags: { [SESSION_MODULE]: { [SESSION_FLAG]: metadata } }
    }], { keepId: true }), () => readDocumentFlag(journal.pages.get(pageId), SESSION_MODULE, SESSION_FLAG)?.fingerprint === fingerprint);
  }

  authority(request, workerId);
  await confirmedWrite(() => journal.update({
    [`flags.${SESSION_MODULE}.sessionOperations.${key}`]: {
      ...reservation,
      status: "complete"
    }
  }), () => receipt(journal, key, fingerprint)?.status === "complete");

  return { journalId: journal.id, pageId };
}

/** Dispatches F1 operations after fresh authorization, receipt validation, and stale-state checks. */
async function execute(request, workerId) {
  const requester = authority(request, workerId);

  if (typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(request.operationId)) {
    throw new Error("A valid session operation ID is required.");
  }

  const key = await sessionDocumentId("operation", requester.id, request.operationId);

  authority(request, workerId);

  const fingerprint = canonicalJson({ ...request, protocol: undefined, action: undefined });

  if (CLOCK_COMMANDS.has(request.command))
    return executeSessionClock(request, workerId, { authority, confirmedWrite, ensureFolder });
  if (request.command === "start") return startSession(request, workerId, requester, key, fingerprint);

  const journal = game.journal.get(request.journalId);
  const original = sessionData(journal);

  if (!original && !(request.command === "forget-note" && readDocumentFlag(journal, SESSION_MODULE, "campaignClock")))
    throw new Error("The Session Notes Journal no longer exists.");
  if (request.command === "note") return saveNote(journal, request, workerId, requester, key, fingerprint);
  if (request.command === "forget-note") {
    const saved = readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[request.receiptKey];

    if (!saved || saved.pageId !== request.pageId || journal.pages.has(request.pageId)) {
      throw new Error("The deleted note's original save receipt could not be verified.");
    }

    authority(request, workerId);
    await confirmedWrite(() => journal.update({
      [`flags.${SESSION_MODULE}.sessionOperations.${request.receiptKey}`]: {
        ...saved,
        status: "deleted"
      }
    }), () => readDocumentFlag(journal, SESSION_MODULE, "sessionOperations")?.[request.receiptKey]?.status === "deleted");

    return { journalId: journal.id };
  }
  if (receipt(journal, key, fingerprint)?.status === "complete") return { journalId: journal.id };

  await syncSessionClock(request, workerId, { authority, confirmedWrite, ensureFolder });
  if (request.revision !== original.revision)
    throw new Error("The session changed. Refresh and review its current state before trying again.");

  const data = cloneData(original);

  data.campaign = currentCampaign(original);
  if (request.command === "pause" && data.state === "active") {
    data.state = "paused";
    data.breaks.push({
      start: Date.now(),
      end: null,
      campaignStart: data.campaign,
      worldStart: game.time.worldTime
    });
  } else if (request.command === "resume" && data.state === "paused") {
    data.state = "active";
    data.breaks.at(-1).end = Date.now();
    Object.assign(data.breaks.at(-1), {
      campaignEnd: data.campaign,
      worldEnd: game.time.worldTime,
      outsideWorldSeconds: game.time.worldTime - (data.breaks.at(-1).worldStart ?? game.time.worldTime)
    });
  } else if (request.command === "end" && data.state !== "ended") {
    data.state = "ended";
    data.endedAt = Date.now();
    data.endedWorldTime = Number.isFinite(game.time?.worldTime) ? game.time.worldTime : null;
    data.endCampaign = cloneData(data.campaign);
    if (data.breaks.at(-1)?.end === null)
      Object.assign(data.breaks.at(-1), {
        end: data.endedAt,
        campaignEnd: data.campaign,
        worldEnd: game.time.worldTime,
        outsideWorldSeconds: game.time.worldTime - (data.breaks.at(-1).worldStart ?? game.time.worldTime)
      });
  } else throw new Error("That action is not available for the session's current state.");

  data.revision++;
  await updateSession(journal, data, key, fingerprint, request, workerId);

  return { journalId: journal.id };
}
