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
const actorHooks = new Map();
const socketMessages = [];
let socketListener;

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

  bringToFront() {
    this.front = true;
  }

  async submit(action = "apply") {
    const button = this.element.querySelector(`[data-action="${action}"]`);

    return this.options.buttons.find((entry) => entry.action === action).callback(null, button, this.element);
  }
}

globalThis.foundry = { applications: { api: { DialogV2: TestDialog } }, data: { operators: { ForcedDeletion } } };
globalThis.Hooks = {
  on(name, callback) {
    const id = Symbol(name);

    if (name === "updateUser") userHooks.set(id, callback);
    else {
      assert.ok(["updateActor", "deleteActor"].includes(name));
      actorHooks.set(id, { name, callback });
    }

    return id;
  },
  off(name, id) {
    (name === "updateUser" ? userHooks : actorHooks).delete(id);
  }
};

globalThis.ui = {
  notifications: {
    error: (message) => notices.push({ level: "error", message }),
    warn: (message) => notices.push({ level: "warn", message })
  }
};

globalThis.ChatMessage = {
  create: async (data) => {
    messages.push(data);
  }
};

globalThis.canvas = { tokens: { controlled: [], placeables: [] } };
globalThis.game = {
  system: { id: "pf2e" },
  actors: [],
  users: [{ id: "gm", isGM: true }, { id: "player", isGM: false }],
  user: { id: "gm", isGM: true, targets: new Set() }
};

const { promptSetHeroPoints, setHeroPoints } = await import("../scripts/hero-points.js");
const { executeHeroPointChange } = await import("../scripts/hero-points-worker.js");
const { registerZoneSocket } = await import("../scripts/transport.js");

function actor(id, name, value, extra = {}) {
  return {
    id,
    name,
    type: "character",
    hasPlayerOwner: true,
    flags: {},
    system: { resources: { heroPoints: { value, max: 3 } } },
    async update(data) {
      writes.push({ id, data });
      this.system.resources.heroPoints.value = data["system.resources.heroPoints.value"];

      if (data["flags.pf2e-zone-automation.heroPointOperation"]) {
        this.flags["pf2e-zone-automation"] ??= {};
        this.flags["pf2e-zone-automation"].heroPointOperation = data["flags.pf2e-zone-automation.heroPointOperation"];
      }
    },
    ...extra
  };
}

