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
globalThis.ui = { notifications: {
  error: (message) => notices.push(message),
  warn: (message) => notices.push(message)
} };

const messages = [];
let createCalls = 0;
let failCreation = false;
globalThis.ChatMessage = {
  getSpeaker: () => ({ alias: "Zone Source" }),
  async create(data) {
    createCalls++;
    if (failCreation) throw new Error("injected chat creation failure");
    const message = {
      id: `message-${createCalls}`, author: gm, ...data,
      async update(changes) {
        this.content = changes.content;
        this.flags.world.pf2eZoneSaveRequest = changes["flags.world.pf2eZoneSaveRequest"];
        return this;
      }
    };
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
  const token = { id: "target-token", uuid: "Scene.scene.Token.target-token", name: "Target", actor, parent: scene };
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

test("Every time this happens queues a separate save while an earlier request is unanswered", async () => {
  const fixture = saveFixture();
  fixture.block.repeat = "every";

  const first = await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "first-event")
  );
  const second = await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "second-event")
  );

  const pending = Object.values(fixture.stored.state.pendingSaves);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((request) => request.batchId), ["first-event", "second-event"]);
  assert.equal(new Set(pending.map((request) => request.identifier)).size, 2);
  assert.equal(messages.length, 2);
});

test("limited repeat policies still suppress another request while one is unanswered", async () => {
  const fixture = saveFixture();

  const first = await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "first-event")
  );
  const second = await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "second-event")
  );

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(Object.keys(fixture.stored.state.pendingSaves).length, 1);
  assert.equal(messages.length, 1);
});

test("recovery removes save buttons only after an authentic missed roll is applied", async () => {
  const fixture = saveFixture();
  await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "batch")
  );
  const [pending] = Object.values(fixture.stored.state.pendingSaves);
  const card = messages[0];
  assert.match(card.content, /data-pf2e-zone-save/);

  const result = {
    author: gm,
    actor: fixture.actor,
    token: fixture.token,
    flags: { pf2e: { context: {
      type: "saving-throw", identifier: pending.identifier,
      actor: fixture.actor.id, token: fixture.token.id,
      dc: { value: pending.dc }, domains: ["saving-throw", "reflex"], outcome: "failure"
    } } },
    rolls: [{ degreeOfSuccess: 1, options: {
      type: "saving-throw", identifier: pending.identifier, rollerId: gm.id
    } }]
  };
  messages.push(result);

  const applyOutcome = runtime.applyOutcome;
  const applyImmunityStarts = runtime.applyImmunityStarts;
  runtime.applyOutcome = async () => true;
  runtime.applyImmunityStarts = () => {};
  try {
    await runtime.reconcileCompletedSaves();
  } finally {
    runtime.applyOutcome = applyOutcome;
    runtime.applyImmunityStarts = applyImmunityStarts;
  }

  assert.equal(fixture.stored.state.pendingSaves[pending.id], undefined);
  assert.doesNotMatch(card.content, /data-pf2e-zone-save/);
  assert.match(card.content, /Save completed/);
  assert.match(card.content, /data-pf2e-zone-ping/);
});

