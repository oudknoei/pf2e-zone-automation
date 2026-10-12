import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const { window } = dom;
globalThis.document = window.document;
const dialogs = [];
const notices = [];
const messages = [];
const writes = [];
const reminderWrites = [];
const userHooks = new Map();
class ForcedDeletion {}

class TestDialog extends window.EventTarget {
  constructor(options) {
    super();
    assert.equal(options.content.tagName, "DIV", "DialogV2 content must be a plain div");
    assert.equal(options.content.attributes.length, 0, "DialogV2 content must have no attributes");
    this.options = options;
    this.rendered = false;
    this.element = document.createElement("section");
    const form = document.createElement("form");
    // Foundry serializes the wrapper's inner HTML rather than retaining the wrapper.
    form.innerHTML = options.content.innerHTML;
    this.footer = document.createElement("footer");
    this.footer.className = "form-footer";
    for (const config of options.buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = config.action;
      button.textContent = config.label;
      button.addEventListener("click", (event) => {
        this.submission = config.callback(event, button, this);
      });
      this.footer.append(button);
    }
    form.append(this.footer);
    this.element.append(form);
    dialogs.push(this);
  }

  async render() {
    this.rendered = true;
    document.body.append(this.element);
    this.dispatchEvent(new window.Event("render"));
    return this;
  }

  async close() {
    this.rendered = false;
    this.element.remove();
    this.dispatchEvent(new window.Event("close"));
  }

  bringToFront() { this.front = true; }

  async submit(action = "apply") {
    const button = this.element.querySelector(`[data-action="${action}"]`);
    return this.options.buttons.find((entry) => entry.action === action).callback(null, button, this.element);
  }
}

globalThis.foundry = { applications: { api: { DialogV2: TestDialog } }, data: { operators: { ForcedDeletion } } };
globalThis.Hooks = {
  on(name, callback) {
    assert.equal(name, "updateUser");
    const id = Symbol(name);
    userHooks.set(id, callback);
    return id;
  },
  off(name, id) { assert.equal(name, "updateUser"); userHooks.delete(id); }
};
globalThis.ui = { notifications: {
  error: (message) => notices.push({ level: "error", message }),
  warn: (message) => notices.push({ level: "warn", message })
} };
globalThis.ChatMessage = { create: async (data) => { messages.push(data); } };
globalThis.canvas = { tokens: { controlled: [], placeables: [] } };
globalThis.game = {
  actors: [],
  users: [{ id: "gm", isGM: true }, { id: "player", isGM: false }],
  user: { id: "gm", isGM: true, targets: new Set() }
};

const { promptSetHeroPoints, setHeroPoints } = await import("../scripts/hero-points.js");

function actor(id, name, value, extra = {}) {
  return {
    id, name, type: "character", hasPlayerOwner: true,
    system: { resources: { heroPoints: { value, max: 3 } } },
    async update(data) {
      writes.push({ id, data });
      this.system.resources.heroPoints.value = data["system.resources.heroPoints.value"];
    },
    ...extra
  };
}

async function reset(actors = []) {
  for (const dialog of dialogs) if (dialog.rendered) await dialog.close();
  assert.equal(userHooks.size, 0, "Closed dialogs release their reminder hooks");
  dialogs.length = notices.length = messages.length = writes.length = reminderWrites.length = 0;
  game.actors = actors;
  game.user = {
    id: "gm", isGM: true, targets: new Set(), flags: { "pf2e-zone-automation": { heroPointReminders: {} } },
    async update(data) {
      reminderWrites.push(data);
      for (const [path, record] of Object.entries(data)) {
        const id = path.split(".").at(-1);
        if (record instanceof ForcedDeletion) delete this.flags["pf2e-zone-automation"].heroPointReminders[id];
        else this.flags["pf2e-zone-automation"].heroPointReminders[id] = record;
      }
      for (const callback of userHooks.values()) callback(this, data);
      return this;
    }
  };
  game.users = [game.user, { id: "player", isGM: false }];
  canvas.tokens.controlled = [];
}

