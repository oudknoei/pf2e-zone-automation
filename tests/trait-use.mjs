import assert from "node:assert/strict";
import test from "node:test";

test("PF2e spell-cast chat messages provide trait-use and spell-cast zone events", async () => {
  const prior = Object.fromEntries([
    "Hooks",
    "PF2EZoneRuntime",
    "document",
    "foundry",
    "fromUuid",
    "game"
  ].map((key) => [key, globalThis[key]]));

  const actor = { id: "dragon", uuid: "Actor.dragon" };
  const token = { id: "dragon-token", uuid: "Scene.scene.Token.dragon-token", actor, parent: { id: "scene" } };
  const item = {
    name: "Heal",
    type: "spell",
    system: { traits: { value: ["healing", "vitality"] } }
  };
  const detectMagic = {
    name: "Detect Magic",
    type: "spell",
    system: { traits: { value: ["concentrate", "detection", "divination", "manipulate"] } }
  };

  try {
    globalThis.PF2EZoneRuntime = undefined;
    globalThis.document = { addEventListener: () => undefined, removeEventListener: () => undefined };
    globalThis.Hooks = { on: () => "hook", off: () => undefined };
    globalThis.foundry = { utils: { randomID: () => "test-id" } };
    globalThis.game = {
      user: { id: "gm", isGM: true },
      users: { activeGM: { id: "gm" } },
      scenes: Object.assign([], {
        contents: [],
        get: (id) => id === "scene" ? { tokens: { get: (tokenId) => tokenId === "dragon-token" ? token : null } } : null
      }),
      actors: { contents: [] },
      time: { worldTime: 0 }
    };
    globalThis.fromUuid = async (uuid) => ({
      "Actor.dragon": actor,
      "Actor.dragon.Item.heal": item,
      "Actor.dragon.Item.detect-magic": detectMagic
    })[uuid] ?? null;

    const { zoneRuntimeEntrypoint } = await import(`../scripts/runtime.js?trait-use-test=${Date.now()}`);
    const runtime = await zoneRuntimeEntrypoint();
    const info = await runtime.traitUseInfoFromMessage({
      flags: {
        pf2e: {
          origin: {
            type: "spell",
            actor: "Actor.dragon",
            uuid: "Actor.dragon.Item.heal",
            rollOptions: []
          },
          context: { type: "spell-cast", options: [] }
        }
      },
      speaker: { scene: "scene", token: "dragon-token" }
    });

    assert.equal(info?.token, token);
    assert.equal(info?.itemName, "Heal");
    assert.ok(info?.traits.has("vitality"));
    assert.equal(
      runtime.formatChatAlert("{zone}: {outcome} / {count}", { zone: "Test Zone", outcome: "Success", count: 1 }),
      "Test Zone: {outcome} / 1"
    );

    const detectMagicMessage = {
      id: "detect-magic-message",
      flags: {
        pf2e: {
          origin: {
            type: "spell",
            actor: "Actor.dragon",
            uuid: "Actor.dragon.Item.detect-magic"
          }
        }
      },
      speaker: { scene: "scene", token: "dragon-token" }
    };
    const detectMagicInfo = await runtime.traitUseInfoFromMessage(detectMagicMessage);

    assert.equal(detectMagicInfo?.itemName, "Detect Magic");
    assert.equal(detectMagicInfo?.isSpellCast, true);
    assert.ok(detectMagicInfo?.traits.has("manipulate"));
    assert.ok(detectMagicInfo?.traits.has("concentrate"));

    const spellCastBlock = { id: "spell-cast", triggers: { spellCast: true } };
    const manipulateBlock = {
      id: "manipulate",
      triggers: { traitUse: true },
      traitUse: { traits: ["manipulate"] }
    };
    const payload = { config: { effects: [spellCastBlock, manipulateBlock] }, state: {} };
    const region = {
      uuid: "Scene.scene.Region.reach",
      parent: { id: "scene" },
      getFlag: () => payload
    };
    const processed = [];
    runtime.allZones = () => [region];
    runtime.tokensInside = () => [token];
    runtime.withState = async (_region, callback) => callback(payload);
    runtime.processBlock = async (...args) => processed.push(args);

    await runtime.handleTraitUseMessage(detectMagicMessage);
    assert.equal(processed.length, 2);
    assert.deepEqual(processed.map((entry) => entry[4]).sort(), ["spellCast", "traitUse"]);
    assert.ok(processed.every((entry) => entry[6].eventContext.itemName === "Detect Magic"));
    assert.equal(
      processed.find((entry) => entry[4] === "traitUse")?.[6].eventContext.trait,
      "manipulate"
    );

    // A spell's later damage card keeps its origin, but is not another cast or trait use.
    const vitalityBlock = {
      id: "vitality",
      triggers: { traitUse: true },
      traitUse: { traits: ["vitality"] }
    };
    payload.config.effects = [spellCastBlock, vitalityBlock];
    processed.length = 0;
    const healCastMessage = {
      id: "heal-cast",
      flags: { pf2e: {
        origin: {
          type: "spell", actor: actor.uuid, uuid: "Actor.dragon.Item.heal",
          rollOptions: ["action:cast-a-spell"]
        },
        context: { type: "spell-cast", options: [] }
      } },
      speaker: { scene: "scene", token: "dragon-token" },
      rolls: []
    };
    const healDamageMessage = {
      id: "heal-damage",
      flags: { pf2e: {
        origin: { type: "spell", actor: actor.uuid, uuid: "Actor.dragon.Item.heal" },
        context: { type: "damage-roll", options: ["item:trait:vitality"] }
      } },
      speaker: { scene: "scene", token: "dragon-token" },
      rolls: [{ total: 12 }]
    };
    await runtime.handleTraitUseMessage(healCastMessage);
    assert.deepEqual(processed.map((entry) => entry[4]).sort(), ["spellCast", "traitUse"]);
    assert.equal(await runtime.traitUseInfoFromMessage(healDamageMessage), null);
    await runtime.handleTraitUseMessage(healDamageMessage);
    assert.equal(processed.length, 2, "damage does not count as another cast or vitality use");

    const contextlessDamage = {
      ...healDamageMessage,
      id: "heal-damage-without-context",
      flags: { pf2e: { origin: healDamageMessage.flags.pf2e.origin } }
    };
    assert.equal(await runtime.traitUseInfoFromMessage(contextlessDamage), null);
    await runtime.handleTraitUseMessage(contextlessDamage);
    assert.equal(processed.length, 2, "roll data still identifies a damage follow-up without context");

    assert.deepEqual(
      runtime.watchedTraitsForBlock({ traitUse: { traits: ["void", "healing"] } }),
      ["void", "healing"]
    );
    assert.deepEqual(
      runtime.watchedTraitsForBlock({ traitUse: { trait: "vitality" } }),
      ["vitality"]
    );

    // Let the runtime's one-time hook initialization finish before restoring globals.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
