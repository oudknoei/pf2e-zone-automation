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
globalThis._replace = (payload) => payload;
globalThis.game = {
  actors: { contents: [] },
  scenes: [],
  users: { activeGM: { id: "gm" } },
  user: { id: "gm", isGM: true },
  time: { worldTime: 0 },
  combat: { id: "combat", round: 1, turn: 0 }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

for (const policy of ["once-per-round", "once-per-zone", "every"]) {
  test(`continuous condition and effect return after same-round re-entry with ${policy} repeat`, async () => {
    const items = new Map();
    items.find = (predicate) => [...items.values()].find(predicate);
    let creations = 0;
    let alerts = 0;
    let damageRolls = 0;
    const actor = {
      uuid: `Actor.${policy}`,
      items,
      async createEmbeddedDocuments(_type, sources) {
        return sources.map((source) => {
          const id = `effect-${++creations}`;
          const item = { ...source, id, parent: actor, async delete() { items.delete(id); } };
          items.set(id, item);
          return item;
        });
      }
    };
    const token = { uuid: `Token.${policy}`, name: "Target", actor };
    const effect = {
      documentName: "Item",
      toObject: () => ({ type: "effect", system: { duration: {} } })
    };
    const condition = {
      toObject: () => ({ type: "condition", system: { value: { isValued: true, value: 1 } } })
    };
    game.pf2e = { ConditionManager: { getCondition: () => condition } };
    const documents = new Map([
      [actor.uuid, actor],
      [token.uuid, token],
      ["Item.maintained", effect]
    ]);
    globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;

    const block = {
      id: "block",
      name: "Maintained effect",
      repeat: policy,
      triggers: { continuous: true },
      chatAlert: { enabled: true, text: "Aura active" },
      save: { enabled: false },
      damage: { enabled: true, formula: "1d6", type: "fire" },
      healing: { enabled: false },
      immunity: { duration: "none", starts: [] },
      outcomes: {
        noSave: {
          conditions: [{ slug: "frightened", value: 1, removal: "on-exit" }],
          effects: [{ uuid: "Item.maintained", removal: "on-exit" }],
          damageMultiplier: 1
        }
      }
    };
    let stored = { config: { name: "Aura", effects: [block] }, state: {} };
    const scene = { regions: new Map() };
    const region = {
      id: `zone-${policy}`,
      uuid: `Region.${policy}`,
      parent: scene,
      getFlag: () => stored,
      async update(changes) { stored = changes["flags.world.pf2eZone"]; }
    };
    scene.regions.set(region.id, region);

    let occupants = [token];
    runtime.tokensInside = () => occupants;
    runtime.eligible = async () => true;
    runtime.isImmune = () => false;
    runtime.postChatAlertOnce = async () => { alerts++; };
    runtime.postDamage = async () => { damageRolls++; return true; };

    await runtime.withState(region, (payload) => runtime.reconcileContinuousUnlocked(region, payload));
    assert.equal(items.size, 2, "condition and effect apply on first entry");
    assert.equal(alerts, 1);
    assert.equal(damageRolls, 1);

    occupants = [];
    await runtime.withState(region, (payload) => runtime.reconcileContinuousUnlocked(region, payload));
    assert.equal(items.size, 0, "condition and effect are removed on exit");

    occupants = [token];
    await runtime.withState(region, (payload) => runtime.reconcileContinuousUnlocked(region, payload));
    assert.equal(items.size, 2, "condition and effect return when the creature re-enters");
    assert.equal(creations, 4);
    assert.equal(alerts, policy === "every" ? 2 : 1, "repeat policy still limits chat alerts");
    assert.equal(damageRolls, policy === "every" ? 2 : 1, "repeat policy still limits damage rolls");

    await runtime.withState(region, (payload) => runtime.reconcileContinuousUnlocked(region, payload));
    assert.equal(items.size, 2, "later reconciliation does not duplicate either item");
    assert.equal(creations, 4);
  });
}