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
      "Actor.dragon.Item.heal": item
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

    const detectMagicMessage = {
      id: "detect-magic-message",
      flags: {
        pf2e: {
          origin: {
            type: "spell",
            actor: "Actor.dragon",
            uuid: "Actor.dragon.Item.detect-magic",
            // PF2e puts spell traits directly in the cast card's roll options.
            // Detect Magic has no defense, so the card has no spell-cast context.
            rollOptions: ["action:cast-a-spell", "concentrate", "detection", "divination", "manipulate"]
          }
        }
      },
      speaker: { scene: "scene", token: "dragon-token" }
    };
    const detectMagicInfo = await runtime.traitUseInfoFromMessage(detectMagicMessage);

    assert.equal(detectMagicInfo?.itemName, "an ability");
    assert.equal(detectMagicInfo?.isSpellCast, true);
    assert.ok(detectMagicInfo?.traits.has("manipulate"));
    assert.ok(detectMagicInfo?.traits.has("concentrate"));

    const spellCastBlock = { id: "spell-cast", triggers: { spellCast: true } };
    const payload = { config: { effects: [spellCastBlock] }, state: {} };
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
    assert.equal(processed.length, 1);
    assert.equal(processed[0][4], "spellCast");
    assert.equal(processed[0][6].eventContext.itemName, "an ability");
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
