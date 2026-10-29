import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");

globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;

const notices = [];
const dialogs = [];
const registrations = new Map();
const menus = new Map();
const values = new Map();
const callbacks = new Map();
const writes = [];
let failBeforePage = false;
let failAfterPage = false;
let failCompletion = false;
let failJournalAck = false;
let advanceFailure = null;
const advanceCalls = [];

class Collection extends Map {
  [Symbol.iterator]() {
    return this.values();
  }

  get contents() {
    return [...this.values()];
  }
}

function id() {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function applyPaths(target, update) {
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    let destination = target;

    for (const part of parts.slice(0, -1)) destination = destination[part] ??= {};

    destination[parts.at(-1)] = structuredClone(value);
  }
}

function emit(name, ...args) {
  for (const { hook, fn } of callbacks.values()) if (hook === name) fn(...args);
}

function doc(data, parent = null) {
  const result = {
    ...structuredClone(data),
    id: data._id ?? id(),
    parent,
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update(change) {
      writes.push({ id: this.id, change: structuredClone(change) });

      if (failCompletion && Object.values(change).some(value => value?.status === "complete")) {
        failCompletion = false;

        throw new Error("Completion receipt unavailable");
      }

      applyPaths(this, change);
      emit(parent ? "updateJournalEntryPage" : "updateJournalEntry", this);

      return this;
    }
  };

  result.uuid = parent ? `${parent.uuid}.JournalEntryPage.${result.id}` : `JournalEntry.${result.id}`;
  result.sheet = {
    render: (...args) => {
      result.opened = args;
    }
  };

  return result;
}

class TestDialog extends dom.window.EventTarget {
  constructor(options) {
    super();
    assert.equal(options.content.tagName, "DIV");
    assert.equal(options.content.attributes.length, 0);
    this.options = options;
    this.element = document.createElement("section");

    const form = document.createElement("form");

    form.innerHTML = options.content.innerHTML;

    for (const config of options.buttons) {
      const button = document.createElement("button");

      button.type = "button";
      button.dataset.action = config.action;
      button.textContent = config.label;
      button.addEventListener("click", event => {
        this.submission = config.callback?.(event, button, this);
      });

      form.append(button);
    }

    this.element.append(form);
    dialogs.push(this);
  }

  async render() {
    this.rendered = true;
    document.body.append(this.element);
    this.dispatchEvent(new Event("render"));

    return this;
  }

  async close() {
    this.rendered = false;
    this.element.remove();
    this.dispatchEvent(new Event("close"));
  }

  bringToFront() {
    this.focused = true;
  }

  async submit(action) {
    return this.options.buttons.find(button => button.action === action).callback?.(
      null,
      this.element.querySelector(`[data-action="${action}"]`),
      this
    );
  }
}
globalThis.Hooks = {
  callAll: emit,
  on(hook, fn) {
    const key = Symbol(hook);

    callbacks.set(key, { hook, fn });

    return key;
  },
  off(_hook, key) {
    callbacks.delete(key);
  }
};

globalThis._replace = value => value;
globalThis.foundry = { applications: { api: { DialogV2: TestDialog } } };
globalThis.ui = { notifications: Object.fromEntries(["info", "warn", "error"].map(level => [level, message => notices.push({ level, message })])) };
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      async writeText(text) {
        navigator.clipboard.text = text;
      }
    }
  }
});

globalThis.CONFIG = {
  Folder: {
    documentClass: {
      async create(data, options) {
        assert.equal(options.keepId, true);
        if (game.folders.has(data._id)) throw new Error("Folder duplicate ID");

        const folder = doc(data);

        game.folders.set(folder.id, folder);

        return folder;
      }
    }
  },
  JournalEntry: {
    documentClass: {
      async create(data, options) {
        assert.equal(options.keepId, true);
        if (game.journal.has(data._id)) throw new Error("Journal duplicate ID");

        const journal = doc({ ...data, pages: undefined });

        journal.pages = new Collection(data.pages.map(page => {
          const value = doc(page, journal);

          return [value.id, value];
        }));

        journal.createEmbeddedDocuments = async (_type, entries, options) => {
          assert.equal(options.keepId, true);
          if (failBeforePage) throw new Error("Page write unavailable");

          const pages = entries.map(entry => {
            if (journal.pages.has(entry._id)) throw new Error("Page duplicate ID");

            const page = doc(entry, journal);

            journal.pages.set(page.id, page);

            return page;
          });

          if (failAfterPage) {
            failAfterPage = false;

            throw new Error("Page acknowledgment lost");
          }

          return pages;
        };

        game.journal.set(journal.id, journal);
        emit("createJournalEntry", journal);

        if (failJournalAck) {
          failJournalAck = false;

          throw new Error("Journal acknowledgment lost");
        }

        return journal;
      }
    }
  }
};

const M = "pf2e-zone-automation";
const { executeSessionNotes } = await import("../scripts/session-notes-repository.js");
const { sessionData, sessionJournals, sessionNotesPackage, visibleNoteActors, appendActorName } = await import("../scripts/session-notes-data.js");
const { openSessionNotes, openQuickNote, registerSessionNotesHooks } = await import("../scripts/session-notes.js");
const { registerSessionNotesSettings, registerSessionNotesSettingsUI, DEFAULT_RECAP_PROMPT, openRecapPrompt } = await import("../scripts/session-notes-settings.js");
const { registerSessionClockHooks, promptAdvanceSessionTime } = await import("../scripts/session-notes-clock.js");
const { sessionClockState, currentCampaign, campaignAt, campaignLabel, previewAdvance } = await import("../scripts/session-clock-data.js");

async function reset() {
  for (const dialog of dialogs) if (dialog.rendered) await dialog.close();

  assert.equal(callbacks.size, 0, "Closed Quick Note windows release every listener");
  dialogs.length = notices.length = writes.length = 0;
  registrations.clear();
  menus.clear();
  values.clear();
  failBeforePage = failAfterPage = failCompletion = failJournalAck = false;
  advanceFailure = null;
  advanceCalls.length = 0;

  const gm = {
    id: "gm",
    name: "GM",
    isGM: true,
    active: true
  };

  globalThis.game = {
    user: gm,
    users: new Collection([[gm.id, gm], ["player", {
      id: "player",
      name: "Player",
      active: true,
      isGM: false
    }]]),
    system: { id: "pf2e" },
    world: { id: "session-test" },
    journal: new Collection(),
    folders: new Collection(),
    actors: new Collection([["mira", {
      id: "mira",
      uuid: "Actor.mira",
      name: "Mira",
      type: "character"
    }]]),
    time: {
      worldTime: 1234,
      async advance(seconds, options = {}) {
        advanceCalls.push({ seconds, options: structuredClone(options) });

        if (advanceFailure === "before") {
          advanceFailure = null;

          throw new Error("Clock request interrupted before applying");
        }

        this.worldTime += seconds;
        emit("updateWorldTime", this.worldTime, seconds, options, "gm");

        if (advanceFailure === "after") {
          advanceFailure = null;

          throw new Error("Clock acknowledgment lost");
        }

        return this.worldTime;
      }
    },
    settings: {
      register(scope, key, config) {
        registrations.set(`${scope}.${key}`, config);
      },
      registerMenu(scope, key, config) {
        menus.set(`${scope}.${key}`, config);
      },
      get(scope, key) {
        return values.get(`${scope}.${key}`) ?? registrations.get(`${scope}.${key}`)?.default;
      },
      async set(scope, key, value) {
        if (!game.user.isGM) throw new Error("No permission");

        values.set(`${scope}.${key}`, value);
        registrations.get(`${scope}.${key}`)?.onChange?.(value);
      }
    }
  };

  game.users.activeGM = gm;
  globalThis.canvas = { ready: false, tokens: { controlled: [], placeables: [] } };
  navigator.clipboard.text = "";
  registerSessionNotesSettings();
  await game.settings.set(M, "sessionNotesEnabled", true);
}

function operation(command, details = {}) {
  return {
    protocol: 1,
    action: "session-notes",
    requesterUserId: "gm",
    command,
    operationId: randomUUID(),
    ...details
  };
}

async function start(details = {}) {
  const request = operation("start", {
    predecessorId: sessionJournals().at(-1)?.id ?? null,
    title: "The Old Mill",
    number: "24",
    day: 42,
    time: "15:40",
    partyIds: ["mira"],
    ...details
  });
  const result = await executeSessionNotes(request);

  return { journal: game.journal.get(result.journalId), request };
}

function note(journal, details = {}) {
  return operation("note", {
    journalId: journal.id,
    text: "Mira kept the original ledger.\nThe captain took a copy.",
    noteType: "Decision",
    important: true,
    location: "Old Mill",
    context: { worldTime: 1234 },
    ...details
  });
}

function lifecycle(journal, command, details = {}) {
  return operation(command, { journalId: journal.id, revision: sessionData(journal).revision, ...details });
}

function events(journal) {
  return [...journal.pages].filter(page => page.getFlag(M, "sessionNotes")?.role === "event");
}

