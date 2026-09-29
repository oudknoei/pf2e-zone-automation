import assert from "node:assert/strict";
import test from "node:test";

globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
let randomId = 0;
globalThis.foundry = { utils: { randomID: () => `pending-${++randomId}` } };
globalThis._replace = (payload) => payload;

const gm = { id: "gm", isGM: true, active: true };
globalThis.game = {
  system: { id: "pf2e" },
  actors: { contents: [] },
  scenes: { contents: [] },
  messages: { contents: [] },
  users: { activeGM: gm, get: (id) => id === gm.id ? gm : null },
  user: gm,
  time: { worldTime: 42 }
};

const notices = [];
globalThis.ui = { notifications: { error: (message) => notices.push(message) } };

const messages = [];
let createCalls = 0;
let failCreation = false;
globalThis.ChatMessage = {
  getSpeaker: () => ({ alias: "Zone Source" }),
  async create(data) {
    createCalls++;
    if (failCreation) throw new Error("injected chat creation failure");
    const message = { id: `message-${createCalls}`, author: gm, ...data };
    messages.push(message);
    return message;
  }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

/** Builds a live Region with one save block and mutable persisted state. */
function saveFixture() {
  messages.length = 0;
  notices.length = 0;
  createCalls = 0;
  failCreation = false;

  const scene = { id: "scene", regions: new Map() };
  const actor = { id: "target", uuid: "Actor.target" };
  const token = { id: "target-token", uuid: "Scene.scene.Token.target-token", name: "Target", actor };
  const block = {
    id: "block",
    name: "Hazard Save",
    repeat: "once-per-zone",
    save: { type: "reflex", dc: { mode: "custom", value: 25 } }
  };
  let stored = {
    config: { name: "Test Zone", effects: [block] },
    state: { activationProcessed: true }
  };
  const region = {
    id: "zone",
    uuid: "Scene.scene.Region.zone",
    name: "Test Zone",
    parent: scene,
    behaviors: [{ name: "PF2e Zone Runtime", disabled: false }],
    getFlag: () => stored,
    async update(changes) {
      stored = structuredClone(changes["flags.world.pf2eZone"]);
    }
  };
  scene.regions.set(region.id, region);
  game.scenes = { contents: [scene], get: (id) => id === scene.id ? scene : null };
  game.messages = {
    contents: messages,
    get: (id) => messages.find((message) => message.id === id) ?? null
  };
  globalThis.fromUuid = async (uuid) => uuid === token.uuid || uuid === actor.uuid
    ? (uuid === token.uuid ? token : actor) : null;

  return {
    actor, block, region, token,
    get createCalls() { return createCalls; },
    get stored() { return stored; },
    setCreationFailure(value) { failCreation = value; },
    loseDeliveryReceipt() {
      const pending = Object.values(stored.state.pendingSaves)[0];
      pending.delivery.status = "undelivered";
      pending.delivery.messageId = null;
      pending.delivery.lastError = "uncertain persistence";
    }
  };
}

test("a failed save-card creation stays visible and retryable without consuming the pending save", async () => {
  const fixture = saveFixture();
  fixture.setCreationFailure(true);

  const accepted = await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "batch")
  );
  assert.equal(accepted, true);

  const [pending] = Object.values(fixture.stored.state.pendingSaves);
  assert.equal(fixture.createCalls, 1);
  assert.equal(pending.delivery.status, "undelivered");
  assert.equal(pending.delivery.attempts, 1);
  assert.equal(pending.delivery.messageId, null);
  assert.match(pending.delivery.lastError, /injected chat creation failure/);
  assert.match(notices[0], /remains queued/i);
  assert.ok(fixture.stored.state.repeat[runtime.repeatKey(fixture.token.uuid, fixture.block.id)]?.zone);

  fixture.setCreationFailure(false);
  await runtime.reconcileUndeliveredSaveRequests();
  const recovered = fixture.stored.state.pendingSaves[pending.id];
  assert.equal(fixture.createCalls, 2);
  assert.equal(messages.length, 1);
  assert.equal(recovered.delivery.status, "delivered");
  assert.equal(recovered.delivery.attempts, 2);
  assert.equal(recovered.delivery.messageId, messages[0].id);
  assert.equal(recovered.delivery.lastError, null);
  assert.ok(fixture.stored.state.pendingSaves[pending.id], "delivery recovery must not resolve the save");

  await runtime.reconcileUndeliveredSaveRequests();
  assert.equal(fixture.createCalls, 2, "a delivered request is not posted twice");
});

test("recovery rediscovers an existing card when its delivery receipt was not persisted", async () => {
  const fixture = saveFixture();
  await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "batch")
  );
  const [pending] = Object.values(fixture.stored.state.pendingSaves);
  assert.equal(fixture.createCalls, 1);
  fixture.loseDeliveryReceipt();

  await runtime.reconcileUndeliveredSaveRequests();
  const recovered = fixture.stored.state.pendingSaves[pending.id];
  assert.equal(fixture.createCalls, 1, "an existing identifier makes delivery idempotent");
  assert.equal(messages.length, 1);
  assert.equal(recovered.delivery.status, "delivered");
  assert.equal(recovered.delivery.messageId, messages[0].id);
  assert.equal(recovered.delivery.lastError, null);
});

test("recovery replaces a deleted save card while the save is still pending", async () => {
  const fixture = saveFixture();
  await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "batch")
  );
  const [pending] = Object.values(fixture.stored.state.pendingSaves);
  const deletedMessageId = messages[0].id;
  messages.length = 0;

  await runtime.reconcileUndeliveredSaveRequests();
  const recovered = fixture.stored.state.pendingSaves[pending.id];
  assert.equal(fixture.createCalls, 2);
  assert.equal(messages.length, 1);
  assert.notEqual(recovered.delivery.messageId, deletedMessageId);
  assert.equal(recovered.delivery.messageId, messages[0].id);
});
