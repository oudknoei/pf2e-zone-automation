import assert from "node:assert/strict";
import test from "node:test";

globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
let nextId = 0;
globalThis.foundry = { utils: { randomID: () => `shared-${++nextId}` } };
globalThis._replace = (value) => value;

const settings = new Map();
const gm = { id: "gm", isGM: true, active: true };
globalThis.game = {
  actors: { contents: [] },
  scenes: { contents: [], get: () => null },
  messages: { contents: [], get: () => null },
  settings: {
    get: (moduleId, key) => settings.get(`${moduleId}.${key}`) ?? {},
    set: async (moduleId, key, value) => {
      settings.set(`${moduleId}.${key}`, structuredClone(value));
      return value;
    }
  },
  users: { activeGM: gm, get: (id) => id === gm.id ? gm : null },
  user: gm,
  time: { worldTime: 100 }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

/** Builds a live module Region whose flag writes use Foundry's replacement semantics. */
function makeRegion(scene, id, payload) {
  let stored = structuredClone(payload);
  const region = {
    id,
    uuid: `Scene.${scene.id}.Region.${id}`,
    name: payload.config.name,
    parent: scene,
    behaviors: [{ name: "PF2e Zone Runtime", disabled: false }],
    getFlag: () => stored,
    async update(changes) { stored = changes["flags.world.pf2eZone"]; }
  };
  scene.regions.set(id, region);
  return { region, stored: () => stored };
}

/** Supplies only the fields exercised by shared-immunity persistence and cancellation. */
function zonePayload(name, sourceTokenUuid, block, pendingSaves = {}, repeat = {}) {
  return {
    config: { name, effects: [block] },
    state: {
      sourceActorUuid: `Actor.source-${name}`,
      sourceTokenUuid,
      activationProcessed: true,
      pendingSaves,
      repeat,
      immunities: {}
    }
  };
}

test("one shared-group success protects the Actor and cancels sibling aura saves", async () => {
  const actor = { id: "target", uuid: "Actor.target" };
  const firstToken = { id: "target-1", uuid: "Scene.scene.Token.target-1", name: "Target One", actor };
  const secondToken = { id: "target-2", uuid: "Scene.scene.Token.target-2", name: "Target Two", actor };
  const otherToken = {
    id: "other", uuid: "Scene.scene.Token.other", name: "Other",
    actor: { id: "other", uuid: "Actor.other" }
  };
  const immunity = {
    duration: "1-minute",
    starts: ["success-or-better"],
    recoveryCondition: "sickened",
    scope: "shared-group",
    group: "stench:ghonhatine"
  };
  const firstBlock = { id: "stench-a", name: "Stench", immunity };
  const secondBlock = { id: "stench-b", name: "Stench", immunity };
  const firstPending = {
    id: "pending-a",
    identifier: "pf2e-zone:scene:first:pending-a",
    tokenUuid: firstToken.uuid,
    actorUuid: actor.uuid,
    blockId: firstBlock.id,
    blockName: firstBlock.name,
    dc: 26,
    saveTypes: ["fortitude"]
  };
  const secondPending = {
    id: "pending-b",
    identifier: "pf2e-zone:scene:second:pending-b",
    tokenUuid: secondToken.uuid,
    actorUuid: actor.uuid,
    blockId: secondBlock.id,
    blockName: secondBlock.name,
    dc: 26,
    saveTypes: ["fortitude"]
  };
  const scene = { id: "scene", regions: new Map() };
  const first = makeRegion(scene, "first", zonePayload(
    "First Stench", "Scene.scene.Token.source-a", firstBlock,
    { [firstPending.id]: firstPending }
  ));
  const second = makeRegion(scene, "second", zonePayload(
    "Second Stench", "Scene.scene.Token.source-b", secondBlock,
    { [secondPending.id]: secondPending },
    { [runtime.repeatKey(secondToken.uuid, secondBlock.id)]: { policy: "once-per-round" } }
  ));
  game.scenes = { contents: [scene], get: (id) => id === scene.id ? scene : null };

  const card = {
    id: "card-b",
    author: gm,
    content: "pending",
    flags: { world: { pf2eZoneSaveRequest: {
      identifier: secondPending.identifier,
      tokenUuid: secondPending.tokenUuid,
      targetName: secondToken.name,
      status: "pending"
    } } },
    async update(changes) {
      this.content = changes.content;
      this.flags.world.pf2eZoneSaveRequest = changes["flags.world.pf2eZoneSaveRequest"];
    }
  };
  game.messages = {
    contents: [card],
    get: (id) => id === card.id ? card : null
  };
  const previousFromUuid = globalThis.fromUuid;
  const previousApplyOutcome = runtime.applyOutcome;
  globalThis.fromUuid = async (uuid) => {
    if (uuid === firstToken.uuid) return firstToken;
    if (uuid === secondToken.uuid) return secondToken;
    if (uuid === otherToken.uuid) return otherToken;
    return null;
  };
  runtime.applyOutcome = async () => false;

  try {
    assert.equal(runtime.isImmuneFor(second.stored(), secondToken, secondBlock), false);

    assert.equal(await runtime.resolvePendingSave(
      first.region,
      firstPending.id,
      firstPending.identifier,
      "success",
      actor.uuid
    ), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(runtime.isImmuneFor(second.stored(), secondToken, secondBlock), true,
      "a second Token for the same Actor shares immunity");
    assert.equal(runtime.isImmuneFor(second.stored(), otherToken, secondBlock), false,
      "another Actor does not inherit the immunity");
    assert.deepEqual(second.stored().state.pendingSaves, {});
    assert.deepEqual(second.stored().state.repeat, {}, "a cancelled save can trigger again after immunity expires");
    assert.equal(card.flags.world.pf2eZoneSaveRequest.status, "cancelled");
    assert.match(card.content, /Temporarily immune/);

    game.time.worldTime = 161;
    await runtime.reconcileSharedImmunities({ cancelPending: false });
    assert.equal(runtime.isImmuneFor(second.stored(), secondToken, secondBlock), false);
    assert.deepEqual(settings.get("pf2e-zone-automation.sharedImmunities"), {});
  } finally {
    runtime.applyOutcome = previousApplyOutcome;
    if (previousFromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = previousFromUuid;
  }
});

