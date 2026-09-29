import assert from "node:assert/strict";
import test from "node:test";

globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.foundry = { utils: {
  getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object)
} };
globalThis._replace = (payload) => payload;

const gm = { id: "gm", isGM: true, active: true };
globalThis.game = {
  actors: { contents: [] },
  scenes: { contents: [] },
  users: { activeGM: gm },
  user: gm,
  time: { worldTime: 0 }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

/** Creates one live Region whose writes can be counted and inspected. */
function regionFixture(id, initial = {
  config: { effects: [] },
  state: { activationProcessed: true, activationPending: false, deactivated: false }
}) {
  const regions = new Map();
  const scene = { id: `scene-${id}`, regions };
  let stored = structuredClone(initial);
  let writes = 0;
  const region = {
    id,
    uuid: `Scene.${scene.id}.Region.${id}`,
    parent: scene,
    behaviors: [{ name: "PF2e Zone Runtime", disabled: false }],
    getFlag: () => stored,
    async update(changes) {
      writes += 1;
      stored = structuredClone(changes["flags.world.pf2eZone"]);
    }
  };
  regions.set(id, region);
  stored = runtime.readPayload(region);
  return {
    region,
    scene,
    get stored() { return stored; },
    set stored(value) { stored = value; },
    get writes() { return writes; }
  };
}

test("unchanged Region transactions do not rewrite the full payload", async () => {
  const fixture = regionFixture("unchanged");
  game.scenes = { contents: [fixture.scene] };

  const result = await runtime.withState(fixture.region, () => "unchanged");
  assert.equal(result, "unchanged");
  assert.equal(fixture.writes, 0);

  await runtime.withState(fixture.region, (payload) => { payload.state.marker = "changed"; });
  assert.equal(fixture.writes, 1);
  await runtime.withState(fixture.region, (payload) => { payload.state.marker = "changed"; });
  assert.equal(fixture.writes, 1);

  const reordered = { state: structuredClone(fixture.stored.state), config: structuredClone(fixture.stored.config) };
  assert.equal(await runtime.writePayload(fixture.region, reordered), true);
  assert.equal(fixture.writes, 1, "object key order alone must not cause a write");
});

test("roll caches and save tombstones survive only while a pending save references them", async () => {
  const fixture = regionFixture("history");
  game.scenes = { contents: [fixture.scene] };
  const damageKey = "damage__block__shared-batch";
  const healingKey = "healing__block__shared-batch";
  fixture.stored.state.pendingSaves = {
    pending: {
      id: "pending", identifier: "pf2e-zone:scene:history:pending",
      blockId: "block", batchId: "shared-batch"
    }
  };
  fixture.stored.state.damageRolls = {
    [damageKey]: { roll: { total: 10 } },
    damage__block__finished: { roll: { total: 99 } }
  };
  fixture.stored.state.healingRolls = {
    [healingKey]: { roll: { total: 8 } },
    healing__block__finished: { roll: { total: 88 } }
  };
  fixture.stored.state.resolvedSaves = {
    pending: { identifier: "pf2e-zone:scene:history:pending", outcome: "failure" },
    finished: { identifier: "pf2e-zone:scene:history:finished", outcome: "success" }
  };

  await runtime.withState(fixture.region, () => {});
  assert.deepEqual(Object.keys(fixture.stored.state.damageRolls), [damageKey]);
  assert.deepEqual(Object.keys(fixture.stored.state.healingRolls), [healingKey]);
  assert.deepEqual(Object.keys(fixture.stored.state.resolvedSaves), ["pending"]);

  await runtime.withState(fixture.region, (payload) => {
    delete payload.state.pendingSaves.pending;
  });
  assert.deepEqual(fixture.stored.state.damageRolls, {});
  assert.deepEqual(fixture.stored.state.healingRolls, {});
  assert.deepEqual(fixture.stored.state.resolvedSaves, {});
});

test("authority recovery and Item deletion remove stale applied records without repeat writes", async () => {
  const fixture = regionFixture("applied");
  const activeItem = {
    id: "active-item",
    flags: { world: { pf2eZone: { zoneUuid: fixture.region.uuid } } }
  };
  const items = new Map([[activeItem.id, activeItem]]);
  const actor = { uuid: "Actor.target", items };
  activeItem.parent = actor;
  fixture.stored.state.applied = {
    active: { actorUuid: actor.uuid, itemId: activeItem.id },
    missingItem: { actorUuid: actor.uuid, itemId: "missing-item" },
    missingActor: { actorUuid: "Actor.deleted", itemId: "deleted-item" }
  };
  fixture.stored.state.damageRolls = { damage__block__finished: { roll: { total: 12 } } };
  game.scenes = { contents: [fixture.scene] };
  const previousFromUuid = globalThis.fromUuid;
  globalThis.fromUuid = async (uuid) => ({
    [actor.uuid]: actor,
    [fixture.region.uuid]: fixture.region
  })[uuid] ?? null;

  try {
    await runtime.reconcileRuntimeHistory();
    assert.deepEqual(Object.keys(fixture.stored.state.applied), ["active"]);
    assert.deepEqual(fixture.stored.state.damageRolls, {});
    assert.equal(fixture.writes, 1);

    await runtime.reconcileRuntimeHistory();
    assert.equal(fixture.writes, 1, "a second recovery pass must skip an unchanged write");

    items.delete(activeItem.id);
    await runtime.forgetDeletedAppliedItem(activeItem);
    assert.deepEqual(fixture.stored.state.applied, {});
    assert.equal(fixture.writes, 2);
  } finally {
    if (previousFromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = previousFromUuid;
  }
});

test("condition reconciliation visits only zones watching the changed Actor", async () => {
  const unrelated = regionFixture("unrelated");
  const watched = regionFixture("watched");
  const watchedItem = { id: "watched-condition", type: "condition", flags: {} };
  const items = [watchedItem];
  items.get = (id) => items.find((item) => item.id === id);
  const actor = {
    uuid: "Actor.watched",
    items,
    conditions: { bySlug: () => [watchedItem] }
  };
  watched.stored.state.recoveryWatchers = {
    watcher: {
      actorUuid: actor.uuid, tokenUuid: "Token.watched", blockId: "block",
      condition: "frightened", itemId: watchedItem.id
    }
  };
  game.scenes = { contents: [unrelated.scene, watched.scene] };
  const visited = [];
  const originalWithState = runtime.withState;
  runtime.withState = async function(region, callback) {
    visited.push(region.uuid);
    return originalWithState.call(this, region, callback);
  };

  try {
    await runtime.reconcileActorDependencies(actor);
    assert.deepEqual(visited, [watched.region.uuid]);
    assert.equal(unrelated.writes, 0);
    assert.equal(watched.writes, 0, "an unchanged matching watcher must not rewrite its Region");
  } finally {
    runtime.withState = originalWithState;
  }
});
