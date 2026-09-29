import assert from "node:assert/strict";
import test from "node:test";

let nextId = 0;
globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.foundry = {
  utils: {
    randomID: () => `condition-${++nextId}`,
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
globalThis.ui = { notifications: { error: () => {} } };

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

/** Models PF2e's strongest-active-condition behavior while retaining every stored Item. */
function fixture() {
  const items = new Map();
  items.find = (predicate) => [...items.values()].find(predicate);
  items.filter = (predicate) => [...items.values()].filter(predicate);
  const actor = {
    uuid: `Actor.target-${++nextId}`,
    name: "Target",
    items,
    conditions: {
      bySlug(slug, { active = null } = {}) {
        const matching = [...items.values()]
          .filter((item) => item.type === "condition" && item.slug === slug)
          .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
        matching.forEach((item, index) => { item.active = index === 0; });
        return active === null ? matching : matching.filter((item) => item.active === active);
      }
    },
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      return sources.map((source) => {
        const id = `item-${++nextId}`;
        const item = {
          ...structuredClone(source),
          id,
          parent: actor,
          get value() { return this.system.value.value; },
          async update(changes) { this.system.value.value = changes["system.value.value"]; },
          async delete() { items.delete(id); }
        };
        item.slug = item.system.slug;
        items.set(id, item);
        return item;
      });
    },
    async increaseCondition(slug, { value } = {}) {
      const current = this.conditions.bySlug(slug, { active: true })[0];
      if (current) {
        await current.update({ "system.value.value": value ?? Number(current.value) + 1 });
        return current;
      }
      const [created] = await this.createEmbeddedDocuments("Item", [
        game.pf2e.ConditionManager.getCondition(slug).toObject()
      ]);
      if (value != null) await created.update({ "system.value.value": value });
      return created;
    }
  };
  const token = { uuid: `Token.target-${nextId}`, actor };
  const block = { id: "block", name: "Condition block" };
  const temporary = { uuid: `Region.temporary-${nextId}` };
  const lasting = { uuid: `Region.lasting-${nextId}` };
  const lastingOther = { uuid: `Region.other-${nextId}` };
  const payload = () => ({ state: { applied: {} }, config: { name: "Condition zone" } });
  game.pf2e = {
    ConditionManager: {
      getCondition: (slug) => ({
        toObject: () => ({
          type: "condition",
          system: { slug, value: { isValued: true, value: 1 } }
        })
      }),
      async updateConditionValue(id, owner, value) {
        await owner.items.get(id).update({ "system.value.value": value });
      }
    }
  };
  globalThis.fromUuid = async (uuid) => uuid === token.uuid ? token : uuid === actor.uuid ? actor : null;
  return { actor, token, block, temporary, lasting, lastingOther, payload };
}

test("a lasting higher condition survives cleanup of a weaker temporary source", async () => {
  const { actor, token, block, temporary, lasting, payload } = fixture();
  const tempState = payload();
  const lastingState = payload();
  await runtime.addCondition(temporary, tempState, block, token,
    { slug: "frightened", value: 1, removal: "on-exit" });
  const temporaryItem = [...actor.items.values()][0];

  await runtime.addCondition(lasting, lastingState, block, token,
    { slug: "frightened", value: 2, removal: "normal" });
  assert.equal(temporaryItem.value, 1, "the normal result must not change the temporary Item");
  assert.equal(actor.items.size, 2);
  assert.equal(actor.conditions.bySlug("frightened", { active: true })[0].value, 2);

  await runtime.cleanupTokenOnExitUnlocked(tempState, token.uuid);
  assert.equal(actor.items.size, 1);
  assert.equal(actor.conditions.bySlug("frightened", { active: true })[0].value, 2);
  assert.equal([...actor.items.values()][0].flags.world.pf2eZone.removal, "normal");
  await runtime.cleanupZoneUnlocked(lastingState);
  assert.equal(actor.items.size, 1, "ending the lasting zone does not remove its normal condition");
});

test("a lasting weaker condition remains after a stronger temporary source ends", async () => {
  const { actor, token, block, temporary, lasting, payload } = fixture();
  const tempState = payload();
  await runtime.addCondition(temporary, tempState, block, token,
    { slug: "frightened", value: 3, removal: "on-exit" });
  await runtime.addCondition(lasting, payload(), block, token,
    { slug: "frightened", value: 2, removal: "normal" });
  assert.equal(actor.items.size, 2, "the weaker result still needs an independent Item");
  assert.equal(actor.conditions.bySlug("frightened", { active: true })[0].value, 3);

  await runtime.cleanupTokenOnExitUnlocked(tempState, token.uuid);
  assert.equal(actor.conditions.bySlug("frightened", { active: true })[0].value, 2);
});

test("lasting results from separate sources stay separate and repeat within one source", async () => {
  const { actor, token, block, lasting, lastingOther, payload } = fixture();
  const firstState = payload();
  const secondState = payload();
  await runtime.addCondition(lasting, firstState, block, token,
    { slug: "frightened", value: 1, removal: "normal" });
  const first = [...actor.items.values()][0];
  await runtime.addCondition(lastingOther, secondState, block, token,
    { slug: "frightened", value: 2, removal: "normal" });
  assert.equal(first.value, 1, "a second source must not raise the first source's Item");
  assert.equal(actor.items.size, 2);

  await runtime.addCondition(lastingOther, secondState, block, token,
    { slug: "frightened", value: 2, removal: "normal" });
  assert.equal(actor.items.size, 2, "repeating the same source must not create a third Item");
  await first.delete();
  assert.equal(actor.conditions.bySlug("frightened", { active: true })[0].value, 2);
});

test("damage and unrelated conditions cannot register a condition-recovery watcher", () => {
  const { token, block, payload } = fixture();
  const state = payload();
  state.state.recoveryWatchers = {};
  state.state.immunities = {};
  block.immunity = {
    duration: "1-round",
    starts: ["condition-recovery"],
    recoveryCondition: "sickened"
  };
  block.outcomes = {
    noSave: { conditions: [], effects: [], damageMultiplier: 1 }
  };

  runtime.applyImmunityStarts(
    state, block, token, "noSave", true, false,
    { conditions: [{ slug: "frightened", itemId: "unrelated-condition" }] }
  );
  assert.deepEqual(state.state.recoveryWatchers, {}, "an unrelated affected result must not create a watcher");

  block.outcomes.noSave.conditions.push({ slug: "sickened", value: 1, removal: "normal" });
  runtime.applyImmunityStarts(state, block, token, "noSave", true, false, { conditions: [] });
  assert.deepEqual(state.state.recoveryWatchers, {}, "a failed watched-condition application must not create a watcher");
});

test("condition recovery tracks the applied Condition Item and starts immunity when it ends", async () => {
  const { actor, token, block, payload } = fixture();
  const previousScenes = game.scenes;
  const previousReplace = globalThis._replace;
  const regions = new Map();
  const scene = { id: "scene", regions, tokens: [token] };
  let stored = payload();
  block.immunity = {
    duration: "1-round",
    starts: ["condition-recovery"],
    recoveryCondition: "sickened"
  };
  block.damage = { enabled: false };
  block.healing = { enabled: false };
  block.outcomes = {
    noSave: {
      conditions: [{ slug: "sickened", value: 1, removal: "normal" }],
      effects: [],
      damageMultiplier: 1
    }
  };
  stored.config.effects = [block];
  stored.state.recoveryWatchers = {};
  stored.state.immunities = {};
  const region = {
    id: "recovery-zone",
    uuid: "Scene.scene.Region.recovery-zone",
    parent: scene,
    getFlag: () => stored,
    async update(changes) { stored = changes["flags.world.pf2eZone"]; }
  };
  regions.set(region.id, region);
  token.parent = scene;
  token.testInsideRegion = (candidate) => candidate === region;
  game.scenes = { contents: [scene] };
  globalThis._replace = (value) => value;

  try {
    const application = {};
    const affected = await runtime.applyOutcome(
      region, stored, block, token, "noSave", "batch", {}, { application }
    );
    runtime.applyImmunityStarts(stored, block, token, "noSave", affected, false, application);

    const [watcher] = Object.values(stored.state.recoveryWatchers);
    assert.equal(watcher.itemId, application.conditions[0].itemId);
    assert.equal(Object.keys(stored.state.immunities).length, 0);

    await actor.items.get(watcher.itemId).delete();
    await runtime.reconcileActorDependencies(actor);

    assert.deepEqual(stored.state.recoveryWatchers, {});
    assert.equal(Object.keys(stored.state.immunities).length, 1);
  } finally {
    game.scenes = previousScenes;
    delete token.parent;
    delete token.testInsideRegion;
    if (previousReplace === undefined) delete globalThis._replace;
    else globalThis._replace = previousReplace;
  }
});
