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
function effectFixture(templateSource = { type: "effect", system: { duration: { value: 1, unit: "rounds" } } }) {
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
          async update(changes) {
            for (const [path, value] of Object.entries(changes)) foundry.utils.setProperty(this, path, value);
          },
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
    toObject: () => structuredClone(templateSource)
  };
  globalThis.fromUuid = async (uuid) => uuid === "Item.template" ? template : null;
  globalThis.ui = { notifications: { error: (message) => errors.push(message) } };
  const region = { uuid: "Region.zone" };
  const payload = {
    config: { name: "Test zone" },
    state: {
      applied: {},
      sourceActorUuid: "Actor.zone-source",
      sourceTokenUuid: "Scene.scene.Token.zone-source"
    }
  };
  const block = { id: "block", name: "Effect block" };
  const effect = { uuid: "Item.template", removal: "item-duration" };
  return {
    actor, token, region, payload, block, effect, errors,
    get creations() { return creations; },
    setDeletionFailure(value) { failDeletion = value; }
  };
}

test("an Actor-sheet Effect becomes a new zone application without stale aura or grant links", async () => {
  const template = {
    type: "effect",
    flags: {
      pf2e: {
        aura: { slug: "old-aura", origin: "Actor.previous", removeOnExit: true },
        grantedBy: { id: "old-granter" },
        itemGrants: { old: { id: "old-child" } },
        rulesSelections: { choice: "fire" },
        customFlag: "keep"
      },
      otherModule: { useful: true }
    },
    system: {
      duration: { value: 1, unit: "rounds" },
      rules: [{ key: "FlatModifier", selector: "attack", value: 1 }],
      start: { value: 10, initiative: 5 },
      expired: true,
      context: {
        origin: { actor: "Actor.previous", token: "Token.previous", item: "Item.previous", rollOptions: ["old"] },
        target: { actor: "Actor.previous-target", token: "Token.previous-target" },
        roll: { total: 12 }
      }
    }
  };
  const f = effectFixture(template);
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  const created = [...f.actor.items.values()][0];
  assert.equal(created.flags.pf2e.aura, undefined);
  assert.equal(created.flags.pf2e.grantedBy, undefined);
  assert.equal(created.flags.pf2e.itemGrants, undefined);
  assert.deepEqual(created.flags.pf2e.rulesSelections, { choice: "fire" });
  assert.equal(created.flags.pf2e.customFlag, "keep");
  assert.deepEqual(created.flags.otherModule, { useful: true });
  assert.deepEqual(created.system.rules, template.system.rules);
  assert.equal(created.system.start, undefined);
  assert.equal(created.system.expired, undefined);
  assert.deepEqual(created.system.context, {
    origin: {
      actor: "Actor.zone-source",
      token: "Scene.scene.Token.zone-source",
      item: null,
      spellcasting: null,
      rollOptions: []
    },
    target: { actor: f.actor.uuid, token: f.token.uuid },
    roll: null
  });
  assert.deepEqual(template.flags.pf2e.aura, { slug: "old-aura", origin: "Actor.previous", removeOnExit: true },
    "the source Item is unchanged");
});

test("a compendium Effect gets the zone source and current target even without template context", async () => {
  const f = effectFixture();
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  const created = [...f.actor.items.values()][0];
  assert.equal(created.system.context.origin.actor, f.payload.state.sourceActorUuid);
  assert.equal(created.system.context.target.actor, f.actor.uuid);
});

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

test("Effect Item identity separates outcomes and cleanup policies", async () => {
  const f = effectFixture();
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect, "failure"), true);
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect, "failure"), true);
  assert.equal(f.creations, 1, "the same outcome and removal policy reuse one Item");

  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect, "success"), true);
  f.effect.removal = "on-exit";
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect, "success"), true);
  assert.equal(f.creations, 3);

  const flags = [...f.actor.items.values()].map((item) => item.flags.world.pf2eZone);
  assert.deepEqual(flags.map(({ outcomeKey, removal }) => [outcomeKey, removal]), [
    ["failure", "item-duration"],
    ["success", "item-duration"],
    ["success", "on-exit"]
  ]);
  assert.deepEqual(Object.values(f.payload.state.applied).map(({ outcomeKey, removal }) => [outcomeKey, removal]), [
    ["failure", "item-duration"],
    ["success", "item-duration"],
    ["success", "on-exit"]
  ]);
});

test("an active legacy Effect Item adopts the first matching outcome identity", async () => {
  const f = effectFixture();
  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect), true);
  const [item] = f.actor.items.values();
  delete item.flags.world.pf2eZone.outcomeKey;
  const [record] = Object.values(f.payload.state.applied);
  delete record.outcomeKey;

  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect, "failure"), true);
  assert.equal(f.creations, 1);
  assert.equal(item.flags.world.pf2eZone.outcomeKey, "failure");
  assert.equal(record.outcomeKey, "failure");

  assert.equal(await runtime.addEffectItem(f.region, f.payload, f.block, f.token, f.effect, "success"), true);
  assert.equal(f.creations, 2, "a different outcome no longer collides with the adopted Item");
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
