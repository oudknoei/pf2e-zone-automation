import assert from "node:assert/strict";
import test from "node:test";

test("a PF2e spell-cast chat message triggers a watched spell trait", async () => {
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

    // Let the runtime's one-time hook initialization finish before restoring globals.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