async function reset(actors = []) {
  for (const dialog of dialogs) if (dialog.rendered) await dialog.close();

  assert.equal(userHooks.size, 0, "Closed dialogs release their reminder hooks");
  assert.equal(actorHooks.size, 0, "Closed dialogs release their Actor hooks");
  dialogs.length = notices.length = messages.length = writes.length = reminderWrites.length = 0;
  game.actors = actors;
  game.actors.get = (id) => game.actors.find((entry) => entry.id === id);
  game.user = {
    id: "gm",
    isGM: true,
    active: true,
    targets: new Set(),
    flags: { "pf2e-zone-automation": { heroPointReminders: {} } },
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

  game.users = [game.user, { id: "player", isGM: false, active: true }];
  game.users.get = (id) => game.users.find((entry) => entry.id === id);
  game.users.activeGM = game.user;
  game.socket = {
    connected: true,
    on: (_channel, callback) => {
      socketListener = callback;
    },
    emit: (_channel, message) => socketMessages.push(message)
  };

  socketMessages.length = 0;
  registerZoneSocket();
  canvas.tokens.controlled = [];
}

async function waitForButton(button) {
  const deadline = Date.now() + 2000;

  while (button.disabled) {
    assert.ok(Date.now() < deadline, "The asynchronous reminder action should finish");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
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
  assert.deepEqual(writes.map(({ id, data }) => ({ id, data: { "system.resources.heroPoints.value": data["system.resources.heroPoints.value"] } })), [
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

test("unowned characters, invalid amounts, and ambiguous or missing recipients cannot change Hero Points", async () => {
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
  assert.match(notices.at(-1).message, /No characters you own/);
  await assert.rejects(setHeroPoints(1, first), /Choose at least one/);
  assert.equal(writes.length, 0);
});

test("a player's dialog and API show only owned characters and submit all six choices through the GM", async () => {
  const first = actor("player-owned", "Owned", 1, { testUserPermission: user => user.id === "player" });
  const shared = actor("player-shared", "Shared", 0, { testUserPermission: user => ["player", "other-player"].includes(user.id) });
  const other = actor("player-unowned", "Secret character name", 2, { testUserPermission: () => false });

  await reset([first, shared, other]);

  const gm = game.user;
  const player = game.users.get("player");

  player.targets = new Set();
  game.user = player;

  const dialog = await promptSetHeroPoints();

  assert.deepEqual(
    [...dialog.element.querySelectorAll("[data-hp-actor]")].map(row => row.dataset.hpActor),
    [first.id, shared.id]
  );

  assert.doesNotMatch(dialog.element.textContent, /Secret character name/);
  assert.equal(dialog.element.querySelector('[name="hero-change"]').options.length, 6);
  assert.match(dialog.element.textContent, /award your characters/);
  await assert.rejects(setHeroPoints(1, other), /Choose at least one/);

  for (const [choice, expected] of [["give-1", 2], ["spend-1", 1], ["set-0", 0], ["set-1", 1], ["set-2", 2], ["set-3", 3]]) {
    const opened = await promptSetHeroPoints();

    change(opened, '[name="hero-change"]', choice);

    const checkbox = opened.element.querySelector(`[name="hero-character"][value="${first.id}"]`);

    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(opened.element.querySelector('[data-action="apply"]').disabled, false);

    const submitting = opened.submit();
    const request = socketMessages.shift();

    assert.equal(request.request.requesterUserId, player.id);
    assert.deepEqual(request.request.actorIds, [first.id]);
    game.user = gm;
    await socketListener(request, player.id);

    const reply = socketMessages.shift();

    game.user = player;
    await socketListener(reply, gm.id);
    await submitting;
    assert.equal(opened.rendered, false);
    assert.equal(first.system.resources.heroPoints.value, expected);
  }

  assert.equal(other.system.resources.heroPoints.value, 2);
  assert.ok(messages.every(message => message.whisper.includes(player.id) && message.whisper.includes(gm.id)));
  assert.ok(messages.every(message => message.author === player.id && message.user === undefined));
  assert.ok(messages.every(message => !message.whisper.includes("other-player")));
});

test("the worker rejects mixed owned/unowned requests before any write and rechecks ownership on cached results", async () => {
  const owned = actor("worker-owned", "Owned", 0, { testUserPermission: () => true });
  const unowned = actor("worker-unowned", "Secret", 0, { testUserPermission: () => false });

  await reset([owned, unowned]);

  const request = {
    requesterUserId: "player",
    actorIds: [owned.id, unowned.id],
    amount: 1,
    mode: "add",
    operationId: "PlayerMixedOp001"
  };

  await assert.rejects(executeHeroPointChange(request), /characters you own/);
  assert.equal(writes.length, 0);

  const ownRequest = { ...request, actorIds: [owned.id], operationId: "PlayerCachedOp01" };

  assert.equal((await executeHeroPointChange(ownRequest)).ok, true);
  owned.testUserPermission = () => false;
  await assert.rejects(executeHeroPointChange(ownRequest), /characters you own/);
  assert.equal(writes.length, 1);
});

test("queued player Hero Point changes stop after ownership is revoked and omit unauthorized results", async () => {
  const owned = actor("queued-player-owned", "Secret after revocation", 0, { testUserPermission: () => true });

  await reset([owned]);

  const save = owned.update;
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();

  owned.update = async function(data) {
    started.resolve();
    await gate.promise;

    return save.call(this, data);
  };

  const first = setHeroPoints(1, owned);

  await started.promise;

  const second = executeHeroPointChange({
    requesterUserId: "player",
    actorIds: [owned.id],
    amount: 1,
    mode: "add",
    operationId: "RevokedPlayerOp01"
  });

  owned.testUserPermission = () => false;
  gate.resolve();
  await first;

  const rejected = await second;

  assert.equal(rejected.ok, false);
  assert.equal(rejected.retryable, false);
  assert.equal(rejected.errorCode, "PF2E_ZONE_HERO_POINTS_PERMISSION");
  assert.deepEqual(rejected.plan, []);
  assert.deepEqual(rejected.changes, []);
  assert.doesNotMatch(JSON.stringify(rejected), /Secret after revocation/);
  assert.equal(owned.system.resources.heroPoints.value, 1);
  assert.equal(writes.length, 1);
});

test("open player dialogs remove revoked/deleted characters and release all hooks on close", async () => {
  const owned = actor("live-player-owned", "Owned", 1, { testUserPermission: () => true });
  const deleted = actor("live-player-deleted", "Deleted", 1, { testUserPermission: () => true });

  await reset([owned, deleted]);
  game.user = game.users.get("player");

  const dialog = await promptSetHeroPoints();

  owned.testUserPermission = () => false;
  for (const { name, callback } of actorHooks.values()) if (name === "updateActor") callback(owned);

  assert.equal(dialog.element.querySelector(`[data-hp-actor="${owned.id}"]`), null);
  game.actors.splice(game.actors.indexOf(deleted), 1);
  for (const { name, callback } of actorHooks.values()) if (name === "deleteActor") callback(deleted);

  assert.equal(dialog.element.querySelectorAll("[data-hp-actor]").length, 0);
  assert.equal(dialog.element.querySelector('[data-action="apply"]').disabled, true);
  await dialog.close();
  assert.equal(actorHooks.size + userHooks.size, 0);
});

test("independent concurrent awards read the latest total inside the Actor queue", async () => {
  const first = actor("parallel-awards", "One", 0);

  await reset([first]);

  const save = first.update;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maximumActive = 0;

  first.update = async function(data) {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate;
    await save.call(this, data);
    active -= 1;
  };

  const firstAward = setHeroPoints(1, first);
  const secondAward = setHeroPoints(1, first);

  await new Promise(setImmediate);
  assert.equal(active, 1);
  release();

  const [firstResult, secondResult] = await Promise.all([firstAward, secondAward]);

  assert.equal(first.system.resources.heroPoints.value, 2);
  assert.equal(maximumActive, 1);
  assert.deepEqual([firstResult[0], secondResult[0]].map(({ before, after }) => [before, after]), [[0, 1], [1, 2]]);
});

test("parallel spends and mixed awards preserve both changes and resource bounds", async () => {
  const first = actor("parallel-spends", "One", 2);

  await reset([first]);
  await Promise.all([setHeroPoints(1, first, { mode: "remove" }), setHeroPoints(1, first, { mode: "remove" })]);
  assert.equal(first.system.resources.heroPoints.value, 0);
  await Promise.all([setHeroPoints(1, first), setHeroPoints(1, first, { mode: "remove" })]);
  assert.equal(first.system.resources.heroPoints.value, 0);
  await Promise.all([setHeroPoints(3, first), setHeroPoints(1, first)]);
  assert.equal(first.system.resources.heroPoints.value, 3);
});

test("a blocked Actor does not block an unrelated Hero Point change", async () => {
  const first = actor("blocked", "One", 0);
  const second = actor("unblocked", "Two", 0);

  await reset([first, second]);

  const save = first.update;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  first.update = async function(data) {
    await gate;

    return save.call(this, data);
  };

  const blocked = setHeroPoints(1, first);

  try {
    await setHeroPoints(1, second);
    assert.equal(first.system.resources.heroPoints.value, 0);
    assert.equal(second.system.resources.heroPoints.value, 1);
  } finally {
    release();
    await blocked;
  }
});

test("duplicate operation IDs join once, preserve completed edits, and reject changed request details", async () => {
  const first = actor("duplicate-operation", "One", 0);

  await reset([first]);

  const operationId = "HeroDuplicateOp00001";
  const [one, two] = await Promise.all([
    setHeroPoints(1, first, { operationId }), setHeroPoints(1, first, { operationId })
  ]);

  assert.deepEqual(one, two);
  assert.equal(writes.length, 1);
  assert.equal(messages.length, 1);
  await setHeroPoints(1, first);
  await setHeroPoints(1, first, { operationId, retry: true });
  assert.equal(first.system.resources.heroPoints.value, 2);
  assert.equal(writes.length, 2);
  assert.equal(messages.length, 2);
  await assert.rejects(setHeroPoints(2, first, { operationId }), /reused with different details/);
});

test("a committed Actor update with a lost acknowledgment is not awarded twice", async () => {
  const first = actor("lost-actor-reply", "One", 0);

  await reset([first]);

  const save = first.update;

  first.update = async function(data) {
    await save.call(this, data);

    throw new Error("Reply lost after save.");
  };

  const operationId = "HeroLostReplyOp00001";

  await setHeroPoints(1, first, { operationId });
  await setHeroPoints(1, first, { operationId, retry: true });
  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(writes.length, 1);
  assert.equal(messages.length, 1);
});

test("an unavailable or expired retry plan fails closed without applying a fresh award", async () => {
  const first = actor("expired-retry", "One", 0);

  await reset([first]);
  await assert.rejects(setHeroPoints(1, first, { operationId: "UnknownHeroOp00001", retry: true }), /no longer available/);

  const operationId = "ExpiringHeroOp00001";

  await setHeroPoints(1, first, { operationId });

  const originalNow = Date.now;
  const later = Date.now() + 600_001;

  Date.now = () => later;

  try {
    await assert.rejects(setHeroPoints(1, first, { operationId, retry: true }), /no longer available/);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(writes.length, 1);
});

test("a fresh GM worker refuses retries and late initial submissions whose committed receipt outlives its plan", async () => {
  const first = actor("fresh-worker-retry", "One", 0);

  await reset([first]);

  const operationId = "FreshWorkerHero00001";

  await setHeroPoints(1, first, { operationId });

  const { executeHeroPointChange } = await import("../scripts/hero-points-worker.js?fresh-worker-retry");
  const request = {
    requesterUserId: game.user.id,
    actorIds: [first.id],
    amount: 1,
    mode: "add",
    operationId
  };

  await assert.rejects(executeHeroPointChange({ ...request, retry: true }), /no longer available/);
  await assert.rejects(executeHeroPointChange(request), /no longer available/);
  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(writes.length, 1);
});

test("a cancelled Actor update stays pending and a later retry applies the award once", async () => {
  const first = actor("cancelled-update", "One", 0);

  await reset([first]);

  const save = first.update;

  first.update = async () => undefined;

  let failure;

  try {
    await setHeroPoints(1, first);
  } catch (error) {
    failure = error;
  }

  assert.match(failure.message, /not confirmed/);
  assert.equal(failure.retryable, true);
  assert.equal(messages.length, 0);
  first.update = save;
  await setHeroPoints(1, first, { operationId: failure.operationId, retry: true });
  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(writes.length, 1);
});

test("a queued change rechecks GM authority after an earlier Actor write finishes", async () => {
  const first = actor("handoff-queued", "One", 0);

  await reset([first]);

  const save = first.update;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  first.update = async function(data) {
    await gate;

    return save.call(this, data);
  };

  const firstAward = setHeroPoints(1, first);
  const queuedAward = setHeroPoints(1, first);
  const rejected = assert.rejects(queuedAward, /active GM/);

  await new Promise(setImmediate);

  const originalGM = game.users.activeGM;

  game.users.activeGM = { id: "replacement-gm", isGM: true, active: true };

  try {
    release();
    await Promise.all([firstAward, rejected]);
  } finally {
    game.users.activeGM = originalGM;
  }

  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(writes.length, 1);
});

test("one dropdown guides selection, previews Give/Spend/Set, validates the choice, and applies exact zero totals", async () => {
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
  assert.deepEqual([...root.querySelector('[name="hero-change"]').options].map((option) => option.textContent), [
    "Give 1 hero point", "Spend 1 hero point", "Set hero points to 0", "Set hero points to 1", "Set hero points to 2", "Set hero points to 3"
  ]);

  assert.equal(root.querySelector('[name="hero-action"]'), null);
  assert.equal(root.querySelector('[name="hero-amount"]'), null);
  assert.equal(root.querySelectorAll('[name="hero-character"]').length, 2);
  assert.equal(root.querySelector('[value="one"]').checked, true);
  assert.equal(root.querySelector('[value="two"]').checked, false);
  assert.equal(root.querySelectorAll(".pza-hp-name span")[0].textContent, "A <Hero>");
  assert.equal(root.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "3");
  assert.equal(root.querySelector('[data-action="apply"]').textContent, "Give 1 hero point");

  const actions = root.querySelector(".pza-hp-actions");
  const reminder = root.querySelector(".pza-hp-reminder-section");

  assert.equal(actions.querySelector(".form-footer"), dialog.footer, "Moves the original native footer");
  assert.equal(actions.querySelectorAll("button").length, 2);
  assert.ok(actions.compareDocumentPosition(reminder) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(actions.querySelector("button").form, root.querySelector("form"), "Buttons retain their form");
  assert.equal(await promptSetHeroPoints(), dialog);
  assert.equal(dialogs.length, 1);

  change(dialog, '[name="hero-change"]', "spend-1");
  assert.equal(root.querySelector('[data-hp-actor="one"] [data-hp-after]').textContent, "1");
  root.querySelector('[data-hp-select="none"]').click();
  assert.equal(root.querySelector('[data-action="apply"]').disabled, true);
  assert.match(root.querySelector("[data-hp-summary]").textContent, /Select at least one/);
  assert.equal(root.querySelector("[data-hp-summary]").classList.contains("is-validation"), true);
  root.querySelector('[data-hp-select="all"]').click();
  assert.equal(root.querySelector("[data-hp-summary]").classList.contains("is-validation"), false);
  change(dialog, '[name="hero-change"]', "");
  assert.equal(root.querySelector('[data-action="apply"]').disabled, true);
  await dialog.submit();
  assert.equal(dialog.rendered, true);
  assert.equal(writes.length, 0);
  change(dialog, '[name="hero-change"]', "set-0");
  assert.equal(root.querySelector('[data-action="apply"]').disabled, false);
  assert.equal(root.querySelector('[data-action="apply"]').textContent, "Set hero points to 0");
  assert.equal(root.querySelector('[data-hp-actor="two"] [data-hp-after]').textContent, "0");
  root.querySelector('[data-action="apply"]').click();
  await dialog.submission;
  assert.equal(dialog.rendered, false);
  assert.equal(first.system.resources.heroPoints.value, 0);
  assert.equal(second.system.resources.heroPoints.value, 0);
});

test("each dropdown choice previews and saves the correct bounded totals for characters with zero through three points", async () => {
  for (const [choice, expected] of [
    ["give-1", [1, 2, 3, 3]],
    ["spend-1", [0, 0, 1, 2]],
    ["set-0", [0, 0, 0, 0]],
    ["set-1", [1, 1, 1, 1]],
    ["set-2", [2, 2, 2, 2]],
    ["set-3", [3, 3, 3, 3]]
  ]) {
    const actors = [0, 1, 2, 3].map((points) => actor(`pc${points}`, `Character ${points}`, points));

    await reset(actors);

    const dialog = await promptSetHeroPoints();

    dialog.element.querySelector('[data-hp-select="all"]').click();
    change(dialog, '[name="hero-change"]', choice);
    assert.deepEqual(
      [...dialog.element.querySelectorAll('[data-hp-after]')].map((cell) => Number(cell.textContent)),
      expected,
      choice
    );

    assert.equal(writes.length, 0, "Previewing does not spend or award points");
    await dialog.submit();
    assert.deepEqual(actors.map((entry) => entry.system.resources.heroPoints.value), expected, choice);
    assert.deepEqual(messages[0].whisper, ["gm"]);
    assert.equal(dialog.rendered, false);
  }
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

  first.update = async () => {
    throw new Error("The Actor could not be saved.");
  };

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

  second.update = async () => {
    throw new Error("Save failed.");
  };

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

test("a retry never restores an old total on a character already updated before partial failure", async () => {
  const first = actor("completed-before-retry", "One", 1);
  const second = actor("failed-before-retry", "Two", 1);
  const saveSecond = second.update;

  second.update = async () => {
    throw new Error("Save failed.");
  };

  await reset([first, second]);

  const dialog = await promptSetHeroPoints();

  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit();
  await setHeroPoints(1, first, { mode: "remove" });
  second.update = saveSecond;
  await dialog.submit();
  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(second.system.resources.heroPoints.value, 2);
  assert.equal(writes.filter(({ id }) => id === first.id).length, 2);
  assert.equal(dialog.rendered, false);
});

test("an external resource edit after partial failure rejects the frozen retry and restores a fresh preview", async () => {
  const first = actor("stale-completed", "One", 1);
  const second = actor("stale-pending", "Two", 1);
  const saveSecond = second.update;

  second.update = async () => {
    throw new Error("Save failed.");
  };

  await reset([first, second]);

  const dialog = await promptSetHeroPoints();

  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit();
  second.system.resources.heroPoints.value = 0;
  second.update = saveSecond;
  await dialog.submit();
  assert.equal(second.system.resources.heroPoints.value, 0);
  assert.equal(writes.filter(({ id }) => id === second.id).length, 0);
  assert.equal(dialog.rendered, true);
  assert.match(notices.at(-1).message, /changed.*Review the totals/);
  assert.equal(dialog.element.querySelector('[data-action="apply"]').textContent, "Give 1 hero point");
  assert.equal(dialog.element.querySelector('[data-hp-actor="stale-pending"] [data-hp-after]').textContent, "1");
  await dialog.close();
});

test("retry conflicts include changed maxima and intervening module operations even when the total returns to its original value", async () => {
  for (const cause of ["maximum", "operation"]) {
    const first = actor(`retry-${cause}`, "One", 1);

    await reset([first]);

    const save = first.update;

    first.update = async () => {
      throw new Error("Save failed.");
    };

    let failure;

    try {
      await setHeroPoints(1, first);
    } catch (error) {
      failure = error;
    }

    assert.equal(failure.retryable, true);
    first.update = save;

    if (cause === "maximum") first.system.resources.heroPoints.max = 1;
    else {
      await setHeroPoints(1, first);
      await setHeroPoints(1, first, { mode: "remove" });
    }

    const count = writes.length;

    await assert.rejects(setHeroPoints(1, first, { operationId: failure.operationId, retry: true }), (error) => {
      assert.equal(error.code, "PF2E_ZONE_HERO_POINTS_CONFLICT");
      assert.equal(error.retryable, false);

      return true;
    });

    assert.equal(first.system.resources.heroPoints.value, 1);
    assert.equal(writes.length, count);
  }
});

test("choosing a different dropdown action after a partial failure starts a new operation", async () => {
  const first = actor("one", "One", 1);
  const second = actor("two", "Two", 1);
  const saveSecond = second.update;

  second.update = async () => {
    throw new Error("Save failed.");
  };

  await reset([first, second]);

  const dialog = await promptSetHeroPoints();

  dialog.element.querySelector('[data-hp-select="all"]').click();
  await dialog.submit();
  assert.equal(dialog.element.querySelector('[data-action="apply"]').textContent, "Retry update");
  second.update = saveSecond;
  change(dialog, '[name="hero-change"]', "spend-1");
  assert.equal(dialog.element.querySelector('[data-action="apply"]').textContent, "Spend 1 hero point");
  assert.deepEqual([...dialog.element.querySelectorAll('[data-hp-after]')].map((cell) => cell.textContent), ["1", "0"]);
  await dialog.submit();
  assert.equal(first.system.resources.heroPoints.value, 1);
  assert.equal(second.system.resources.heroPoints.value, 0);
});

test("a second Apply while a write is in progress cannot submit the change twice", async () => {
  const first = actor("one", "One", 1);
  const save = first.update;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  first.update = async function(data) {
    await gate;

    return save.call(this, data);
  };

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

  assert.deepEqual(
    [...dialog.element.querySelectorAll('[name="hero-character"]:checked')].map((input) => input.value),
    ["one", "two"]
  );

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
  await waitForButton(button);
  assert.equal(reminderWrites.length, 1);
  assert.match(Object.keys(reminderWrites[0])[0], /^flags\.pf2e-zone-automation\.heroPointReminders\.[a-zA-Z0-9]{16}$/);
  assert.match(dialog.element.querySelector('[data-hp-reminder-status]').textContent, /Private reminder set for/);
  assert.equal(dialog.rendered, true);
  assert.equal(writes.length, 0);
  assert.equal(messages.length, 0);
  assert.equal(dialog.element.querySelector('[data-hp-clear-reminders]').hidden, false);
  button.click();
  await waitForButton(button);
  assert.equal(reminderWrites.length, 1, "The same scheduled time is reused");
  await dialog.close();
});

test("Clear Reminders is shown only for the GM's pending reminders and clears them without applying points or closing", async () => {
  await reset([actor("one", "One", 1)]);

  const otherGM = {
    id: "other-gm",
    isGM: true,
    flags: {
      "pf2e-zone-automation": {
        heroPointReminders: {
          OtherGMReminder1: { remindAt: Date.now() + 3_600_000 }
        }
      }
    }
  };

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
  assert.match(
    dialog.element.querySelector('[data-hp-reminder-status]').textContent,
    /All your Hero Point reminders cleared/
  );

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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let attempts = 0;

  game.user.update = async () => {
    attempts++;
    await gate;

    throw new Error("Clear failed.");
  };

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
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  game.user.update = async function(data) {
    await gate;

    return save.call(this, data);
  };

  const dialog = await promptSetHeroPoints();
  const button = dialog.element.querySelector('[data-hp-reminder]');

  button.click();
  assert.equal(button.disabled, true);
  assert.equal(dialog.element.querySelector('[data-action="cancel"]').disabled, true);
  button.click();
  await dialog.submit();
  release();
  await waitForButton(button);
  assert.equal(reminderWrites.length, 1);
  assert.equal(writes.length, 0);
  change(dialog, '[name="hero-reminder-time"]', "01:00");

  game.user.update = async () => {
    throw new Error("Reminder save failed.");
  };

  button.click();
  await waitForButton(button);
  assert.equal(dialog.rendered, true);
  assert.equal(button.disabled, false);
  assert.equal(notices.at(-1).message, "Reminder save failed.");
  assert.equal(dialog.element.querySelector('[data-hp-reminder-status]').textContent, "Reminder save failed.");
  await dialog.close();
});