function change(dialog, selector, value) {
  const element = dialog.element.querySelector(selector);
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("no player characters produces an error before creating any dialog", async () => {
  for (const actors of [[], [actor("gm-only", "GM Character", 1, { hasPlayerOwner: false })],
    [actor("npc", "NPC", 1, { type: "npc" })]]) {
    await reset(actors);
    assert.equal(await promptSetHeroPoints(), null);
    assert.equal(dialogs.length, 0);
    assert.equal(notices[0].level, "error");
    assert.match(notices[0].message, /No player characters found/);
  }
});

test("GM changes update PF2e resources for off-scene characters with bounded totals and a GM-only summary", async () => {
  const first = actor("one", "One", 2);
  const second = actor("two", "<Two>", 0);
  await reset([first, second]);
  await setHeroPoints(2, [first, first, second]);
  assert.deepEqual(writes, [
    { id: "one", data: { "system.resources.heroPoints.value": 3 } },
    { id: "two", data: { "system.resources.heroPoints.value": 2 } }
  ]);
  assert.deepEqual(messages[0].whisper, ["gm"]);
  assert.match(messages[0].content, /&lt;Two&gt;/);
  await setHeroPoints(3, first, { mode: "remove" });
  assert.equal(first.system.resources.heroPoints.value, 0);
  await setHeroPoints(1, second, { mode: "set" });
  assert.equal(second.system.resources.heroPoints.value, 1);
  await setHeroPoints(-1, "two");
  assert.equal(second.system.resources.heroPoints.value, 0);
});

test("players, invalid amounts, and ambiguous or missing recipients cannot change Hero Points", async () => {
  const first = actor("one", "Same Name", 1);
  const second = actor("two", "Same Name", 1);
  await reset([first, second]);
  await assert.rejects(setHeroPoints(1, "Same Name"), /More than one/);
  await assert.rejects(setHeroPoints(1, "Missing"), /Choose at least one/);
  await assert.rejects(setHeroPoints(NaN, first), /whole number/);
  await assert.rejects(setHeroPoints(1.5, first), /whole number/);
  await assert.rejects(setHeroPoints(1, first, { mode: "unknown" }), /whole number/);
  game.user.isGM = false;
  assert.equal(await promptSetHeroPoints(), null);
  assert.equal(dialogs.length, 0);
  await assert.rejects(setHeroPoints(1, first), /Only a GM/);
  assert.equal(writes.length, 0);
});

test("one dialog guides selection, previews Add/Remove/Set, validates input, and applies exact zero totals", async () => {
  const first = actor("one", "A <Hero>", 2);
  const second = actor("two", "A <Hero>", 1);
  await reset([first, second]);
  canvas.tokens.controlled = [{ actor: first }];
  const dialog = await promptSetHeroPoints();
  const root = dialog.element;
  assert.equal(dialog.options.window.title, "Set Hero Points");
  assert.equal(dialog.options.content.attributes.length, 0);
  assert.ok(root.querySelector(".pza-hero-points"), "Styled content survives Foundry's wrapper serialization");
  assert.equal(dialog.options.form.closeOnSubmit, false);
  assert.equal(root.querySelectorAll('[name="hero-character"]').length, 2);
  assert.equal(root.querySelector('[value="one"]').checked, true);
  assert.equal(root.querySelector('[value="two"]').checked, false);
  assert.equal(root.querySelectorAll(".pza-hp-name span")[0].textContent, "A <Hero>");
  assert.equal(root.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "3");
  assert.equal(root.querySelector('[data-action="apply"]').textContent, "Add 1 Hero Point");
  const actions = root.querySelector(".pza-hp-actions");
  const reminder = root.querySelector(".pza-hp-reminder-section");
  assert.equal(actions.querySelector(".form-footer"), dialog.footer, "Moves the original native footer");
  assert.equal(actions.querySelectorAll("button").length, 2);
  assert.ok(actions.compareDocumentPosition(reminder) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(actions.querySelector("button").form, root.querySelector("form"), "Buttons retain their form");
  assert.equal(await promptSetHeroPoints(), dialog);
  assert.equal(dialogs.length, 1);

  change(dialog, '[name="hero-action"]', "remove");
  assert.equal(root.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "1");
  root.querySelector('[data-hp-select="none"]').click();
  assert.equal(root.querySelector('[data-action="apply"]').disabled, true);
  assert.match(root.querySelector("[data-hp-summary]").textContent, /Select at least one/);
  assert.equal(root.querySelector("[data-hp-summary]").classList.contains("is-validation"), true);
  root.querySelector('[data-hp-select="all"]').click();
  assert.equal(root.querySelector("[data-hp-summary]").classList.contains("is-validation"), false);
  change(dialog, '[name="hero-action"]', "set");
  change(dialog, '[name="hero-amount"]', "");
  assert.equal(root.querySelector('[data-action="apply"]').disabled, true);
  await dialog.submit();
  assert.equal(dialog.rendered, true);
  assert.equal(writes.length, 0);
  change(dialog, '[name="hero-amount"]', "0");
  assert.equal(root.querySelector('[data-action="apply"]').disabled, false);
  assert.equal(root.querySelector('[data-action="apply"]').textContent, "Set to 0 Hero Points");
  assert.equal(root.querySelector('[data-hp-actor="two"] [data-hp-after]').textContent, "0");
  root.querySelector('[data-action="apply"]').click();
  await dialog.submission;
  assert.equal(dialog.rendered, false);
  assert.equal(first.system.resources.heroPoints.value, 0);
  assert.equal(second.system.resources.heroPoints.value, 0);
});

test("Cancel changes nothing and a failed write keeps the dialog open for correction", async () => {
  const first = actor("one", "One", 1);
  await reset([first]);
  let dialog = await promptSetHeroPoints();
  dialog.element.querySelector('[data-hp-select="all"]').click();
  dialog.element.querySelector('[data-action="cancel"]').click();
  await dialog.submission;
  assert.equal(dialog.rendered, false, "The relocated Cancel button still closes the dialog");
  assert.equal(writes.length, 0);
  first.update = async () => { throw new Error("The Actor could not be saved."); };
  dialog = await promptSetHeroPoints();
  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit();
  assert.equal(dialog.rendered, true);
  assert.equal(dialog.element.querySelector('[data-action="apply"]').disabled, false);
  assert.match(notices.at(-1).message, /could not be saved/);
  await dialog.close();
});

test("retrying a partial Add operation preserves the planned totals and does not reward a character twice", async () => {
  const first = actor("one", "One", 1);
  const second = actor("two", "Two", 1);
  const saveSecond = second.update;
  second.update = async () => { throw new Error("Save failed."); };
  await reset([first, second]);
  const dialog = await promptSetHeroPoints();
  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit();
  assert.equal(first.system.resources.heroPoints.value, 2);
  assert.equal(second.system.resources.heroPoints.value, 1);
  assert.equal(dialog.element.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "2");
  assert.equal(dialog.element.querySelector('[data-action="apply"]').textContent, "Retry update");
  second.update = saveSecond;
  change(dialog, '[name="hero-reminder-time"]', "20:30");
  assert.equal(dialog.element.querySelector('[data-action="apply"]').textContent, "Retry update");
  await dialog.submit();
  assert.equal(first.system.resources.heroPoints.value, 2);
  assert.equal(second.system.resources.heroPoints.value, 2);
  assert.equal(writes.filter(({ id }) => id === "one").length, 1);
  assert.equal(dialog.rendered, false);
  assert.deepEqual(messages.at(-1).whisper, ["gm"]);
});

test("a second Apply while a write is in progress cannot submit the change twice", async () => {
  const first = actor("one", "One", 1);
  const save = first.update;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  first.update = async function(data) { await gate; return save.call(this, data); };
  await reset([first]);
  const dialog = await promptSetHeroPoints();
  dialog.element.querySelector('[data-hp-select="all"]').click();
  const submitted = dialog.submit();
  assert.equal(dialog.element.querySelector('[data-action="apply"]').disabled, true);
  await dialog.submit();
  release();
  await submitted;
  assert.equal(writes.length, 1);
  assert.equal(first.system.resources.heroPoints.value, 2);
});

test("all selected player characters are prechecked while duplicate tokens, NPCs, and other characters are ignored", async () => {
  const first = actor("one", "One", 1);
  const second = actor("two", "Two", 1);
  const third = actor("three", "Three", 1);
  const npc = actor("npc", "NPC", 1, { type: "npc" });
  const gmCharacter = actor("gm-only", "GM Character", 1, { hasPlayerOwner: false });
  await reset([first, second, third, npc, gmCharacter]);
  canvas.tokens.controlled = [{ actor: first }, { actor: first }, { actor: second }, { actor: npc }, { actor: gmCharacter }];
  const dialog = await promptSetHeroPoints();
  assert.deepEqual([...dialog.element.querySelectorAll('[name="hero-character"]:checked')].map((input) => input.value), ["one", "two"]);
  assert.equal(dialog.element.querySelectorAll('[name="hero-character"]').length, 3);
  await dialog.submit();
  assert.deepEqual(writes.map((entry) => entry.id), ["one", "two"]);
});

test("chat results always whisper to all GMs without an audience selector", async () => {
  const first = actor("one", "One", 1);
  await reset([first]);
  game.users.push({ id: "other-gm", isGM: true });
  const dialog = await promptSetHeroPoints();
  assert.equal(dialog.element.querySelector('[name="hero-chat"]'), null);
  assert.doesNotMatch(dialog.element.textContent, /Share results/);
  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit();
  assert.deepEqual(messages[0].whisper, ["gm", "other-gm"]);
  await setHeroPoints(0, first, { mode: "set", chatVisibility: "public" });
  assert.deepEqual(messages[1].whisper, ["gm", "other-gm"], "Older callers cannot make the results public");
});

test("Create reminder saves a private reminder without applying Hero Points or closing the dialog", async () => {
  await reset([actor("one", "One", 1)]);
  const dialog = await promptSetHeroPoints();
  change(dialog, '[name="hero-reminder-time"]', "");
  assert.equal(dialog.element.querySelector('[data-hp-reminder]').disabled, true);
  change(dialog, '[name="hero-reminder-time"]', "20:30");
  const button = dialog.element.querySelector('[data-hp-reminder]');
  assert.equal(button.textContent, "Create reminder");
  assert.equal(button.disabled, false, "Creating a reminder does not require selected characters");
  button.click();
  await new Promise(setImmediate);
  assert.equal(reminderWrites.length, 1);
  assert.match(Object.keys(reminderWrites[0])[0], /^flags\.pf2e-zone-automation\.heroPointReminders\.[a-zA-Z0-9]{16}$/);
  assert.match(dialog.element.querySelector('[data-hp-reminder-status]').textContent, /Private reminder set for/);
  assert.equal(dialog.rendered, true);
  assert.equal(writes.length, 0);
  assert.equal(messages.length, 0);
  assert.equal(dialog.element.querySelector('[data-hp-clear-reminders]').hidden, false);
  button.click();
  await new Promise(setImmediate);
  assert.equal(reminderWrites.length, 1, "The same scheduled time is reused");
  await dialog.close();
});

test("Clear Reminders is shown only for the GM's pending reminders and clears them without applying points or closing", async () => {
  await reset([actor("one", "One", 1)]);
  const otherGM = { id: "other-gm", isGM: true, flags: { "pf2e-zone-automation": { heroPointReminders: {
    OtherGMReminder1: { remindAt: Date.now() + 3_600_000 }
  } } } };
  game.users.push(otherGM);
  const dialog = await promptSetHeroPoints();
  const button = dialog.element.querySelector('[data-hp-clear-reminders]');
  assert.equal(button.hidden, true, "Another GM's reminder does not reveal the button");
  await game.user.update({
    "flags.pf2e-zone-automation.heroPointReminders.FirstReminder001": { remindAt: Date.now() + 3_600_000 },
    "flags.pf2e-zone-automation.heroPointReminders.SecondReminder01": { remindAt: Date.now() + 7_200_000 }
  });
  assert.equal(button.hidden, false, "Updates from another client immediately reveal the button");
  assert.equal(button.textContent, "Clear Reminders");
  change(dialog, '[name="hero-reminder-time"]', "");
  assert.equal(button.disabled, false, "Clearing does not require a valid new reminder time or selected characters");
  button.click();
  await new Promise(setImmediate);
  assert.deepEqual(game.user.flags["pf2e-zone-automation"].heroPointReminders, {});
  assert.equal(button.hidden, true);
  assert.equal(dialog.rendered, true);
  assert.match(dialog.element.querySelector('[data-hp-reminder-status]').textContent, /All your Hero Point reminders cleared/);
  assert.equal(writes.length, 0);
  assert.equal(messages.length, 0);
  assert.ok(otherGM.flags["pf2e-zone-automation"].heroPointReminders.OtherGMReminder1);
  await game.user.update({ "flags.pf2e-zone-automation.heroPointReminders.FirstReminder001": { remindAt: Date.now() + 3_600_000 } });
  assert.equal(button.hidden, false);
  await game.user.update({ "flags.pf2e-zone-automation.heroPointReminders.FirstReminder001": new ForcedDeletion() });
  assert.equal(button.hidden, true, "Delivery or clearing on another client hides the button immediately");
});

test("reminder clearing ignores duplicate clicks, locks other actions, and retains a failed save for retry", async () => {
  await reset([actor("one", "One", 1)]);
  game.user.flags["pf2e-zone-automation"].heroPointReminders.FirstReminder001 = { remindAt: Date.now() + 3_600_000 };
  const save = game.user.update;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  game.user.update = async () => { attempts++; await gate; throw new Error("Clear failed."); };
  const dialog = await promptSetHeroPoints();
  const button = dialog.element.querySelector('[data-hp-clear-reminders]');
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(dialog.element.querySelector('[data-hp-reminder]').disabled, true);
  assert.equal(dialog.element.querySelector('[data-action="cancel"]').disabled, true);
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await dialog.submit();
  assert.equal(attempts, 1);
  release();
  await new Promise(setImmediate);
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, false);
  assert.equal(dialog.rendered, true);
  assert.equal(notices.at(-1).message, "Clear failed.");
  game.user.update = save;
  button.click();
  await new Promise(setImmediate);
  assert.equal(button.hidden, true);
  assert.equal(writes.length, 0);
});

test("reminder creation prevents duplicate clicks and a save failure lets the GM retry", async () => {
  await reset([actor("one", "One", 1)]);
  const save = game.user.update;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  game.user.update = async function(data) { await gate; return save.call(this, data); };
  const dialog = await promptSetHeroPoints();
  const button = dialog.element.querySelector('[data-hp-reminder]');
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(dialog.element.querySelector('[data-action="cancel"]').disabled, true);
  button.click();
  await dialog.submit();
  release();
  await new Promise(setImmediate);
  assert.equal(reminderWrites.length, 1);
  assert.equal(writes.length, 0);
  change(dialog, '[name="hero-reminder-time"]', "01:00");
  game.user.update = async () => { throw new Error("Reminder save failed."); };
  button.click();
  await new Promise(setImmediate);
  assert.equal(dialog.rendered, true);
  assert.equal(button.disabled, false);
  assert.equal(notices.at(-1).message, "Reminder save failed.");
  assert.equal(dialog.element.querySelector('[data-hp-reminder-status]').textContent, "Reminder save failed.");
  await dialog.close();
});
