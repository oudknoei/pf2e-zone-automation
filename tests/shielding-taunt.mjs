import assert from "node:assert/strict";
import test from "node:test";
import { executeShieldingTaunt } from "../scripts/shielding-taunt-worker.js";

test("Shielding Taunt uses PF2e token distance and applies the auditory Taunt", async () => {
  const prior = Object.fromEntries([
    "canvas", "ChatMessage", "CONST", "fromUuid", "game"
  ].map((key) => [key, globalThis[key]]));

  const scene = { id: "scene", tokens: [] };
  const guardian = {
    name: "Guardian",
    uuid: "Actor.guardian",
    items: [
      { slug: "shielding-taunt", name: "Shielding Taunt" },
      { slug: "long-distance-taunt", name: "Long-Distance Taunt" }
    ],
    itemTypes: { effect: [] },
    heldShield: { name: "Tower Shield", isBroken: false, isDestroyed: false },
    system: { attributes: { shield: { raised: false } } },
    getSelfRollOptions: () => ["origin:guardian"]
  };
  let createdEffect;
  let deletedEffectIds;
  const target = {
    name: "Dragon",
    uuid: "Actor.dragon",
    items: [],
    itemTypes: {
      effect: [{
        id: "previous-taunt",
        sourceId: "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW",
        system: { context: { origin: { actor: guardian.uuid } } }
      }]
    },
    async createEmbeddedDocuments(type, sources) {
      assert.equal(type, "Item");
      createdEffect = sources[0];
      return [{ id: "new-taunt" }];
    },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      deletedEffectIds = ids;
    }
  };
  let measuredDistance = 60;
  const sourceToken = {
    documentName: "Token",
    uuid: "Scene.scene.Token.guardian",
    name: "Guardian",
    actor: guardian,
    parent: scene,
    object: {
      center: { x: 0, y: 0 },
      distanceTo(otherToken) {
        assert.equal(otherToken, targetToken.object);
        return measuredDistance;
      }
    }
  };
  const targetToken = {
    documentName: "Token",
    uuid: "Scene.scene.Token.dragon",
    name: "Dragon",
    actor: target,
    parent: scene,
    object: { center: { x: 800, y: 0 }, document: { elevation: 0 }, mechanicalBounds: { width: 200, height: 200 } }
  };
  scene.tokens.push(sourceToken, targetToken);
  const tauntAction = { uuid: "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb", getRollOptions: () => ["origin:item:taunt"] };
  const tauntEffect = {
    type: "effect",
    toObject: () => ({ _id: "source-effect", system: { traits: { value: [] }, context: {} } })
  };
  let chat;

  try {
    globalThis.canvas = { scene, grid: { measurePath: () => { throw new Error("Center measurement must not be used."); } } };
    globalThis.CONST = { CHAT_MESSAGE_STYLES: { OTHER: 0 } };
    globalThis.ChatMessage = {
      getSpeaker: ({ actor, token }) => ({ actor: actor.uuid, token: token === sourceToken.object ? sourceToken.uuid : null }),
      create: async (data) => { chat = data; }
    };
    globalThis.game = {
      user: { isGM: true },
      actors: [guardian, target],
      scenes: [scene],
      pf2e: { actions: { raiseAShield: async ({ actors }) => {
        assert.deepEqual(actors, [guardian]);
        guardian.system.attributes.shield.raised = true;
      } } }
    };
    globalThis.fromUuid = async (uuid) => ({
      [sourceToken.uuid]: sourceToken,
      [targetToken.uuid]: targetToken,
      [tauntAction.uuid]: tauntAction,
      "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW": tauntEffect
    })[uuid] ?? null;

    const result = await executeShieldingTaunt({
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid
    });

    assert.equal(result.action, "shielding-taunt");
    assert.equal(result.maximumRange, 120);
    assert.equal(result.distance, 60);
    assert.equal(guardian.system.attributes.shield.raised, true);
    assert.deepEqual(createdEffect.system.traits.value, ["auditory"]);
    assert.equal(createdEffect.system.context.origin.actor, guardian.uuid);
    assert.equal(createdEffect.system.context.target.actor, target.uuid);
    assert.deepEqual(deletedEffectIds, ["previous-taunt"]);
    assert.match(chat.content, /Guardian raises Tower Shield and taunts <strong>Dragon<\/strong>/);

    // PF2e's nearest occupied squares can be in range when a Large token's center is not.
    guardian.items = guardian.items.filter((item) => item.slug !== "long-distance-taunt");
    measuredDistance = 30;
    const largeTargetResult = await executeShieldingTaunt({
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid
    });
    assert.equal(largeTargetResult.maximumRange, 30);
    assert.equal(largeTargetResult.distance, 30);

    // Elevation can put the same target beyond the 30-foot range.
    targetToken.object.document.elevation = 20;
    measuredDistance = 35;
    await assert.rejects(
      executeShieldingTaunt({ sourceTokenUuid: sourceToken.uuid, targetTokenUuid: targetToken.uuid }),
      /Dragon is 35 feet away; maximum Taunt range is 30 feet/
    );
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
