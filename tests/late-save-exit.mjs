import assert from "node:assert/strict";
import test from "node:test";

let nextId = 0;
globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.foundry = {
  utils: {
    randomID: () => `owned-${++nextId}`,
    getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
    setProperty: (object, path, value) => {
      const keys = path.split(".");
      let current = object;
      for (const key of keys.slice(0, -1)) current = current[key] ??= {};
      current[keys.at(-1)] = value;
    }
  }
};
globalThis._replace = (payload) => payload;
globalThis.game = {
  actors: { contents: [] },
  scenes: { contents: [] },
  users: { activeGM: { id: "gm" } },
  user: { id: "gm", isGM: true },
  time: { worldTime: 0 }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();
await new Promise((resolve) => setTimeout(resolve, 0));

/** Keeps late-save tests on the real outcome and owned-item cleanup paths. */
async function withPendingSave({ insideAtResolution, onCreate = null }, run) {
  const previous = {
    scenes: game.scenes,
    pf2e: game.pf2e,
    fromUuid: globalThis.fromUuid,
    postDamage: runtime.postDamage,
    postHealing: runtime.postHealing
  };
  let inside = insideAtResolution;
  const scene = { id: "scene", regions: new Map(), tokens: [] };
  const items = new Map();
  items.find = (predicate) => [...items.values()].find(predicate);
  const actor = {
    uuid: "Actor.target",
    name: "Target",
    items,
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      return await Promise.all(sources.map(async (source) => {
        await onCreate?.(source, () => { inside = false; });
        const id = `item-${++nextId}`;
        const item = {
          ...source,
          id,
          parent: actor,
          async delete() { items.delete(id); }
        };
        items.set(id, item);
        return item;
      }));
    }
  };
  const token = {
    uuid: "Scene.scene.Token.target",
    name: "Target",
    actor,
    parent: scene,
    testInsideRegion: () => inside
  };
  scene.tokens.push(token);
  const effectTemplate = {
    documentName: "Item",
    type: "effect",
    toObject: () => ({ type: "effect", system: { duration: {} } })
  };
  const conditionTemplate = {
    toObject: () => ({ type: "condition", system: { value: { isValued: true, value: 1 } } })
  };
  const block = {
    id: "block",
    name: "Delayed save",
    damage: { enabled: true },
    healing: { enabled: true },
    immunity: { duration: "none", starts: [] },
    outcomes: {
      failure: {
        conditions: [
          { slug: "frightened", value: 1, removal: "on-exit" },
          { slug: "clumsy", value: 1, removal: "zone-end" }
        ],
        effects: [
          { uuid: "Item.exit-effect", removal: "on-exit" },
          { uuid: "Item.zone-effect", removal: "zone-end" }
        ],
        damageMultiplier: 1
      }
    }
  };
  const identifier = "pf2e-zone:scene:zone:pending";
  let stored = {
    config: { name: "Delayed save zone", mode: "area", effects: [block] },
    state: {
      pendingSaves: {
        pending: {
          id: "pending",
          identifier,
          blockId: block.id,
          tokenUuid: token.uuid,
          batchId: "entry-event",
          trigger: "enter"
        }
      }
    }
  };
  const region = {
    id: "zone",
    uuid: "Scene.scene.Region.zone",
    name: "Delayed save zone",
    parent: scene,
    behaviors: [{ name: "PF2e Zone Runtime", disabled: false }],
    getFlag: () => stored,
    async update(changes) { stored = changes["flags.world.pf2eZone"]; }
  };
  scene.regions.set(region.id, region);
  const documents = new Map([
    [token.uuid, token],
    ["Item.exit-effect", effectTemplate],
    ["Item.zone-effect", effectTemplate]
  ]);
  globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;
  game.scenes = { contents: [scene], get: (id) => id === scene.id ? scene : null };
  game.pf2e = { ConditionManager: { getCondition: () => conditionTemplate } };
  let damage = 0;
  let healing = 0;
  runtime.postDamage = async () => { damage++; return true; };
  runtime.postHealing = async () => { healing++; return true; };

  try {
    await run({
      region, token, items, identifier,
      setInside: (value) => { inside = value; },
      get stored() { return stored; },
      get damage() { return damage; },
      get healing() { return healing; }
    });
  } finally {
    game.scenes = previous.scenes;
    game.pf2e = previous.pf2e;
    runtime.postDamage = previous.postDamage;
    runtime.postHealing = previous.postHealing;
    if (previous.fromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = previous.fromUuid;
  }
}

test("late save skips exit-bound items but keeps lasting results and damage", async () => {
  await withPendingSave({ insideAtResolution: false }, async (fixture) => {
    const resolved = await runtime.resolvePendingSave(
      fixture.region, "pending", fixture.identifier, "failure", fixture.token.actor.uuid
    );
    assert.equal(resolved, true);
    assert.deepEqual([...fixture.items.values()].map((item) => item.flags.world.pf2eZone.removal), [
      "zone-end", "zone-end"
    ]);
    assert.equal(fixture.damage, 1);
    assert.equal(fixture.healing, 1);
    assert.deepEqual(fixture.stored.state.pendingSaves, {});
    assert.equal(fixture.stored.state.resolvedSaves.pending.outcome, "failure");
  });
});

test("an in-zone save still applies exit-bound items until the target leaves", async () => {
  await withPendingSave({ insideAtResolution: true }, async (fixture) => {
    const resolved = await runtime.resolvePendingSave(
      fixture.region, "pending", fixture.identifier, "failure", fixture.token.actor.uuid
    );
    assert.equal(resolved, true);
    assert.deepEqual([...fixture.items.values()].map((item) => item.flags.world.pf2eZone.removal), [
      "on-exit", "zone-end", "on-exit", "zone-end"
    ]);
    fixture.setInside(false);
    await runtime.withState(fixture.region, (payload) =>
      runtime.cleanupTokenOnExitUnlocked(payload, fixture.token.uuid)
    );
    assert.deepEqual([...fixture.items.values()].map((item) => item.flags.world.pf2eZone.removal), [
      "zone-end", "zone-end"
    ]);
  });
});

test("an exit during asynchronous item creation leaves no exit-bound item behind", async () => {
  await withPendingSave({
    insideAtResolution: true,
    onCreate: async (source, leave) => {
      if (source.flags.world.pf2eZone.removal === "on-exit") leave();
    }
  }, async (fixture) => {
    const resolved = await runtime.resolvePendingSave(
      fixture.region, "pending", fixture.identifier, "failure", fixture.token.actor.uuid
    );
    assert.equal(resolved, true);
    assert.deepEqual([...fixture.items.values()].map((item) => item.flags.world.pf2eZone.removal), [
      "zone-end", "zone-end"
    ]);
    assert.equal(fixture.damage, 1);
    assert.equal(fixture.healing, 1);
    assert.deepEqual(fixture.stored.state.applied && Object.values(fixture.stored.state.applied).map((entry) => entry.removal), [
      "zone-end", "zone-end"
    ]);
  });
});

test("an exit-bound item removed during resolution does not count as an affected result", async () => {
  await withPendingSave({
    insideAtResolution: true,
    onCreate: async (source, leave) => {
      if (source.flags.world.pf2eZone.removal === "on-exit") leave();
    }
  }, async (fixture) => {
    const block = fixture.stored.config.effects[0];
    block.outcomes.failure.conditions = [{ slug: "frightened", value: 1, removal: "on-exit" }];
    block.outcomes.failure.effects = [];
    block.damage.enabled = false;
    block.healing.enabled = false;

    const originalImmunity = runtime.applyImmunityStarts;
    let affectedResult = null;
    runtime.applyImmunityStarts = (_payload, _block, _token, _outcome, affected) => {
      affectedResult = affected;
    };
    try {
      const resolved = await runtime.resolvePendingSave(
        fixture.region, "pending", fixture.identifier, "failure", fixture.token.actor.uuid
      );
      assert.equal(resolved, true);
      assert.equal(affectedResult, false);
      assert.equal(fixture.items.size, 0);
      assert.deepEqual(fixture.stored.state.applied, {});
    } finally {
      runtime.applyImmunityStarts = originalImmunity;
    }
  });
});