test("same-named cards retire only the completed save button and keep its Token ping", async () => {
  const fixture = saveFixture();
  const twin = {
    id: "twin-token",
    uuid: "Scene.scene.Token.twin-token",
    name: fixture.token.name,
    actor: fixture.actor,
    parent: fixture.region.parent
  };
  const resolveOriginal = globalThis.fromUuid;
  globalThis.fromUuid = async (uuid) => uuid === twin.uuid ? twin : resolveOriginal(uuid);
  await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, fixture.token, "enter", "batch")
  );
  await runtime.withState(fixture.region, (payload) =>
    runtime.requestSave(fixture.region, payload, fixture.block, twin, "enter", "batch")
  );
  const [first, second] = Object.values(fixture.stored.state.pendingSaves);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.content.includes("data-pf2e-zone-ping")));
  assert.match(messages[0].content, new RegExp(`data-pending-id="${first.id}"`));
  assert.match(messages[1].content, new RegExp(`data-pending-id="${second.id}"`));

  const positions = new Map([
    [fixture.token.id, { x: 300, y: 450 }],
    [twin.id, { x: 700, y: 450 }]
  ]);
  const pings = [];
  globalThis.canvas = {
    ready: true,
    scene: fixture.region.parent,
    tokens: { get: (id) => positions.has(id) ? { center: positions.get(id) } : null },
    ping: async (point) => { pings.push(point); return true; }
  };

  runtime.installHooks();
  try {
    const clickPing = async (pending) => {
      const button = {
        dataset: { pf2eZonePing: "", sceneId: "scene", regionId: "zone", pendingId: pending.id },
        disabled: false
      };
      let prevented = false;
      await globalThis.PF2EZoneRuntimeHookRegistry.clickHandler({
        target: { closest: () => button },
        preventDefault: () => { prevented = true; }
      });
      assert.equal(prevented, true);
      assert.equal(button.disabled, false);
    };

    await clickPing(second);
    positions.set(fixture.token.id, { x: 350, y: 500 });
    await clickPing(first);
    assert.deepEqual(pings, [{ x: 700, y: 450 }, { x: 350, y: 500 }]);
    assert.equal(Object.keys(fixture.stored.state.pendingSaves).length, 2, "pinging does not resolve saves");

    const applyOutcome = runtime.applyOutcome;
    const applyImmunityStarts = runtime.applyImmunityStarts;
    runtime.applyOutcome = async () => true;
    runtime.applyImmunityStarts = () => {};
    try {
      assert.equal(await runtime.resolvePendingSave(
        fixture.region, second.id, second.identifier, "success", "Actor.wrong"
      ), false);
      assert.match(messages[1].content, /data-pf2e-zone-save/);
      const updateCard = messages[1].update;
      messages[1].update = async function (changes) {
        assert.equal(fixture.stored.state.pendingSaves[second.id], undefined,
          "the request is committed before its save buttons disappear");
        return updateCard.call(this, changes);
      };
      assert.equal(await runtime.resolvePendingSave(
        fixture.region, second.id, second.identifier, "success", fixture.actor.uuid
      ), true);
    } finally {
      runtime.applyOutcome = applyOutcome;
      runtime.applyImmunityStarts = applyImmunityStarts;
    }
    assert.match(messages[0].content, /data-pf2e-zone-save/, "the other Token still needs its save");
    assert.doesNotMatch(messages[1].content, /data-pf2e-zone-save/);
    assert.match(messages[1].content, /Save completed/);
    assert.match(messages[1].content, /data-pf2e-zone-ping/);
    assert.equal(messages[1].flags.world.pf2eZoneSaveRequest.status, "completed");
    assert.equal(fixture.stored.state.pendingSaves[second.id], undefined);

    positions.set(twin.id, { x: 750, y: 500 });
    await clickPing(second);
    assert.deepEqual(pings.at(-1), { x: 750, y: 500 }, "completed cards ping the current Token location");

    fixture.region.parent.regions.delete(fixture.region.id);
    await clickPing(second);
    assert.deepEqual(pings.at(-1), { x: 750, y: 500 }, "completed-card ping survives zone removal");
    fixture.region.parent.regions.set(fixture.region.id, fixture.region);

    canvas.scene = { id: "other-scene" };
    await runtime.pingSaveTarget(fixture.region.parent.id, first.tokenUuid);
    assert.equal(pings.length, 4, "the wrong Scene is not pinged");
    assert.match(notices.at(-1), /View the target's Scene/);

    canvas.scene = fixture.region.parent;
    globalThis.fromUuid = async (uuid) => uuid === twin.uuid ? null : resolveOriginal(uuid);
    await runtime.pingSaveTarget(fixture.region.parent.id, second.tokenUuid);
    assert.equal(pings.length, 4, "a deleted target is not pinged");
    assert.match(notices.at(-1), /no longer exists/);

    delete fixture.stored.state.pendingSaves[first.id];
    await clickPing(first);
    assert.equal(pings.length, 4, "an expired request is not pinged");
    assert.match(notices.at(-1), /no longer active/);
  } finally {
    runtime.teardownHooks();
    delete globalThis.canvas;
    globalThis.fromUuid = resolveOriginal;
  }
});
