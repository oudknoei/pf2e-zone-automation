import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createHeroPointReminder, deliverHeroPointReminders, registerHeroPointReminders, reminderTimestamp } from "../scripts/hero-point-reminders.js";

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

function user(id, isGM = true) {
  return {
    id, isGM, flags: { [MODULE_ID]: { heroPointReminders: {} } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async update(data) {
      writes.push({ userId: this.id, data });
      for (const [path, record] of Object.entries(data)) {
        const key = path.split(".").at(-1);
        if (key.startsWith("-=")) delete this.flags[MODULE_ID].heroPointReminders[key.slice(2)];
        else this.flags[MODULE_ID].heroPointReminders[key] = structuredClone(record);
      }
      for (const handler of hooks.get("updateUser")?.values() ?? []) handler(this, data);
      return this;
    }
  };
}

function pending(recipient = game.user) { return recipient.flags[MODULE_ID].heroPointReminders; }

function fire(name) {
  for (const handler of hooks.get(name)?.values() ?? []) handler();
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
  globalThis.foundry = { utils: { randomID: () => String(++sequence).padStart(16, "A") } };
  const gm = user("gm");
  const otherGM = user("other-gm");
  const users = [gm, otherGM, user("player", false)];
  users.activeGM = gm;
  globalThis.game = { user: gm, users, messages: new Map() };
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