function field(dialog, name) {
  return dialog.element.querySelector(`[name="${name}"]`);
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;

    await new Promise(resolve => setTimeout(resolve, 2));
  }

  throw new Error("UI action did not finish");
}

function clockOperation(command, details = {}) {
  return operation(command, { clockRevision: sessionClockState()?.revision, expectedWorldTime: game.time.worldTime, ...details });
}

function clockEvents(journal) {
  return events(journal).filter(page => page.getFlag(M, "sessionNotes").clock);
}

async function drainClock() {
  return executeSessionNotes(operation("clock-sync"));
}

test("clock arithmetic preserves campaign numbering, exact seconds, midnight rollover, and future-only targets", async () => {
  await reset();

  const anchor = { day: 42, time: "23:50", worldTime: 100 };

  assert.deepEqual(campaignAt(anchor, 1300), { day: 43, time: "00:10" });
  assert.deepEqual(campaignAt({ day: 0, time: "09:10", worldTime: 100 }, 706), { day: 0, time: "09:20", second: 6 });
  assert.match(campaignLabel(campaignAt(anchor, 106)), /11:50:06 PM/);
  assert.equal(previewAdvance({ anchor }, 100, { mode: "until", day: 43, time: "07:50" }).seconds, 28800);
  assert.throws(
    () => previewAdvance({ anchor }, 100, { mode: "until", day: 42, time: "10:00" }),
    /positive duration or a future/
  );

  assert.throws(() => previewAdvance({ anchor }, 100, { seconds: -600 }), /positive duration/);
});

test("three ten-minute blocks save one explained interval and retries or duplicated clock hooks never advance again", async () => {
  await reset();

  const { journal } = await start({ day: 42, time: "09:10" });
  const stop = registerSessionClockHooks();

  try {
    await drainClock();

    const request = clockOperation("advance-clock", {
      seconds: 1800,
      activity: "Searching",
      explanation: "Searching the mill while others heal",
      participantIds: ["mira"]
    });

    await Promise.all([executeSessionNotes(request), executeSessionNotes(request)]);
    await drainClock();
    assert.equal(game.time.worldTime, 3034);
    assert.equal(advanceCalls.length, 1);
    assert.deepEqual(currentCampaign(), { day: 42, time: "09:40" });
    assert.equal(clockEvents(journal).length, 1);

    const page = clockEvents(journal)[0], metadata = page.getFlag(M, "sessionNotes");

    assert.equal(metadata.clock.seconds, 1800);
    assert.equal(metadata.clock.participants[0].name, "Mira");
    assert.match(page.text.content, /Searching the mill while others heal/);
    assert.equal(metadata.clock.worldStart, 1234);
    assert.equal(metadata.clock.worldEnd, 3034);
    emit("updateWorldTime", 3034, 1800, advanceCalls[0].options, "gm");
    await drainClock();
    await executeSessionNotes(request);
    assert.equal(advanceCalls.length, 1);
    assert.equal(clockEvents(journal).length, 1);
    assert.match(sessionNotesPackage(journal, "Prompt"), /30 minutes advanced/);
  } finally {
    stop();
  }
});

test("simultaneous tasks occupy one interval, sequential tasks occupy two, and travel rolls over Days", async () => {
  await reset();

  const { journal } = await start({ day: 42, time: "23:50" });

  await executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Healing", explanation: "Mira heals while Orin searches." }));
  await executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Exploring" }));
  assert.deepEqual(currentCampaign(), { day: 43, time: "00:10" });
  assert.equal(clockEvents(journal).length, 2);
  assert.equal(advanceCalls.length, 2);
  await executeSessionNotes(clockOperation("advance-clock", { seconds: 2.5 * 86400, activity: "Travel" }));
  assert.deepEqual(currentCampaign(), { day: 45, time: "12:10" });
  await executeSessionNotes(clockOperation("advance-clock", {
    mode: "until",
    day: 46,
    time: "07:00",
    activity: "Rest"
  }));

  assert.deepEqual(currentCampaign(), { day: 46, time: "07:00" });
  assert.equal(clockEvents(journal).at(-1).getFlag(M, "sessionNotes").clock.seconds, 67800);
});

test("external combat seconds and rewinds are observed once and never rounded, relabeled, or reordered", async () => {
  await reset();

  const { journal } = await start({ day: 42, time: "09:10" });
  const stop = registerSessionClockHooks();

  try {
    await drainClock();
    await game.time.advance(6);
    await drainClock();

    const first = clockEvents(journal)[0];

    assert.equal(first.getFlag(M, "sessionNotes").clock.seconds, 6);
    await executeSessionNotes(note(journal));

    const manual = events(journal).find(page => !page.getFlag(M, "sessionNotes").clock);

    assert.equal(manual.getFlag(M, "sessionNotes").campaign.second, 6);

    const worldBeforeNote = game.time.worldTime;

    await executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Roleplaying" }));
    await drainClock();
    assert.equal(game.time.worldTime, worldBeforeNote + 600);
    assert.deepEqual(currentCampaign(), { day: 42, time: "09:20", second: 6 });
    await game.time.advance(-60);
    await drainClock();

    const rewind = clockEvents(journal).at(-1);

    assert.equal(rewind.getFlag(M, "sessionNotes").clock.kind, "rewind");
    assert.ok(rewind.sort > first.sort);
    assert.deepEqual(manual.getFlag(M, "sessionNotes").campaign, { day: 42, time: "09:10", second: 6 });
    assert.match(sessionNotesPackage(journal, "Prompt"), /6 seconds|seconds/);
  } finally {
    stop();
  }
});

test("display corrections record before/after and explanation without world advances or changes to old notes", async () => {
  await reset();

  const { journal } = await start({ day: 0, time: "09:10" });

  await executeSessionNotes(note(journal));

  const manual = events(journal)[0];

  manual.text.content = "<p>My own corrected narrative.</p>";

  const original = structuredClone(manual.getFlag(M, "sessionNotes"));

  await executeSessionNotes(clockOperation("set-clock", { day: 42, time: "15:40", reason: "Restore our established campaign Day." }));
  assert.equal(game.time.worldTime, 1234);
  assert.equal(advanceCalls.length, 0);
  assert.equal(sessionClockState().anchorRevision, 2);
  assert.deepEqual(currentCampaign(), { day: 42, time: "15:40" });
  assert.deepEqual(manual.getFlag(M, "sessionNotes"), original);
  assert.equal(manual.text.content, "<p>My own corrected narrative.</p>");

  const correction = clockEvents(journal)[0].getFlag(M, "sessionNotes").clock;

  assert.deepEqual(correction.start, { day: 0, time: "09:10" });
  assert.equal(correction.seconds, 0);
  assert.equal(correction.explanation, "Restore our established campaign Day.");
});

test("paused and between-session changes are outside play, breaks snapshot campaign clocks, and next sessions carry seconds", async () => {
  await reset();

  const { journal } = await start();
  const stop = registerSessionClockHooks();

  try {
    await drainClock();
    await executeSessionNotes(lifecycle(journal, "pause"));
    await game.time.advance(606);
    await drainClock();
    assert.equal(clockEvents(journal)[0].getFlag(M, "sessionNotes").clock.outsidePlay, true);
    await executeSessionNotes(lifecycle(journal, "resume"));

    const recordedBreak = sessionData(journal).breaks[0];

    assert.equal(recordedBreak.worldStart, 1234);
    assert.equal(recordedBreak.worldEnd, 1840);
    assert.equal(recordedBreak.outsideWorldSeconds, 606);
    assert.equal(recordedBreak.campaignEnd.second, 6);
    await executeSessionNotes(lifecycle(journal, "end"));

    const ended = structuredClone(sessionData(journal));

    await game.time.advance(3600);
    await drainClock();
    assert.deepEqual(sessionData(journal), ended);

    const history = [...game.journal].find(entry => entry.getFlag(M, "campaignClock"));

    assert.ok(history);
    assert.equal(history.ownership.default, 0);
    assert.equal(clockEvents(history)[0].getFlag(M, "sessionNotes").clock.outsidePlay, true);

    const next = await start({ number: "25", day: 42, time: "16:50" });

    assert.equal(sessionData(next.journal).startCampaign.second, 6);
  } finally {
    stop();
  }
});

test("a lost advance acknowledgment recovers from tagged hook provenance after reload without a second advance", async () => {
  await reset();

  const { journal } = await start();
  const stop = registerSessionClockHooks();

  try {
    await drainClock();
    advanceFailure = "after";

    const request = clockOperation("advance-clock", { seconds: 600, activity: "Exploring" });

    await assert.rejects(executeSessionNotes(request), /acknowledgment lost/);
    await drainClock();
    assert.equal(sessionClockState().pending, null);

    const reloaded = await import(`../scripts/session-notes-repository.js?clock-reload=${randomUUID()}`);

    await reloaded.executeSessionNotes(request);
    assert.equal(advanceCalls.length, 1);
    assert.equal(clockEvents(journal).length, 1);
    assert.equal(clockEvents(journal)[0].getFlag(M, "sessionNotes").clock.kind, "activity");
  } finally {
    stop();
  }
});

