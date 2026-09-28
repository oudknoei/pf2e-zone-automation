import assert from "node:assert/strict";
import test from "node:test";

let nextId = 0;
globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.foundry = {
  utils: {
    randomID: () => `record-${++nextId}`,
    getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
    setProperty: (object, path, value) => {
      const keys = path.split(".");
      let current = object;
      for (const key of keys.slice(0, -1)) current = current[key] ??= {};
      current[keys.at(-1)] = value;
    }
  }
};
globalThis.game = {
  actors: { contents: [] },
  scenes: { contents: [] },
  users: { activeGM: { id: "gm" } },
  user: { id: "gm", isGM: true },
  time: { worldTime: 0 }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

/** Recreates PF2e's choice to retain expired Effect Items while ignoring their rules. */
function effectFixture() {
  const items = new Map();
  let creations = 0;
  let failDeletion = false;
  const errors = [];
  const actor = {
    uuid: "Actor.target",
    name: "Target",
    items,
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      return sources.map((source) => {
        const id = `effect-${++creations}`;
        const item = {
          ...structuredClone(source),
          id,
          parent: actor,
          get isExpired() { return Boolean(this.system.expired); },
          async delete() {
            if (failDeletion) throw new Error("Simulated deletion failure");
            items.delete(id);
          }
        };
        items.set(id, item);
        return item;
      });
    }
  };
  const token = { uuid: "Token.target", actor };
  const template = {
    documentName: "Item", type: "effect",
    toObject: () => ({ type: "effect", system: { duration: { value: 1, unit: "rounds" } } })
  };
  globalThis.fromUuid = async (uuid) => uuid === "Item.template" ? template : null;
  globalThis.ui = { notifications: { error: (message) => errors.push(message) } };
  const region = { uuid: "Region.zone" };
  const payload = { config: { name: "Test zone" }, state: { applied: {} } };
  const block = { id: "block", name: "Effect block" };
  const effect = { uuid: "Item.template", removal: "item-duration" };
  return {
    actor, token, region, payload, block, effect, errors,
    get creations() { return creations; },
    setDeletionFailure(value) { failDeletion = value; }
  };
}

test("an expired tracked Effect Item is replaced and only the new application remains tracked", async () => {
  const f = effectFixture();
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  const first = [...f.actor.items.values()][0];
  assert.equal(f.creations, 1);
  first.system.expired = true;

  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  const second = [...f.actor.items.values()][0];
  assert.equal(f.actor.items.size, 1);
  assert.notEqual(second.id, first.id);
  assert.equal(f.creations, 2);
  assert.deepEqual(Object.values(f.payload.state.applied).map((record) => record.itemId), [second.id]);

  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  assert.equal(f.creations, 2, "an active matching Item is not recreated");
});

test("failed expired-Item deletion keeps the old tracking record for a later retry", async () => {
  const f = effectFixture();
  await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect);
  const first = [...f.actor.items.values()][0];
  first.system.expired = true;
  f.setDeletionFailure(true);
  const previousError = console.error;
  console.error = () => {};
  try {
    assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), false);
  } finally {
    console.error = previousError;
  }
  assert.equal(f.creations, 1);
  assert.deepEqual(Object.values(f.payload.state.applied).map((record) => record.itemId), [first.id]);
  assert.equal(f.errors.length, 1);

  f.setDeletionFailure(false);
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  assert.equal(f.creations, 2);
  assert.equal(f.actor.items.size, 1);
});
