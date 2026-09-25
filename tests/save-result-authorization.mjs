import assert from "node:assert/strict";
import test from "node:test";

globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.foundry = { utils: {} };
globalThis._replace = (payload) => payload;

const gm = { id: "gm", isGM: true };
const owner = { id: "owner", isGM: false };
const stranger = { id: "stranger", isGM: false };
const users = new Map([gm, owner, stranger].map((user) => [user.id, user]));
globalThis.game = {
  actors: { contents: [] },
  scenes: { contents: [] },
  messages: { contents: [] },
  users: { activeGM: gm, get: (id) => users.get(id) ?? null },
  user: gm,
  time: { worldTime: 0 }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

/** Gives each case an independent pending save and observes any applied effect. */
async function withPendingSave(run) {
  const scene = { id: "scene", regions: new Map() };
  const actor = {
    id: "target",
    uuid: "Actor.target",
    testUserPermission: (user, level) => user.id === owner.id && level === "OWNER"
  };
  const token = { id: "target-token", uuid: "Scene.scene.Token.target-token", name: "Target", actor };
  const identifier = "pf2e-zone:scene:zone:pending";
  const pending = {
    id: "pending", identifier, tokenUuid: token.uuid, actorUuid: actor.uuid,
    blockId: "block", blockName: "Save", dc: 25, saveTypes: ["reflex"],
    trigger: "enter", batchId: "batch"
  };
  const block = { id: "block", name: "Save" };
  let stored = {
    config: { name: "Zone", effects: [block] },
    state: { pendingSaves: { pending } }
  };
  const region = {
    id: "zone", uuid: "Scene.scene.Region.zone", name: "Zone", parent: scene,
    behaviors: [{ name: "PF2e Zone Runtime", disabled: false }],
    getFlag: () => stored,
    async update(changes) { stored = changes["flags.world.pf2eZone"]; }
  };
  scene.regions.set(region.id, region);
  game.scenes = { contents: [scene], get: (id) => id === scene.id ? scene : null };
  game.messages.contents = [];
  const previousFromUuid = globalThis.fromUuid;
  globalThis.fromUuid = async (uuid) => uuid === token.uuid ? token : null;
  const previousApplyOutcome = runtime.applyOutcome;
  const previousApplyImmunityStarts = runtime.applyImmunityStarts;
  let applications = 0;
  runtime.applyOutcome = async () => { applications++; return true; };
  runtime.applyImmunityStarts = () => {};

  const makeMessage = (author = owner) => ({
    author, actor, token,
    flags: { pf2e: { context: {
      type: "saving-throw", identifier, actor: actor.id, token: token.id,
      dc: { value: 25 }, domains: ["saving-throw", "reflex"], outcome: "failure"
    } } },
    rolls: [{ degreeOfSuccess: 1, options: { type: "saving-throw", identifier, rollerId: author.id } }]
  });

  try {
    await run({ actor, token, pending, region, makeMessage,
      get stored() { return stored; },
      get applications() { return applications; }
    });
  } finally {
    runtime.applyOutcome = previousApplyOutcome;
    runtime.applyImmunityStarts = previousApplyImmunityStarts;
    if (previousFromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = previousFromUuid;
  }
}

test("GM rejects unauthorized or mismatched save chat without consuming pending work", async () => {
  const cases = [
    ["missing roll", (message) => { message.rolls = []; }],
    ["missing Actor", (message) => { message.actor = null; }],
    ["different Actor", (message) => { message.actor = { id: "other", uuid: "Actor.other" }; }],
    ["different context Actor", (message) => { message.flags.pf2e.context.actor = "other"; }],
    ["unrelated author", (message) => { message.author = stranger; message.rolls[0].options.rollerId = stranger.id; }],
    ["unknown author", (message) => { message.author = { id: "unknown", isGM: true }; }],
    ["different roll identifier", (message) => { message.rolls[0].options.identifier = "other"; }],
    ["different roll type", (message) => { message.rolls[0].options.type = "skill-check"; }],
    ["different roller", (message) => { message.rolls[0].options.rollerId = stranger.id; }],
    ["different DC", (message) => { message.flags.pf2e.context.dc.value = 20; }],
    ["different save", (message) => { message.flags.pf2e.context.domains = ["saving-throw", "will"]; }],
    ["different outcome", (message) => { message.flags.pf2e.context.outcome = "success"; }],
    ["no degree", (message) => { message.rolls[0].degreeOfSuccess = null; }]
  ];

  for (const [name, change] of cases) {
    await withPendingSave(async (fixture) => {
      const message = fixture.makeMessage();
      change(message);
      await runtime.handleSaveResult(message);
      assert.equal(fixture.applications, 0, name);
      assert.ok(fixture.stored.state.pendingSaves.pending, name);
      assert.equal(fixture.stored.state.resolvedSaves?.pending, undefined, name);
    });
  }
});

test("the target owner and a GM can resolve the pending save exactly once", async () => {
  for (const author of [owner, gm]) {
    await withPendingSave(async (fixture) => {
      const message = fixture.makeMessage(author);
      await runtime.handleSaveResult(message);
      await runtime.handleSaveResult(message);
      assert.equal(fixture.applications, 1);
      assert.equal(fixture.stored.state.pendingSaves.pending, undefined);
      assert.equal(fixture.stored.state.resolvedSaves.pending.outcome, "failure");
    });
  }
});

test("a forged chat message cannot make a pending save appear completed", async () => {
  await withPendingSave(async (fixture) => {
    const forged = fixture.makeMessage(stranger);
    game.messages.contents = [forged];
    const payload = runtime.readPayload(fixture.region);
    assert.equal(await runtime.hasPending(payload, fixture.token.uuid, fixture.pending.blockId), true);
    assert.ok(payload.state.pendingSaves.pending);
  });
});

test("a GM reroll may retain the original owner's CheckRoll", async () => {
  await withPendingSave(async (fixture) => {
    const message = fixture.makeMessage(gm);
    message.rolls[0].options.rollerId = owner.id;
    await runtime.handleSaveResult(message);
    assert.equal(fixture.applications, 1);
    assert.equal(fixture.stored.state.resolvedSaves.pending.outcome, "failure");
  });
});