test("an unproven dispatch requires explicit reconciliation; retry never blindly sends another advance", async () => {
  await reset();

  const { journal } = await start();

  advanceFailure = "after";

  const request = clockOperation("advance-clock", { seconds: 600, activity: "Travel" });

  await assert.rejects(executeSessionNotes(request), /acknowledgment lost/);

  const pendingId = sessionClockState().pending.id;

  await assert.rejects(executeSessionNotes(request), /uncertain.*Reconcile/);
  await assert.rejects(
    executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Rest" })),
    /needs reconciliation/
  );

  assert.equal(advanceCalls.length, 1);
  assert.equal(clockEvents(journal).length, 0);
  await executeSessionNotes(operation("reconcile-clock", { pendingId, resolution: "applied", reason: "Verified the clock advanced ten minutes." }));
  assert.equal(advanceCalls.length, 1);
  assert.equal(clockEvents(journal).length, 1);
  assert.equal(clockEvents(journal)[0].getFlag(M, "sessionNotes").clock.reconciled, true);
  await executeSessionNotes(request);
  assert.equal(advanceCalls.length, 1);
});

test("a request interrupted before applying can be cancelled explicitly, then advanced with a new operation", async () => {
  await reset();

  const { journal } = await start();

  advanceFailure = "before";

  const request = clockOperation("advance-clock", { seconds: 600, activity: "Other" });

  await assert.rejects(executeSessionNotes(request), /before applying/);
  assert.equal(game.time.worldTime, 1234);
  await executeSessionNotes(operation("reconcile-clock", {
    pendingId: sessionClockState().pending.id,
    resolution: "not-applied",
    reason: "Confirmed the shared clock is still at the original time."
  }));

  await executeSessionNotes(request);
  assert.equal(advanceCalls.length, 1);
  await executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Other" }));
  assert.equal(game.time.worldTime, 1834);
  assert.equal(advanceCalls.length, 2);
  assert.equal(clockEvents(journal).length, 2);
});

test("Journal failure after a successful advance retains a durable event; retry preserves native edits and deletion", async () => {
  await reset();

  const { journal } = await start();

  failCompletion = true;

  const request = clockOperation("advance-clock", { seconds: 600, activity: "Searching" });

  await assert.rejects(executeSessionNotes(request), /Completion receipt unavailable/);
  assert.equal(game.time.worldTime, 1834);
  assert.equal(sessionClockState().events.length, 1);

  const page = clockEvents(journal)[0];

  page.text.content = "<p>Manually edited interval.</p>";
  await executeSessionNotes(request);
  assert.equal(advanceCalls.length, 1);
  assert.equal(sessionClockState().events.length, 0);
  assert.equal(page.text.content, "<p>Manually edited interval.</p>");
  journal.pages.delete(page.id);
  await executeSessionNotes(request);
  assert.equal(clockEvents(journal).length, 0);
  assert.equal(advanceCalls.length, 1);
});

test("disconnected recording recovers a marked gap, retains its anchor across reload, and never reassigns past event labels", async () => {
  await reset();

  const { journal } = await start();

  await executeSessionNotes(note(journal));

  const original = structuredClone(events(journal)[0].getFlag(M, "sessionNotes"));

  game.time.worldTime += 3606;

  const reloaded = await import(`../scripts/session-notes-repository.js?gap-reload=${randomUUID()}`);

  await reloaded.executeSessionNotes(operation("clock-sync"));

  const gap = clockEvents(journal)[0].getFlag(M, "sessionNotes").clock;

  assert.equal(gap.kind, "gap");
  assert.equal(gap.outsidePlay, true);
  assert.equal(gap.seconds, 3606);
  assert.deepEqual(events(journal)[0].getFlag(M, "sessionNotes"), original);
  assert.deepEqual(currentCampaign(), { day: 42, time: "16:40", second: 6 });
});

