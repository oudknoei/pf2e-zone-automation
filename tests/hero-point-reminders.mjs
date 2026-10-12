import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { clearHeroPointReminders, createHeroPointReminder, deliverHeroPointReminders, hasHeroPointReminders, registerHeroPointReminderChat, registerHeroPointReminders, reminderTimestamp } from "../scripts/hero-point-reminders.js";

const MODULE_ID = "pf2e-zone-automation";
const nativeNow = Date.now;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
let now;
let sequence;
let cleanup;
let timers;
let hooks;
let messages;
let writes;
let chatCleanup;
let opened;
let notices;
const dom = new JSDOM("<!doctype html><html><body></body></html>");

class ForcedDeletion {}

function user(id, isGM = true) {
  return {
    id, isGM, flags: { [MODULE_ID]: { heroPointReminders: {} } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async update(data) {
      writes.push({ userId: this.id, data });
      for (const [path, record] of Object.entries(data)) {
        const key = path.split(".").at(-1);
        assert.equal(key.startsWith("-="), false, "Reminder updates must use v14 deletion operators, not legacy keys");
        if (record instanceof ForcedDeletion) delete this.flags[MODULE_ID].heroPointReminders[key];
        else this.flags[MODULE_ID].heroPointReminders[key] = structuredClone(record);
      }
      for (const handler of hooks.get("updateUser")?.values() ?? []) handler(this, data);
      return this;
    }
  };
}

function pending(recipient = game.user) { return recipient.flags[MODULE_ID].heroPointReminders; }

function fire(name, ...args) {
  for (const handler of hooks.get(name)?.values() ?? []) handler(...args);
}

function renderMessage(message) {
  const html = dom.window.document.createElement("li");
  html.innerHTML = `<div class="message-content">${message.content}</div>`;
  fire("renderChatMessageHTML", message, html);
  return html;
}

async function deliveredReminder() {
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  await deliverHeroPointReminders();
  return messages[0];
}

async function runNextTimer() {
  const [id, entry] = [...timers.entries()][0];
  timers.delete(id);
  now += entry.delay;
  entry.callback();
  await deliverHeroPointReminders();
}

beforeEach(() => {
  now = new Date(2026, 9, 12, 19, 0).getTime();
  sequence = 0;
  cleanup = null;
  timers = new Map();
  hooks = new Map();
  messages = [];
  writes = [];
  chatCleanup = null;
  opened = 0;
  notices = [];
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.Hooks = {
    on(name, handler) {
      const entries = hooks.get(name) ?? new Map();
      const id = ++sequence;
      entries.set(id, handler);
      hooks.set(name, entries);
      return id;
    },
    off(name, id) { hooks.get(name)?.delete(id); }
  };
  globalThis.foundry = {
    utils: { randomID: () => String(++sequence).padStart(16, "A") },
    data: { operators: { ForcedDeletion } }
  };
  const gm = user("gm");
  const otherGM = user("other-gm");
  const users = [gm, otherGM, user("player", false)];
  users.activeGM = gm;
  const api = { promptSetHeroPoints: async () => { opened++; } };
  globalThis.game = { user: gm, users, messages: new Map(), modules: { get: (id) => id === MODULE_ID ? { api } : undefined } };
  globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
  globalThis.ChatMessage = {
    async create(data, options) {
      assert.equal(options.keepId, true);
      assert.match(data._id, /^[a-zA-Z0-9]{16}$/);
      if (game.messages.has(data._id)) throw new Error("ID already exists");
      const message = { ...data, id: data._id, getFlag(scope, key) { return this.flags[scope]?.[key]; } };
      messages.push(message);
      game.messages.set(message.id, message);
      return message;
    }
  };
});

afterEach(() => {
  cleanup?.();
  chatCleanup?.();
  Date.now = nativeNow;
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
});

test("reminder clock times select today or tomorrow and reject incomplete or invalid times", () => {
  assert.equal(reminderTimestamp("20:30", now), new Date(2026, 9, 12, 20, 30).getTime());
  assert.equal(reminderTimestamp("18:30", now), new Date(2026, 9, 13, 18, 30).getTime());
  assert.equal(reminderTimestamp("19:00", now), new Date(2026, 9, 13, 19, 0).getTime());
  for (const value of ["", "9:00", "24:00", "20:60", "20:30:00", null]) {
    assert.throws(() => reminderTimestamp(value, now), /Enter a reminder time/);
  }
});

test("creating a reminder persists it for the current GM and reuses the same scheduled time", async () => {
  const first = await createHeroPointReminder("20:30");
  assert.equal(first.recipientUserId, "gm");
  assert.deepEqual(pending()[first.id], { remindAt: first.remindAt });
  assert.equal(timers.size, 0, "Creation does not depend on a transient browser-only timer");
  assert.deepEqual(await createHeroPointReminder("20:30"), first);
  assert.equal(writes.length, 1);
  await createHeroPointReminder("21:30");
  assert.equal(Object.keys(pending()).length, 2, "Adding a reminder preserves other records");
});

test("players, invalid input, and failed saves cannot schedule reminders", async () => {
  await assert.rejects(createHeroPointReminder("bad"), /Enter a reminder time/);
  game.user.update = async () => { throw new Error("Save failed"); };
  await assert.rejects(createHeroPointReminder("20:00"), /Save failed/);
  game.user = game.users[2];
  await assert.rejects(createHeroPointReminder("20:00"), /Only a GM/);
  assert.equal(timers.size, 0);
  assert.equal(messages.length, 0);
});

test("Clear Reminders removes both saved times and their timers while preserving another GM's reminders and flags", async () => {
  cleanup = registerHeroPointReminders();
  assert.equal(hasHeroPointReminders(), false);
  await createHeroPointReminder("20:00");
  await createHeroPointReminder("21:00");
  game.user.flags[MODULE_ID].otherSetting = "preserved";
  const otherGM = game.users[1];
  pending(otherGM).OtherGMReminder1 = { remindAt: new Date(2026, 9, 12, 22, 0).getTime() };
  const otherSaved = structuredClone(pending(otherGM));
  assert.equal(hasHeroPointReminders(), true);
  assert.equal(await clearHeroPointReminders(), 2);
  assert.deepEqual(pending(), {});
  assert.equal(hasHeroPointReminders(), false);
  assert.equal(game.user.flags[MODULE_ID].otherSetting, "preserved");
  assert.deepEqual(pending(otherGM), otherSaved);
  assert.equal(Object.keys(writes.at(-1).data).length, 2, "All pending reminders are removed in one save");
  assert.ok(Object.values(writes.at(-1).data).every((record) => record instanceof ForcedDeletion));
  now = new Date(2026, 9, 12, 21, 30).getTime();
  await deliverHeroPointReminders();
  assert.equal(messages.length, 0, "Cleared reminders do not appear when their times pass");
  cleanup();
  cleanup = registerHeroPointReminders();
  await runNextTimer();
  assert.deepEqual(messages.map((message) => message.whisper), [["other-gm"]], "The remaining timer survives a refresh");
});

test("clearing requires a GM, retains pending reminders after a failed save, and does nothing when already empty", async () => {
  cleanup = registerHeroPointReminders();
  await createHeroPointReminder("20:00");
  const save = game.user.update;
  game.user.update = async () => { throw new Error("Clear failed"); };
  await assert.rejects(clearHeroPointReminders(), /Clear failed/);
  assert.equal(hasHeroPointReminders(), true);
  assert.equal(timers.size, 1);
  game.user.update = save;
  await clearHeroPointReminders();
  assert.equal(timers.size, 0);
  const count = writes.length;
  assert.equal(await clearHeroPointReminders(), 0);
  assert.equal(writes.length, count);
  game.user = game.users[2];
  assert.equal(hasHeroPointReminders(), false);
  await assert.rejects(clearHeroPointReminders(), /Only a GM/);
  assert.equal(writes.length, count);
});

test("a due reminder cleared while an earlier message is posting is skipped by the delivery batch", async () => {
  const first = await createHeroPointReminder("20:00");
  await createHeroPointReminder("21:00");
  now = new Date(2026, 9, 12, 21, 0).getTime();
  const create = ChatMessage.create;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ChatMessage.create = async (...args) => { await gate; return create(...args); };
  const posting = deliverHeroPointReminders();
  await new Promise(setImmediate);
  await clearHeroPointReminders();
  release();
  await posting;
  assert.deepEqual(messages.map((message) => message.id), [first.id], "Only the message already posting is delivered");
  assert.deepEqual(pending(), {});
});

test("the scheduler posts a private reminder at the saved time and clears the pending flag", async () => {
  cleanup = registerHeroPointReminders();
  const reminder = await createHeroPointReminder("20:00");
  assert.equal([...timers.values()][0].delay, 60 * 60 * 1000);
  await deliverHeroPointReminders();
  assert.equal(messages.length, 0, "No early delivery");
  await runNextTimer();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, reminder.id);
  assert.deepEqual(messages[0].whisper, ["gm"]);
  assert.match(messages[0].content, /It's time to award everyone 1 Hero Point/);
  assert.equal(Object.keys(pending()).length, 0);
  assert.equal(timers.size, 0);
});

test("clearing the 8pm reminder preserves and delivers the 9pm reminder and leaves another GM's reminders intact", async () => {
  cleanup = registerHeroPointReminders();
  const first = await createHeroPointReminder("20:00");
  const second = await createHeroPointReminder("21:00");
  const otherGM = game.users[1];
  const otherId = "OtherGMReminder1";
  assert.equal(otherId.length, 16);
  pending(otherGM)[otherId] = { remindAt: new Date(2026, 9, 12, 22, 0).getTime() };
  const otherSaved = structuredClone(pending(otherGM));
  await runNextTimer();
  assert.deepEqual(messages.map((message) => message.id), [first.id]);
  assert.deepEqual(pending(), { [second.id]: { remindAt: second.remindAt } });
  assert.deepEqual(pending(otherGM), otherSaved);
  const deletion = writes.at(-1).data;
  assert.ok(deletion[`flags.${MODULE_ID}.heroPointReminders.${first.id}`] instanceof ForcedDeletion);
  assert.equal([...timers.values()][0].delay, 60 * 60 * 1000);
  await runNextTimer();
  assert.deepEqual(messages.map((message) => message.id), [first.id, second.id]);
  assert.ok(messages.every((message) => message.whisper.length === 1 && message.whisper[0] === "gm"));
  assert.deepEqual(pending(), {});
  assert.deepEqual(pending(otherGM), otherSaved);
});

test("refresh recovery restores future reminders and delivers missed reminders after reopening", async () => {
  const reminder = await createHeroPointReminder("20:00");
  cleanup = registerHeroPointReminders();
  assert.equal(timers.size, 1);
  cleanup();
  assert.equal(timers.size, 0);
  now = reminder.remindAt + 10_000;
  cleanup = registerHeroPointReminders();
  assert.equal([...timers.values()][0].delay, 0);
  await runNextTimer();
  assert.equal(messages.length, 1);
});

test("only the active GM delivers reminders, including reminders for another GM", async () => {
  game.user = game.users[1];
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  cleanup = registerHeroPointReminders();
  await deliverHeroPointReminders();
  assert.equal(messages.length, 0);
  assert.equal(timers.size, 0);
  game.users.activeGM = game.user;
  fire("userConnected");
  assert.equal(timers.size, 1);
  game.user = game.users[0];
  game.users.activeGM = game.user;
  fire("userConnected");
  await runNextTimer();
  assert.deepEqual(messages[0].whisper, ["other-gm"], "Recipient stays the creator, not the elected GM or all GMs");
  assert.equal(messages[0].user, "gm");
});

test("overlapping delivery attempts share one transaction", async () => {
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  const originalCreate = ChatMessage.create;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ChatMessage.create = async (...args) => { await gate; return originalCreate(...args); };
  const first = deliverHeroPointReminders();
  const second = deliverHeroPointReminders();
  assert.equal(second, first);
  release();
  await first;
  assert.equal(messages.length, 1);
});

test("a cleanup failure retains the record and a retry removes it without sending twice", async () => {
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  const save = game.user.update;
  game.user.update = async () => { throw new Error("Cleanup failed"); };
  await assert.rejects(deliverHeroPointReminders(), /retrying shortly/);
  assert.equal(messages.length, 1);
  assert.ok(pending()[reminder.id]);
  game.user.update = save;
  await deliverHeroPointReminders();
  assert.equal(messages.length, 1);
  assert.equal(Object.keys(pending()).length, 0);
});

test("chat delivery failure preserves pending reminders and schedules a bounded retry", async () => {
  cleanup = registerHeroPointReminders();
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  const create = ChatMessage.create;
  ChatMessage.create = async () => { throw new Error("Chat unavailable"); };
  await assert.rejects(deliverHeroPointReminders(), /retrying shortly/);
  assert.ok(pending()[reminder.id]);
  assert.equal([...timers.values()][0].delay, 30_000);
  ChatMessage.create = create;
  await runNextTimer();
  assert.equal(messages.length, 1);
});

test("a concurrent GM creation with the same message ID is recognized as delivered", async () => {
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  const create = ChatMessage.create;
  ChatMessage.create = async (...args) => {
    await create(...args);
    throw new Error("ID already exists");
  };
  await deliverHeroPointReminders();
  assert.equal(messages.length, 1);
  assert.equal(Object.keys(pending()).length, 0);
});

test("cancelled chat creation or an unrelated ID collision never clears the pending reminder", async () => {
  const reminder = await createHeroPointReminder("20:00");
  now = reminder.remindAt;
  ChatMessage.create = async () => undefined;
  await assert.rejects(deliverHeroPointReminders(), /retrying shortly/);
  assert.ok(pending()[reminder.id]);
  game.messages.set(reminder.id, { flags: {} });
  await assert.rejects(deliverHeroPointReminders(), /retrying shortly/);
  assert.ok(pending()[reminder.id]);
  assert.equal(messages.length, 0);
});

test("malformed flags are ignored and a player client never installs delivery hooks", async () => {
  pending().bad = { remindAt: now };
  pending().AAAAAAAAAAAAAAAA = { remindAt: "bad" };
  game.users[1].flags[MODULE_ID].heroPointReminders = [];
  cleanup = registerHeroPointReminders();
  assert.equal(timers.size, 0);
  await deliverHeroPointReminders();
  assert.equal(messages.length, 0);
  cleanup();
  cleanup = null;
  game.user = game.users[2];
  assert.equal(registerHeroPointReminders(), undefined);
  assert.equal([...hooks.values()].reduce((count, entries) => count + entries.size, 0), 0);
});

test("the recipient's reminder button opens the same module entry point as the Hero Points macro", async () => {
  chatCleanup = registerHeroPointReminderChat();
  const message = await deliveredReminder();
  const html = renderMessage(message);
  const button = html.querySelector("button[data-pza-hero-point-reminder]");
  assert.equal(button.textContent, "Award Hero Points");
  assert.equal(button.type, "button");
  const before = { writes: writes.length, messages: messages.length };
  button.click();
  await new Promise(setImmediate);
  assert.equal(opened, 1);
  assert.equal(button.disabled, false);
  assert.equal(writes.length, before.writes, "Opening the dialog does not apply Hero Points or change reminders");
  assert.equal(messages.length, before.messages);
  assert.deepEqual(message.whisper, ["gm"]);
});

test("saved reminders regain their buttons when chat history renders after a refresh", async () => {
  const message = await deliveredReminder();
  assert.equal(renderMessage(message).querySelector("button"), null, "Message predates registration and has no stored button");
  chatCleanup = registerHeroPointReminderChat();
  const html = renderMessage(message);
  const button = html.querySelector("button");
  fire("renderChatMessageHTML", message, html);
  assert.equal(html.querySelectorAll("button").length, 1, "Rendering twice does not duplicate controls");
  button.click();
  await new Promise(setImmediate);
  assert.equal(opened, 1, "Rendering twice does not bind two click handlers");
  chatCleanup();
  chatCleanup = registerHeroPointReminderChat();
  const restored = renderMessage(message);
  restored.querySelector("button").click();
  await new Promise(setImmediate);
  assert.equal(opened, 2);
});

test("other GMs, players, and ordinary chat messages receive no reminder shortcut", async () => {
  chatCleanup = registerHeroPointReminderChat();
  const message = await deliveredReminder();
  assert.equal(renderMessage({ content: "Ordinary chat", flags: {} }).querySelector("button"), null);
  game.user = game.users[1];
  assert.equal(renderMessage(message).querySelector("button"), null);
  game.user = game.users[2];
  const html = renderMessage({ ...message, content: `${message.content}<button data-pza-hero-point-reminder>Open</button>` });
  assert.equal(html.querySelector("button"), null);
  assert.equal(opened, 0);
});

test("the reminder button ignores duplicate clicks while opening and rechecks the current user's authority", async () => {
  chatCleanup = registerHeroPointReminderChat();
  const message = await deliveredReminder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  game.modules.get(MODULE_ID).api.promptSetHeroPoints = async () => { opened++; await gate; };
  const button = renderMessage(message).querySelector("button");
  button.click();
  assert.equal(button.disabled, true);
  button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(opened, 1);
  release();
  await new Promise(setImmediate);
  assert.equal(button.disabled, false);
  game.user = game.users[1];
  button.click();
  await new Promise(setImmediate);
  assert.equal(opened, 1);
});

test("a failed dialog launch reports an error and leaves the reminder button retryable", async () => {
  chatCleanup = registerHeroPointReminderChat();
  const message = await deliveredReminder();
  const api = game.modules.get(MODULE_ID).api;
  api.promptSetHeroPoints = async () => { throw new Error("Dialog could not open."); };
  const button = renderMessage(message).querySelector("button");
  const nativeError = console.error;
  console.error = () => {};
  try {
    button.click();
    await new Promise(setImmediate);
    assert.equal(notices[0], "Dialog could not open.");
    assert.equal(button.disabled, false);
    api.promptSetHeroPoints = async () => { opened++; };
    button.click();
    await new Promise(setImmediate);
    assert.equal(opened, 1);
    api.promptSetHeroPoints = undefined;
    button.click();
    await new Promise(setImmediate);
    assert.match(notices.at(-1), /Hero Points dialog is unavailable/);
    assert.equal(button.disabled, false);
  } finally { console.error = nativeError; }
});
