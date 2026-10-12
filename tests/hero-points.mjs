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

class TestDialog extends window.EventTarget {
  constructor(options) {
    super();
    this.options = options;
    this.rendered = false;
    this.element = document.createElement("section");
    const form = document.createElement("form");
    form.append(options.content);
    for (const config of options.buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = config.action;
      button.textContent = config.label;
      form.append(button);
    }
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

globalThis.foundry = { applications: { api: { DialogV2: TestDialog } } };
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
  dialogs.length = notices.length = messages.length = writes.length = 0;
  game.actors = actors;
  game.user = { id: "gm", isGM: true, targets: new Set() };
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
  assert.equal(dialog.options.form.closeOnSubmit, false);
  assert.equal(root.querySelectorAll('[name="hero-character"]').length, 2);
  assert.equal(root.querySelector('[value="one"]').checked, true);
  assert.equal(root.querySelector('[value="two"]').checked, false);
  assert.equal(root.querySelectorAll(".pza-hp-name span")[0].textContent, "A <Hero>");
  assert.equal(root.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "3");
  assert.equal(root.querySelector('[data-action="apply"]').textContent, "Add 1 Hero Point");
  assert.equal(await promptSetHeroPoints(), dialog);
  assert.equal(dialogs.length, 1);

  change(dialog, '[name="hero-action"]', "remove");
  assert.equal(root.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "1");
  root.querySelector('[data-hp-select="none"]').click();
  assert.equal(root.querySelector('[data-action="apply"]').disabled, true);
  assert.match(root.querySelector("[data-hp-summary]").textContent, /Select at least one/);
  root.querySelector('[data-hp-select="all"]').click();
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
  await dialog.submit();
  assert.equal(dialog.rendered, false);
  assert.equal(first.system.resources.heroPoints.value, 0);
  assert.equal(second.system.resources.heroPoints.value, 0);
});

test("Cancel changes nothing and a failed write keeps the dialog open for correction", async () => {
  const first = actor("one", "One", 1);
  await reset([first]);
  let dialog = await promptSetHeroPoints();
  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit("cancel");
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
  await dialog.submit();
  assert.equal(first.system.resources.heroPoints.value, 2);
  assert.equal(second.system.resources.heroPoints.value, 2);
  assert.equal(writes.filter(({ id }) => id === "one").length, 1);
  assert.equal(dialog.rendered, false);
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