test("clock mutations reject stale previews, players, disabled features, and an authority change before dispatch", async () => {
  await reset();
  await start();

  const stale = clockOperation("advance-clock", { seconds: 600, activity: "Searching" });

  await executeSessionNotes(clockOperation("set-clock", { day: 42, time: "17:00", reason: "Correction" }));
  await assert.rejects(executeSessionNotes(stale), /clock changed/);
  game.user = game.users.get("player");
  await assert.rejects(
    async () => executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Other" })),
    /Only a GM/
  );

  await assert.rejects(promptAdvanceSessionTime(), /Only a GM/);
  game.user = game.users.get("gm");

  const originalSet = game.settings.set;

  game.settings.set = async (...args) => {
    const result = await originalSet(...args);

    if (args[1] === "sessionClock" && args[2]?.pending?.status === "dispatching")
      game.users.activeGM = { id: "other-gm" };

    return result;
  };

  await assert.rejects(executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Other" })), /Only a GM/);
  assert.equal(advanceCalls.length, 0);
  game.users.activeGM = game.user;
  await game.settings.set(M, "sessionNotesEnabled", false);
  await assert.rejects(promptAdvanceSessionTime(), /Enable Session Notes/);
});

test("Advance Time focuses one window, previews blocks and custom travel, and closes only after saving the interval", async () => {
  await reset();

  const { journal } = await start({ day: 42, time: "09:10" });
  const [dialog, same] = await Promise.all([promptAdvanceSessionTime(), promptAdvanceSessionTime()]);

  assert.equal(same, dialog);
  assert.equal(dialogs.filter(entry => entry.rendered).length, 1);
  field(dialog, "blocks").value = "3";
  field(dialog, "blocks").dispatchEvent(new Event("input", { bubbles: true }));
  assert.match(dialog.element.querySelector("[data-clock-preview]").textContent, /9:10 AM.*9:40 AM.*30 minutes/);
  assert.equal(game.time.worldTime, 1234);
  field(dialog, "activity").value = "Searching";
  field(dialog, "explanation").value = "Searching while Mira heals";
  await dialog.submit("save");
  assert.equal(dialog.rendered, false);
  assert.equal(advanceCalls.length, 1);
  assert.equal(clockEvents(journal).length, 1);

  const travel = await promptAdvanceSessionTime();

  field(travel, "clock-mode").value = "custom";
  field(travel, "clock-mode").dispatchEvent(new Event("change", { bubbles: true }));
  field(travel, "custom-duration").value = "2.5";
  field(travel, "custom-unit").value = "3600";
  field(travel, "activity").value = "Travel";
  field(travel, "custom-duration").dispatchEvent(new Event("input", { bubbles: true }));
  assert.match(travel.element.querySelector("[data-clock-preview]").textContent, /12:10 PM.*2 hours 30 minutes/);
  await travel.submit("save");

  const reopened = await promptAdvanceSessionTime();

  assert.equal(field(reopened, "activity").value, "Travel");
  await reopened.close();
  assert.equal(callbacks.size, 0);
});

test("Advance Until rejects a past target and permits a corrected preview; external updates preserve the activity draft", async () => {
  await reset();
  await start({ day: 42, time: "23:50" });

  const dialog = await promptAdvanceSessionTime();

  field(dialog, "clock-mode").value = "until";
  field(dialog, "day").value = "42";
  field(dialog, "time").value = "10:00";
  await dialog.submit("save");
  assert.equal(advanceCalls.length, 0);
  assert.equal(dialog.rendered, true);
  assert.equal(field(dialog, "day").disabled, false);
  field(dialog, "day").value = "43";
  field(dialog, "time").value = "00:10";
  field(dialog, "explanation").value = "Arrive at the inn";
  field(dialog, "time").dispatchEvent(new Event("input", { bubbles: true }));
  assert.match(dialog.element.querySelector("[data-clock-preview]").textContent, /20 minutes/);
  game.time.worldTime += 6;
  emit("updateWorldTime", game.time.worldTime, 6, {}, "gm");
  assert.equal(field(dialog, "explanation").value, "Arrive at the inn");
  assert.match(dialog.element.querySelector("[data-clock-preview]").textContent, /19 minutes 54 seconds/);
  await dialog.submit("save");
  // The missed observation is first recorded as a gap and invalidates that stale anchor revision.
  assert.equal(advanceCalls.length, 0);
  await dialog.close();

  const fresh = await promptAdvanceSessionTime();

  await fresh.close();
});

test("the clock window requires explicit reconciliation and closes when the feature is disabled", async () => {
  await reset();
  await start();

  const dialog = await promptAdvanceSessionTime();

  advanceFailure = "after";
  await dialog.submit("save");
  assert.equal(advanceCalls.length, 1);
  assert.equal(dialog.rendered, true);
  assert.equal(dialog.element.querySelector("[data-clock-reconcile]").hidden, false);
  await dialog.submit("save");
  assert.equal(advanceCalls.length, 1);
  field(dialog, "resolution").value = "applied";
  field(dialog, "resolution-reason").value = "Verified the ten-minute change.";
  await dialog.submit("save");
  assert.equal(dialog.rendered, false);
  assert.equal(advanceCalls.length, 1);

  const reopened = await promptAdvanceSessionTime();

  await game.settings.set(M, "sessionNotesEnabled", false);
  await waitUntil(() => !reopened.rendered);
  await reopened.submit("save");
  assert.equal(advanceCalls.length, 1);
  assert.equal(callbacks.size, 0);
});

test("a clock can be initialized and advanced between sessions without inventing a session", async () => {
  await reset();

  const dialog = await promptAdvanceSessionTime();

  assert.equal(field(dialog, "clock-mode").value, "set");
  field(dialog, "day").value = "0";
  field(dialog, "time").value = "09:10";
  await dialog.submit("save");
  assert.equal(sessionClockState(), null);
  field(dialog, "reason").value = "Begin using our campaign Day count.";
  await dialog.submit("save");
  assert.equal(advanceCalls.length, 0);
  assert.equal(sessionJournals().length, 0);
  await executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Other", explanation: "Downtime" }));
  assert.equal(sessionJournals().length, 0);
  assert.equal(game.journal.size, 1);
  assert.equal([...game.journal][0].getFlag(M, "campaignClock"), true);

  const setup = await openSessionNotes();

  assert.equal(field(setup, "day").value, "0");
  assert.equal(field(setup, "time").value, "09:20");
  await setup.close();
});

test("historical time corrections change only the chosen event label, preserve native text, and keep an audit record", async () => {
  await reset();

  const { journal } = await start();

  await executeSessionNotes(note(journal));

  const page = events(journal)[0];

  page.text.content = "<p>My edited historical note.</p>";

  const before = structuredClone(page.getFlag(M, "sessionNotes").campaign);

  await executeSessionNotes(lifecycle(journal, "end"));

  const ended = structuredClone(sessionData(journal));
  const anchor = structuredClone(sessionClockState().anchor);
  const dialog = await promptAdvanceSessionTime({ mode: "event", journalId: journal.id });

  assert.equal(field(dialog, "day").value, "42");
  assert.equal(field(dialog, "time").value, "15:40");
  field(dialog, "day").value = "41";
  field(dialog, "time").value = "18:00";
  field(dialog, "reason").value = "This note describes the previous evening.";
  field(dialog, "time").dispatchEvent(new Event("input", { bubbles: true }));
  await dialog.submit("save");
  assert.equal(dialog.rendered, false);
  assert.equal(game.time.worldTime, 1234);
  assert.equal(advanceCalls.length, 0);
  assert.deepEqual(sessionClockState().anchor, anchor);
  assert.deepEqual(sessionData(journal), ended);
  assert.equal(page.text.content, "<p>My edited historical note.</p>");

  const metadata = page.getFlag(M, "sessionNotes");

  assert.deepEqual(metadata.campaign, { day: 41, time: "18:00" });
  assert.deepEqual(metadata.timeCorrections[0].before, before);
  assert.equal(clockEvents(journal).at(-1).getFlag(M, "sessionNotes").clock.kind, "event-time-correction");
  assert.match(sessionNotesPackage(journal, "Prompt"), /Day 41, 6:00 PM/);
});

test("persisted clock provenance survives a setting-write failure after the world was advanced", async () => {
  await reset();

  const { journal } = await start();
  const originalSet = game.settings.set;
  let failed = false;

  game.settings.set = async (...args) => {
    if (!failed && args[1] === "sessionClock" && args[2]?.pending?.status === "applied") {
      failed = true;

      throw new Error("Cannot persist applied clock provenance");
    }

    return originalSet(...args);
  };

  const request = clockOperation("advance-clock", { seconds: 600, activity: "Rest" });

  await assert.rejects(executeSessionNotes(request), /Cannot persist/);
  await assert.rejects(executeSessionNotes(request), /uncertain.*Reconcile/);
  assert.equal(advanceCalls.length, 1);

  const proof = advanceCalls[0].options.pf2eZoneSessionClock;

  await executeSessionNotes(operation("observe-clock", { worldTime: game.time.worldTime, delta: 600, provenance: proof }));
  await executeSessionNotes(request);
  assert.equal(clockEvents(journal).length, 1);
  assert.equal(advanceCalls.length, 1);
});

test("migrating an F1 session anchors its last saved Day/time now without inventing missed elapsed time or rewriting notes", async () => {
  await reset();

  const { journal } = await start();

  await executeSessionNotes(note(journal));

  const original = [...journal.pages].map(page => ({ id: page.id, text: page.text.content, flags: structuredClone(page.flags) }));
  const startedAt = sessionData(journal).startedAt, startedWorldTime = sessionData(journal).startedWorldTime;

  values.delete(`${M}.sessionClock`);
  game.time.worldTime += 86400;
  await drainClock();
  assert.equal(sessionClockState().initialization.source, "legacy-session");
  assert.deepEqual(currentCampaign(), { day: 42, time: "15:40" });
  assert.equal(sessionClockState().anchor.worldTime, game.time.worldTime);
  assert.equal(sessionData(journal).startedAt, startedAt);
  assert.equal(sessionData(journal).startedWorldTime, startedWorldTime);
  assert.deepEqual(
    [...journal.pages].map(page => ({ id: page.id, text: page.text.content, flags: page.flags })),
    original
  );
});

test("an external clock change during provenance reservation prevents dispatch from an outdated preview", async () => {
  await reset();
  await start();

  const originalSet = game.settings.set;
  let changed = false;

  game.settings.set = async (...args) => {
    const result = await originalSet(...args);

    if (!changed && args[1] === "sessionClock" && args[2]?.pending?.status === "dispatching") {
      changed = true;
      game.time.worldTime += 6;
    }

    return result;
  };

  await assert.rejects(
    executeSessionNotes(clockOperation("advance-clock", { seconds: 600, activity: "Searching" })),
    /World time changed before dispatch/
  );

  assert.equal(advanceCalls.length, 0);
  assert.equal(game.time.worldTime, 1240);
});

test("deleting an interval before its completion receipt is saved leaves a tombstone and never advances or recreates it", async () => {
  await reset();

  const { journal } = await start();

  registerSessionNotesHooks();

  try {
    failCompletion = true;

    const request = clockOperation("advance-clock", { seconds: 600, activity: "Healing" });

    await assert.rejects(executeSessionNotes(request), /Completion receipt unavailable/);

    const page = clockEvents(journal)[0];

    journal.pages.delete(page.id);
    emit("deleteJournalEntryPage", page);
    await drainClock();
    await executeSessionNotes(request);
    assert.equal(clockEvents(journal).length, 0);
    assert.equal(advanceCalls.length, 1);
    assert.equal(journal.getFlag(M, "sessionOperations")[page.getFlag(M, "sessionNotes").key].status, "deleted");
  } finally {
    callbacks.clear();
  }
});

test("F1 creates private, versioned session Journals with exactly the three standard pages and no prompt page", async () => {
  await reset();

  const { journal } = await start();

  assert.equal(journal.ownership.default, 0);
  assert.deepEqual([...journal.pages].map(page => page.name), ["Overview", "Review Notes", "Recap"]);
  assert.equal(sessionData(journal).campaign.time, "15:40");
  assert.equal(sessionData(journal).party[0].name, "Mira");
  assert.equal(game.folders.size, 1);
  assert.equal(game.settings.get(M, "sessionRecapPrompt"), DEFAULT_RECAP_PROMPT);
});

test("concurrent session starts, late retries, and repository reloads cannot create a second active session", async () => {
  await reset();

  const request = operation("start", {
    title: "Mill",
    day: 0,
    time: "09:00",
    predecessorId: null
  });
  const other = { ...request, operationId: randomUUID(), title: "Different title" };
  const results = await Promise.allSettled([executeSessionNotes(request), executeSessionNotes(request), executeSessionNotes(other)]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "rejected");
  assert.equal(game.journal.size, 1);

  const reloaded = await import(`../scripts/session-notes-repository.js?reload=${id()}`);

  assert.deepEqual(await reloaded.executeSessionNotes(request), results[0].value);
  await assert.rejects(executeSessionNotes({ ...request, title: "Changed retry" }), /already started/);
});

test("a lost Journal creation acknowledgment recovers the exact session with its embedded pages", async () => {
  await reset();
  failJournalAck = true;

  const { journal } = await start();

  assert.equal(game.journal.size, 1);
  assert.equal(journal.pages.size, 3);
});

test("an empty campaign Day is rejected rather than silently becoming Day 0", async () => {
  await reset();
  await assert.rejects(start({ day: "" }), /Enter the campaign Day/);
  assert.equal(game.journal.size, 0);
  assert.equal(game.folders.size, 0);
});

for (const example of [
  {
    label: "number only",
    title: "  ",
    number: " 25 ",
    expectedTitle: "Session 25",
    expectedName: "Session 25"
  },
  {
    label: "title only",
    title: " The Old Mill ",
    number: "",
    expectedTitle: "The Old Mill",
    expectedName: "The Old Mill"
  },
  {
    label: "title and number",
    title: "The Old Mill",
    number: "25",
    expectedTitle: "The Old Mill",
    expectedName: "Session 25 — The Old Mill"
  }
]) test(`session naming accepts ${example.label} and preserves the result on retry`, async () => {
  await reset();

  const { journal, request } = await start({ title: example.title, number: example.number });

  assert.equal(sessionData(journal).title, example.expectedTitle);
  assert.equal(journal.name, example.expectedName);
  assert.match([...journal.pages][0].text.content, new RegExp(example.expectedTitle));
  await executeSessionNotes(request);
  assert.equal(game.journal.size, 1);
  assert.equal(journal.name, example.expectedName);
});

test("starting without either a title or number creates no Journal or folder", async () => {
  await reset();
  await assert.rejects(start({ title: "  ", number: "  " }), /Enter a session title or a session number/);
  assert.equal(game.journal.size, 0);
  assert.equal(game.folders.size, 0);
});

test("notes persist literal multiline text, author, campaign context, selection, and classification", async () => {
  await reset();

  const { journal } = await start();
  const result = await executeSessionNotes(note(journal, { text: "<script>bad()</script>\nMira & Orin", playerSafe: true }));
  const page = journal.pages.get(result.pageId);

  assert.match(page.text.content, /&lt;script&gt;bad\(\)&lt;\/script&gt;<br>Mira &amp; Orin/);

  const metadata = page.getFlag(M, "sessionNotes");

  assert.equal(metadata.author.id, "gm");
  assert.equal(metadata.campaign.day, 42);
  assert.equal(metadata.important, true);
  assert.equal(metadata.playerSafe, true);
  assert.equal(page.ownership.default, -1);
});

test("concurrent retries create one note and reject changed payloads with the same identity", async () => {
  await reset();

  const { journal } = await start();
  const request = note(journal);
  const results = await Promise.all(Array.from({ length: 12 }, () => executeSessionNotes(request)));

  assert.equal(new Set(results.map(result => result.pageId)).size, 1);
  assert.equal(events(journal).length, 1);
  await assert.rejects(executeSessionNotes({ ...request, text: "Different story" }), /reused with different details/);
});

test("page failures retain a durable reservation, recover a lost create reply, and finish without duplication", async () => {
  await reset();

  const { journal } = await start();
  const request = note(journal);

  failBeforePage = true;
  await assert.rejects(executeSessionNotes(request), /Page write unavailable/);
  assert.equal(events(journal).length, 0);
  failBeforePage = false;
  failAfterPage = true;
  await executeSessionNotes(request);
  assert.equal(events(journal).length, 1);
  await executeSessionNotes(request);
  assert.equal(events(journal).length, 1);
});

test("a failed completion receipt recovers an existing, subsequently edited note without overwriting its text", async () => {
  await reset();

  const { journal } = await start();
  const request = note(journal);

  failCompletion = true;
  await assert.rejects(executeSessionNotes(request), /Completion receipt/);

  const page = events(journal)[0];

  page.text.content = "<p>Corrected in the native editor.</p>";
  await executeSessionNotes(request);
  assert.equal(events(journal).length, 1);
  assert.equal(page.text.content, "<p>Corrected in the native editor.</p>");
});

test("native note deletion remains deleted across retries and repository reload", async () => {
  await reset();

  const { journal } = await start();
  const request = note(journal);
  const result = await executeSessionNotes(request);

  journal.pages.delete(result.pageId);

  const reloaded = await import(`../scripts/session-notes-repository.js?deleted=${id()}`);

  assert.equal((await reloaded.executeSessionNotes(request)).deleted, true);
  assert.equal(events(journal).length, 0);
});

test("native deletion records a tombstone even when the original completion receipt failed", async () => {
  await reset();
  registerSessionNotesHooks();

  try {
    const { journal } = await start();
    const request = note(journal);

    failCompletion = true;
    await assert.rejects(executeSessionNotes(request), /Completion receipt/);

    const page = events(journal)[0];
    const key = page.getFlag(M, "sessionNotes").key;

    journal.pages.delete(page.id);
    emit("deleteJournalEntryPage", page);
    await waitUntil(() => journal.getFlag(M, "sessionOperations")[key].status === "deleted");
    assert.equal((await executeSessionNotes(request)).deleted, true);
    assert.equal(events(journal).length, 0);
  } finally {
    callbacks.clear();
  }
});

test("the native Journal status banner shows current Day/time without touching Overview prose", async () => {
  await reset();
  registerSessionNotesHooks();

  try {
    const { journal } = await start();
    const overview = [...journal.pages][0];

    overview.text.content = "<p>My own overview.</p>";
    await executeSessionNotes(lifecycle(journal, "clock", { day: 43, time: "08:00" }));
    await executeSessionNotes(lifecycle(journal, "end"));

    const root = document.createElement("section");

    root.innerHTML = '<article class="journal-entry-content"></article>';
    emit("renderJournalEntrySheet", { document: journal }, root);
    assert.match(root.textContent, /Session ended.*End: Day 43, 8:00 AM/);
    assert.equal(overview.text.content, "<p>My own overview.</p>");
    emit("renderJournalEntrySheet", { document: journal }, root);
    assert.equal(root.querySelectorAll("[data-session-journal-status]").length, 1);
  } finally {
    callbacks.clear();
  }
});

test("Journal controls copy current notes and edit the clock with validation, exact retries, and activation guards", async () => {
  await reset();
  registerSessionNotesHooks();

  try {
    const { journal } = await start();
    const overview = [...journal.pages][0];

    overview.text.content = "<p>My edited session overview.</p>";

    const root = document.createElement("form");

    root.innerHTML = '<article class="journal-entry-content"></article>';
    emit("renderJournalEntrySheet", { document: journal }, root);
    root.querySelector('[data-session-journal-action="copy"]').click();
    await waitUntil(() => navigator.clipboard.text.includes("My edited session overview."));
    assert.ok(navigator.clipboard.text.includes(DEFAULT_RECAP_PROMPT));
    assert.equal(root.querySelector('[data-session-journal-action="addendum"]'), null);

    const clockButton = root.querySelector('[data-session-journal-action="clock"]');

    clockButton.click();
    await waitUntil(() => dialogs.some(dialog => dialog.options.window.title === "Set Day/Time"));

    const clock = dialogs.at(-1);

    clockButton.click();
    assert.equal(dialogs.at(-1), clock);
    assert.equal(clock.focused, true);
    field(clock, "day").value = "";
    await clock.submit("save");
    assert.match(clock.element.textContent, /Enter the campaign Day number/);
    assert.equal(field(clock, "day").disabled, false);
    field(clock, "day").value = "43";
    field(clock, "time").value = "08:00";
    field(clock, "reason").value = "Correct the campaign clock.";
    failCompletion = true;
    await clock.submit("save");
    assert.equal(clock.rendered, true);
    assert.equal(field(clock, "day").disabled, true);
    assert.equal(sessionData(journal).campaign.day, 42);

    const clockEvents = events(journal).length;

    await clock.submit("save");
    assert.equal(clock.rendered, false);
    assert.equal(events(journal).length, clockEvents);
    assert.equal(advanceCalls.length, 0);
    assert.equal(sessionData(journal).campaign.day, 43);
    assert.equal(sessionData(journal).campaign.time, "08:00");
    assert.equal(overview.text.content, "<p>My edited session overview.</p>");
    clockButton.click();
    await waitUntil(() => dialogs.at(-1) !== clock);

    const reopened = dialogs.at(-1);

    await game.settings.set(M, "sessionNotesEnabled", false);
    await waitUntil(() => !reopened.rendered);

    const before = writes.length;

    await reopened.submit("save");
    assert.equal(writes.length, before);
    clockButton.click();
    await waitUntil(() => notices.some(notice => /Enable Session Notes/.test(notice.message)));
    assert.equal(dialogs.at(-1), reopened);
  } finally {
    callbacks.clear();
  }
});

test("an ended Journal offers Copy Notes and Add Addendum while leaving the current session alone", async () => {
  await reset();
  registerSessionNotesHooks();

  try {
    const { journal } = await start();

    await executeSessionNotes(lifecycle(journal, "end"));

    const { journal: current } = await start({ number: "25" });
    const currentData = structuredClone(sessionData(current));
    const root = document.createElement("section");

    emit("renderJournalEntrySheet", { document: journal }, root);
    assert.equal(root.querySelector('[data-session-journal-action="clock"]'), null);
    assert.ok(root.querySelector('[data-session-journal-action="copy"]'));
    root.querySelector('[data-session-journal-action="addendum"]').click();
    await waitUntil(() => dialogs.some(dialog => dialog.rendered && dialog.options.window.title === "Quick Note — Addendum"));

    const addendum = dialogs.at(-1);

    field(addendum, "note").value = "A late detail from the old session.";
    await addendum.submit("ok");
    assert.equal(events(journal).length, 1);
    assert.equal(events(current).length, 0);
    assert.deepEqual(sessionData(current), currentData);
    await executeSessionNotes(lifecycle(current, "end"));

    const dashboard = await openSessionNotes();

    assert.ok(field(dashboard, "title"));
    await dashboard.close();
  } finally {
    callbacks.clear();
  }
});

test("pause/resume persists breaks, permits manual notes during breaks, and never rewrites native text", async () => {
  await reset();

  const { journal } = await start();
  const overview = [...journal.pages][0];

  overview.text.content = "<p>My campaign overview.</p>";
  await executeSessionNotes(lifecycle(journal, "pause"));
  assert.equal(sessionData(journal).state, "paused");
  assert.equal(sessionData(journal).breaks[0].end, null);
  await executeSessionNotes(note(journal));
  await executeSessionNotes(lifecycle(journal, "resume"));
  assert.equal(sessionData(journal).state, "active");
  assert.ok(sessionData(journal).breaks[0].end);
  assert.equal(overview.text.content, "<p>My campaign overview.</p>");
});

test("manual Day/time changes reject stale revisions; ending records snapshots and closes an open break", async () => {
  await reset();

  const { journal } = await start();
  const stale = lifecycle(journal, "clock", { day: 44, time: "10:00" });

  await executeSessionNotes(lifecycle(journal, "clock", { day: 43, time: "08:30" }));
  await assert.rejects(executeSessionNotes(stale), /session changed/);
  await executeSessionNotes(lifecycle(journal, "pause"));

  const end = lifecycle(journal, "end");

  await executeSessionNotes(end);
  await executeSessionNotes(end);
  assert.deepEqual(sessionData(journal).endCampaign, { day: 43, time: "08:30" });
  assert.ok(sessionData(journal).breaks[0].end);
  await assert.rejects(executeSessionNotes(note(journal)), /session has ended/);
  await executeSessionNotes(note(journal, { addendum: true, day: 42, time: "14:00" }));
  assert.equal(
    events(journal).find(page => page.getFlag(M, "sessionNotes").addendum).getFlag(M, "sessionNotes").campaign.time,
    "14:00"
  );

  const next = await start({ number: "25", day: 43, time: "08:30" });

  assert.notEqual(next.journal.id, journal.id);
  assert.equal(game.journal.size, 2);
});

test("authorization is rechecked for players, inactive requesters, non-authoritative GMs, and queued work", async () => {
  await reset();

  const { journal } = await start();

  await assert.rejects(async () => executeSessionNotes(note(journal, { requesterUserId: "player" })), /Only a GM/);

  const request = note(journal);
  const pending = executeSessionNotes(request);

  game.user.isGM = false;
  await assert.rejects(pending, /Only a GM/);
  assert.equal(events(journal).length, 0);
  game.user.isGM = true;
  game.users.activeGM = { id: "anotherGM" };
  await assert.rejects(async () => executeSessionNotes(request), /active GM/);
  game.users.activeGM = game.user;
  game.user.active = false;
  await assert.rejects(async () => executeSessionNotes(request), /not active/);
});

test("Copy Notes exports native edits, real paragraphs, Day/time and context; excludes deleted/excluded notes and the finished recap", async () => {
  await reset();

  const { journal } = await start();
  const result = await executeSessionNotes(note(journal));

  journal.pages.get(result.pageId).text.content = "<h2>Correction</h2><p>The captain refused.</p><p>Mira kept both ledgers.</p>";
  await executeSessionNotes(note(journal, { text: "Do not include me", excluded: true }));

  const recap = [...journal.pages].find(page => page.name === "Recap");

  recap.text.content = "<p>OLD FINISHED RECAP</p>";
  await executeSessionNotes(lifecycle(journal, "clock", { day: 43, time: "00:10" }));
  await executeSessionNotes(lifecycle(journal, "end"));

  const text = sessionNotesPackage(journal, "CUSTOM PROMPT");

  assert.ok(text.startsWith("CUSTOM PROMPT"));
  assert.match(text, /Day 43, 12:10 AM/);
  assert.match(text, /The captain refused\.\nMira kept both ledgers\./);
  assert.match(text, /Old Mill/);
  assert.doesNotMatch(text, /OLD FINISHED RECAP|Do not include me|captain took a copy/);
  game.user = game.users.get("player");
  assert.throws(() => sessionNotesPackage(journal, ""), /Only a GM/);
});

function token(actor, x, y, details = {}) {
  return {
    actor,
    isVisible: true,
    visible: true,
    name: actor.name,
    document: { uuid: `Scene.mill.Token.${id()}`, actorLink: true },
    getBounds: () => ({
      x,
      y,
      width: 50,
      height: 50
    }),
    ...details
  };
}

function readyCanvas(tokens) {
  canvas.ready = true;
  canvas.scene = { name: "Old Mill", uuid: "Scene.mill" };
  canvas.app = {
    renderer: {
      screen: {
        x: 0,
        y: 0,
        width: 800,
        height: 600
      }
    }
  };

  canvas.tokens.placeables = tokens;
}

test("Actors on Screen applies rendered visibility, viewport intersections and Actor identity deduplication", async () => {
  await reset();

  const mira = game.actors.get("mira");
  const orin = {
    id: "orin",
    uuid: "Actor.orin",
    name: "Orin",
    img: "orin.webp"
  };

  readyCanvas([token(mira, 10, 10), token(mira, 200, 200), token(orin, 790, 590), token(orin, 850, 10),
    token({ ...orin, uuid: "Actor.hidden" }, 50, 50, { isVisible: false }), token(orin, 50, 50, { isPreview: true })]);

  assert.deepEqual(visibleNoteActors().map(actor => actor.name), ["Mira", "Orin"]);
  canvas.ready = false;
  assert.deepEqual(visibleNoteActors(), []);
});

test("portrait insertion always appends with whitespace and focuses the new end without replacing selected text", async () => {
  await reset();

  const area = document.createElement("textarea");

  document.body.append(area);
  area.value = "Mira found it.\n";
  area.setSelectionRange(0, 4);
  appendActorName(area, "Orin");
  assert.equal(area.value, "Mira found it.\nOrin ");
  assert.equal(document.activeElement, area);
  assert.equal(area.selectionStart, area.value.length);
  appendActorName(area, "Mira");
  assert.equal(area.value, "Mira found it.\nOrin Mira ");
  area.remove();
});

test("Quick Note focuses one draft, preserves Enter newlines, and OK closes after a confirmed multiline save", async () => {
  await reset();

  const { journal } = await start();
  const dialog = await openQuickNote();
  const area = field(dialog, "note");

  area.value = "First line\nSecond line";
  assert.equal(await openQuickNote(), dialog);
  assert.equal(document.activeElement, area);

  let bubbled = false;

  dialog.element.addEventListener("keydown", () => {
    bubbled = true;
  });

  const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

  area.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  assert.equal(bubbled, false);
  assert.equal(events(journal).length, 0);
  await dialog.submit("ok");
  assert.equal(dialog.rendered, false);
  assert.equal(events(journal).length, 1);
  assert.match(events(journal)[0].text.content, /First line<br>Second line/);
  assert.equal(callbacks.size, 0);
});

test("failed OK preserves the original immutable draft and retries without creating another note", async () => {
  await reset();

  const { journal } = await start();

  readyCanvas([token(game.actors.get("mira"), 20, 20)]);

  const dialog = await openQuickNote();

  field(dialog, "note").value = "Keep this draft";
  failBeforePage = true;

  const originalLog = console.error;

  console.error = () => {};

  try {
    await dialog.submit("ok");
  } finally {
    console.error = originalLog;
  }

  assert.equal(dialog.rendered, true);
  assert.equal(field(dialog, "note").value, "Keep this draft");
  assert.equal(
    field(dialog, "note").readOnly,
    true,
    "Unconfirmed payload remains selectable but cannot be edited before a retry"
  );

  const portrait = dialog.element.querySelector("[data-note-actors] button");

  assert.equal(portrait.disabled, true);
  portrait.click();
  emit("canvasPan");
  assert.equal(dialog.element.querySelector("[data-note-actors] button").disabled, true);
  assert.equal(field(dialog, "note").value, "Keep this draft");
  failBeforePage = false;
  await dialog.submit("ok");
  assert.equal(dialog.rendered, false);
  assert.equal(events(journal).length, 1);
});

test("empty note validation permits correcting the draft before saving", async () => {
  await reset();

  const { journal } = await start();
  const dialog = await openQuickNote();

  await dialog.submit("ok");
  assert.equal(dialog.rendered, true);
  assert.equal(field(dialog, "note").disabled, false);
  field(dialog, "note").value = "Now there is a note";
  await dialog.submit("ok");
  assert.equal(events(journal).length, 1);
});

test("portrait buttons insert names and viewport refreshes do not replace the textarea, selection, or focus", async () => {
  await reset();
  await start();
  readyCanvas([token(game.actors.get("mira"), 20, 20)]);

  const dialog = await openQuickNote();
  const area = field(dialog, "note");

  area.value = "Spoke with";

  const portrait = dialog.element.querySelector("[data-note-actors] button");

  assert.equal(portrait.getAttribute("aria-label"), "Add Mira to note");
  portrait.click();
  assert.equal(area.value, "Spoke with Mira ");
  assert.equal(document.activeElement, area);
  area.setSelectionRange(2, 7);
  canvas.tokens.placeables = [];
  emit("canvasPan");
  assert.equal(field(dialog, "note"), area);
  assert.equal(area.selectionStart, 2);
  assert.equal(area.selectionEnd, 7);
  assert.equal(document.activeElement, area);
  assert.match(dialog.element.textContent, /No Actors on Screen/);
  await dialog.submit("cancel");
  assert.equal(callbacks.size, 0);
});

test("Quick Note without an active session keeps its draft when a session is subsequently started", async () => {
  await reset();

  const dialog = await openQuickNote();
  const area = field(dialog, "note");

  area.value = "Remember this";
  await dialog.submit("ok");
  assert.equal(dialog.rendered, true);
  await start();
  assert.equal(area.value, "Remember this");
  assert.match(dialog.element.querySelector("[data-note-session]").textContent, /The Old Mill/);
  await dialog.submit("ok");
  assert.equal(dialog.rendered, false);
});

test("prompt settings are world-scoped, shared, editable, resettable, and separate from Journals", async () => {
  await reset();
  assert.equal(registrations.get(`${M}.sessionRecapPrompt`).scope, "world");
  assert.equal(menus.get(`${M}.sessionRecapPromptEditor`).restricted, true);

  let editor = await openRecapPrompt();

  field(editor, "recap-prompt").value = "  ";
  await editor.submit("save");
  assert.equal(editor.rendered, true);
  assert.equal(game.settings.get(M, "sessionRecapPrompt"), DEFAULT_RECAP_PROMPT);
  field(editor, "recap-prompt").value = "A custom spoken recap.";
  await editor.submit("save");
  assert.equal(editor.rendered, false);
  game.user = { id: "otherGM", isGM: true };
  editor = await openRecapPrompt();
  assert.equal(field(editor, "recap-prompt").value, "A custom spoken recap.");
  await editor.submit("reset");
  assert.equal(game.settings.get(M, "sessionRecapPrompt"), DEFAULT_RECAP_PROMPT);
  await editor.submit("cancel");
  assert.equal(editor.rendered, false);
  assert.equal(game.journal.size, 0);
});

test("native Settings puts activation first and exposes the recap menu only after activation is saved", async () => {
  await reset();
  await game.settings.set(M, "sessionNotesEnabled", false);

  const root = document.createElement("form");

  root.innerHTML = `<div class="form-group" id="other-setting"><input name="other-module.setting"></div>
    <div class="form-group" id="prompt-setting"><label>Recap Prompt</label><button type="button" data-key="${M}.sessionRecapPromptEditor">Edit Recap Prompt</button></div>
    <div class="form-group" id="abp-setting"><label>Apply ABP attack potency to spell attacks</label><div class="form-fields"><input type="checkbox" name="${M}.abpSpellAttacks" checked></div></div>
    <div class="form-group" id="enable-setting"><label>Enable Session Notes</label><div class="form-fields"><input type="checkbox" name="${M}.sessionNotesEnabled"></div></div>`;

  document.body.append(root);

  const application = {};
  const stop = registerSessionNotesSettingsUI();

  try {
    const toggle = root.querySelector(`#enable-setting input`);
    const abp = root.querySelector(`#abp-setting input`);
    const row = root.querySelector("#prompt-setting");
    const button = row.querySelector("button");

    emit("renderSettingsConfig", application, root);
    assert.deepEqual(
      [...root.children].map(row => row.id),
      ["other-setting", "enable-setting", "prompt-setting", "abp-setting"]
    );

    assert.equal(row.hidden, true);
    assert.equal(button.disabled, true);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(row.hidden, true, "An unsaved check does not bypass the disabled feature");
    await game.settings.set(M, "sessionNotesEnabled", true);
    assert.equal(row.hidden, false);
    assert.equal(button.disabled, false);
    emit("renderSettingsConfig", application, root);
    assert.equal(root.querySelectorAll("#enable-setting").length, 1);
    assert.equal(root.querySelector(`#abp-setting input`), abp);
    assert.equal(abp.checked, true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(row.hidden, true);
    assert.equal(button.disabled, true);
    emit("closeSettingsConfig", application);
  } finally {
    stop();
    root.remove();
  }
});

test("disabling Session Notes closes the recap editor and blocks opening, saving, and resetting through retained references", async () => {
  await reset();
  await game.settings.set(M, "sessionRecapPrompt", "Keep this saved prompt.");

  const editor = await openRecapPrompt();

  field(editor, "recap-prompt").value = "Unsaved replacement";

  const Editor = menus.get(`${M}.sessionRecapPromptEditor`).type;

  await game.settings.set(M, "sessionNotesEnabled", false);
  await waitUntil(() => !editor.rendered);
  await assert.rejects(openRecapPrompt(), /Enable Session Notes/);
  assert.throws(() => new Editor(), /Enable Session Notes/);
  await editor.submit("save");
  await editor.submit("reset");
  assert.equal(game.settings.get(M, "sessionRecapPrompt"), "Keep this saved prompt.");
  assert.equal(callbacks.size, 0);
  await game.settings.set(M, "sessionNotesEnabled", true);

  const reopened = await openRecapPrompt();

  assert.equal(field(reopened, "recap-prompt").value, "Keep this saved prompt.");
  await reopened.close();
});

test("the dashboard shows only setup, active actions, or paused actions as the session progresses", async () => {
  await reset();

  const dialog = await openSessionNotes();

  assert.equal(field(dialog, "session"), null);
  assert.equal(dialog.element.querySelector("details"), null);
  assert.equal(dialog.element.querySelector('[data-session-action="pause"]'), null);
  assert.equal(dialog.element.querySelector('[data-session-action="end"]'), null);
  field(dialog, "title").value = "Dashboard session";
  field(dialog, "number").value = "25";
  field(dialog, "day").value = "43";
  field(dialog, "time").value = "08:00";
  dialog.element.querySelector('[data-session-action="start"]').click();
  await waitUntil(() => /Saved\./.test(dialog.element.querySelector("[data-session-status]").textContent));

  const journal = [...game.journal][0];

  assert.equal(sessionData(journal).campaign.day, 43);
  assert.match(dialog.element.textContent, /Session 25 — Dashboard session/);
  assert.deepEqual(
    [...dialog.element.querySelectorAll('[data-session-action]')].map(button => button.textContent),
    ["Pause", "End Session"]
  );

  assert.equal(dialog.element.querySelector("input, select, fieldset, details, [data-session-page]"), null);
  dialog.element.querySelector('[data-session-action="pause"]').click();
  await waitUntil(() => Boolean(dialog.element.querySelector('[data-session-action="resume"]')));
  assert.equal(sessionData(journal).state, "paused");
  assert.deepEqual(
    [...dialog.element.querySelectorAll('[data-session-action]')].map(button => button.textContent),
    ["Continue", "End Session"]
  );

  assert.equal(dialog.element.querySelector("input, select, fieldset, details"), null);
  dialog.element.querySelector('[data-session-action="resume"]').click();
  await waitUntil(() => Boolean(dialog.element.querySelector('[data-session-action="pause"]')));
  assert.equal(sessionData(journal).state, "active");
  assert.equal(sessionData(journal).campaign.time, "08:00");
  dialog.element.querySelector('[data-session-action="end"]').click();
  await waitUntil(() => Boolean(field(dialog, "title")));
  assert.equal(sessionData(journal).state, "ended");
  assert.equal(field(dialog, "title").value, "");
  assert.equal(field(dialog, "day").value, "43");
  assert.equal(field(dialog, "time").value, "08:00");
  assert.equal(field(dialog, "session"), null);
  assert.doesNotMatch(dialog.element.textContent, /Dashboard session/);
  assert.equal(await openSessionNotes(), dialog);
  await dialog.submit("close");
  assert.equal(dialog.rendered, false);
});

test("the dashboard starts a numbered session without a title and includes the selected Party in recap notes", async () => {
  await reset();

  const dialog = await openSessionNotes();

  assert.equal(dialog.element.querySelector('[data-session-action="prompt"]'), null);
  field(dialog, "number").value = "30";
  field(dialog, "number").dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(field(dialog, "title").placeholder, "Session 30");
  assert.equal(field(dialog, "title").value, "");
  field(dialog, "party").checked = true;
  dialog.element.querySelector('[data-session-action="start"]').click();
  await waitUntil(() => /Saved\./.test(dialog.element.querySelector("[data-session-status]").textContent));

  const journal = [...game.journal][0];

  assert.equal(journal.name, "Session 30");
  assert.equal(sessionData(journal).title, "Session 30");
  assert.match(sessionNotesPackage(journal, "Prompt"), /Party: Mira/);
  await dialog.close();
});

test("with only past sessions, reopening shows blank setup with the latest saved clock and discards unsaved fields", async () => {
  await reset();

  const { journal } = await start();
  const dialog = await openSessionNotes();

  await executeSessionNotes(lifecycle(journal, "end"));
  field(dialog, "title").value = "Unsaved next-session title";

  const page = [...journal.pages][0];

  page.name = "Overview edited outside the dashboard";
  assert.doesNotMatch(dialog.element.textContent, /Overview edited outside/);

  const before = writes.length;

  assert.equal(dialog.element.querySelector('[data-session-action="refresh"]'), null);
  field(dialog, "day").value = "999";
  field(dialog, "time").value = "23:59";
  await dialog.close();

  const reopened = await openSessionNotes();

  assert.notEqual(reopened, dialog);
  assert.doesNotMatch(reopened.element.textContent, /Overview edited outside|The Old Mill/);
  assert.equal(field(reopened, "session"), null);
  assert.equal(field(reopened, "title").value, "");
  assert.equal(Number(field(reopened, "day").value), sessionData(journal).campaign.day);
  assert.equal(field(reopened, "time").value, sessionData(journal).campaign.time);
  assert.equal(writes.length, before);
  assert.equal(game.journal.size, 1);
  await reopened.close();
});

test("an already paused session opens with Continue and can end directly without altering past sessions", async () => {
  await reset();

  const { journal: past } = await start();

  await executeSessionNotes(lifecycle(past, "end"));

  const pastData = structuredClone(sessionData(past));
  const { journal } = await start({ number: "25", title: "Current adventure" });

  await executeSessionNotes(lifecycle(journal, "pause"));

  const dialog = await openSessionNotes();

  assert.match(dialog.element.textContent, /Session 25 — Current adventure/);
  assert.doesNotMatch(dialog.element.textContent, /The Old Mill/);
  assert.deepEqual(
    [...dialog.element.querySelectorAll('[data-session-action]')].map(button => button.textContent),
    ["Continue", "End Session"]
  );

  dialog.element.querySelector('[data-session-action="end"]').click();
  await waitUntil(() => Boolean(field(dialog, "title")));
  assert.equal(sessionData(journal).state, "ended");
  assert.ok(sessionData(journal).breaks.at(-1).end);
  assert.deepEqual(sessionData(past), pastData);
  assert.equal(game.journal.size, 2);
  await dialog.close();
});

test("external lifecycle changes update the dashboard while unrelated Journal changes preserve setup drafts", async () => {
  await reset();

  const { journal: past } = await start();

  await executeSessionNotes(lifecycle(past, "end"));

  const dialog = await openSessionNotes();

  field(dialog, "title").value = "My next session";
  await past.update({ name: "Renamed past session" });
  assert.equal(field(dialog, "title").value, "My next session");

  const { journal } = await start({ number: "25", title: "Another GM started this" });

  assert.equal(field(dialog, "title"), null);
  assert.match(dialog.element.textContent, /Another GM started this/);
  await executeSessionNotes(lifecycle(journal, "pause"));
  assert.equal(dialog.element.querySelector('[data-session-action="resume"]').textContent, "Continue");
  await executeSessionNotes(lifecycle(journal, "end"));
  assert.ok(field(dialog, "title"));
  await dialog.close();
  assert.equal(callbacks.size, 0);
});

test("Party Select All checks every listed character without saving until Start Session", async () => {
  await reset();
  game.actors.set("orin", {
    id: "orin",
    uuid: "Actor.orin",
    name: "Orin",
    type: "character"
  });

  const dialog = await openSessionNotes();

  field(dialog, "number").value = "31";

  const selectAll = dialog.element.querySelector('[data-session-action="select-party"]');

  assert.equal(selectAll.textContent, "Select All");
  assert.equal(selectAll.type, "button");
  selectAll.click();
  assert.equal([...dialog.element.querySelectorAll('[name="party"]')].filter(input => input.checked).length, 2);
  assert.equal(game.journal.size, 0);
  assert.equal(writes.length, 0);
  assert.equal(dialog.rendered, true);
  assert.equal(field(dialog, "number").value, "31");
  dialog.element.querySelector('[name="party"][value="orin"]').checked = false;
  selectAll.click();
  assert.equal(dialog.element.querySelector('[name="party"][value="orin"]').checked, true);
  dialog.element.querySelector('[data-session-action="start"]').click();
  await waitUntil(() => /Saved\./.test(dialog.element.querySelector("[data-session-status]").textContent));

  const journal = [...game.journal][0];

  assert.deepEqual(sessionData(journal).party.map(actor => actor.id), ["mira", "orin"]);
  assert.match(sessionNotesPackage(journal, "Prompt"), /Party: Mira, Orin/);
  await dialog.close();
});

test("player access is rejected before dashboards, settings editors, or draft text are built", async () => {
  await reset();
  game.user = game.users.get("player");
  await assert.rejects(openSessionNotes(), /Only a GM/);
  await assert.rejects(openQuickNote(), /Only a GM/);
  await assert.rejects(openRecapPrompt(), /Only a GM/);
  assert.equal(dialogs.length, 0);
});

test("a stale explicit Quick Note Journal ID never falls back to a different active session", async () => {
  await reset();
  await start();
  await assert.rejects(openQuickNote({ journalId: "deleted-journal" }), /no longer exists/);
  assert.equal(dialogs.length, 0);
});

test("permission loss closes open private dashboards, prompt editors and Quick Note", async () => {
  await reset();
  await start();

  const dashboard = await openSessionNotes();
  const noteDialog = await openQuickNote();
  const editor = await openRecapPrompt();

  game.user.isGM = false;
  emit("updateUser", game.user);
  await waitUntil(() => !dashboard.rendered && !noteDialog.rendered && !editor.rendered);
  assert.equal(callbacks.size, 0);
});

test("Session Notes defaults off and denies runtime APIs and worker writes until explicitly enabled", async () => {
  await reset();
  values.delete(`${M}.sessionNotesEnabled`);

  const config = registrations.get(`${M}.sessionNotesEnabled`);

  assert.equal(config.default, false);
  assert.equal(config.scope, "world");
  assert.equal(config.config, true);
  assert.equal(config.restricted, true);
  await assert.rejects(openSessionNotes(), /Enable Session Notes/);
  await assert.rejects(openQuickNote(), /Enable Session Notes/);
  await assert.rejects(
    async () => executeSessionNotes(operation("start", { title: "Blocked", day: 1, time: "09:00" })),
    /Enable Session Notes/
  );

  assert.equal(game.journal.size, 0);
  assert.equal(game.folders.size, 0);
  assert.equal(dialogs.length, 0);
  await game.settings.set(M, "sessionNotesEnabled", true);

  const { journal } = await start();

  assert.ok(journal);
});

test("disabling closes runtime windows while preserving saved Journals, session state, text, and custom prompts", async () => {
  await reset();

  const { journal } = await start();
  const request = note(journal);

  await executeSessionNotes(request);
  await game.settings.set(M, "sessionRecapPrompt", "My custom recap voice.");

  const savedState = structuredClone(sessionData(journal));
  const savedText = [...journal.pages].map(page => page.text.content);
  const dashboard = await openSessionNotes();
  const quick = await openQuickNote();

  field(quick, "note").value = "Unsaved draft";
  await game.settings.set(M, "sessionNotesEnabled", false);
  await waitUntil(() => !dashboard.rendered && !quick.rendered);
  assert.equal(callbacks.size, 0);
  assert.deepEqual(sessionData(journal), savedState);
  assert.deepEqual([...journal.pages].map(page => page.text.content), savedText);
  assert.equal(game.settings.get(M, "sessionRecapPrompt"), "My custom recap voice.");
  assert.throws(() => sessionNotesPackage(journal, ""), /Enable Session Notes/);
  await assert.rejects(
    async () => executeSessionNotes(request),
    /Enable Session Notes/,
    "Even completed retries must respect the switch"
  );

  await game.settings.set(M, "sessionNotesEnabled", true);
  assert.equal(sessionJournals()[0], journal);

  const reopened = await openSessionNotes();

  assert.match(reopened.element.textContent, /The Old Mill/);
  await reopened.close();
});

test("turning the switch off after a mutation is queued prevents that mutation from writing", async () => {
  await reset();

  const { journal } = await start();
  const before = writes.length;
  const pending = executeSessionNotes(note(journal));

  await game.settings.set(M, "sessionNotesEnabled", false);
  await assert.rejects(pending, /Enable Session Notes/);
  assert.equal(writes.length, before);
  assert.equal(events(journal).length, 0);
});

test("disabled feature hooks neither decorate Journals nor persist deletion receipts", async () => {
  await reset();
  registerSessionNotesHooks();

  try {
    const { journal } = await start();

    await executeSessionNotes(note(journal));

    const page = events(journal)[0];
    const before = writes.length;
    const root = document.createElement("section");

    document.body.append(root);
    emit("renderJournalEntrySheet", { document: journal }, root);
    assert.ok(root.querySelector("[data-session-journal-status]"));
    await game.settings.set(M, "sessionNotesEnabled", false);
    assert.equal(root.querySelector("[data-session-journal-status]"), null);
    emit("renderJournalEntrySheet", { document: journal }, root);
    emit("deleteJournalEntryPage", page);
    await Promise.resolve();
    assert.equal(writes.length, before);
    assert.equal(root.querySelector("[data-session-journal-status]"), null);
    root.remove();
  } finally {
    callbacks.clear();
  }
});
