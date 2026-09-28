import assert from "node:assert/strict";
import test from "node:test";
import { executeShieldingTaunt } from "../scripts/shielding-taunt-worker.js";

test("Shielding Taunt measures from its owning Scene without requiring the GM to view it", async () => {
  const prior = Object.fromEntries([
    "canvas", "ChatMessage", "CONST", "fromUuid", "game"
  ].map((key) => [key, globalThis[key]]));

  const grid = {
    type: 1,
    size: 100,
    sizeX: 100,
    sizeY: 100,
    distance: 5,
    getTopLeftPoint: ({ x, y }) => ({
      x: Math.floor(x / 100) * 100,
      y: Math.floor(y / 100) * 100
    })
  };
  const scene = { id: "scene", tokens: [], grid, dimensions: { size: 100, distance: 5 } };
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
    dimensions: { height: 5 },
    getSelfRollOptions: () => ["origin:guardian"]
  };
  let createdEffect;
  let deletedEffectIds;
  const target = {
    name: "Dragon",
    uuid: "Actor.dragon",
    dimensions: { height: 10 },
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
  const sourceToken = {
    documentName: "Token",
    uuid: "Scene.scene.Token.guardian",
    name: "Guardian",
    actor: guardian,
    parent: scene,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    elevation: 0,
    object: null
  };
  const targetToken = {
    documentName: "Token",
    uuid: "Scene.scene.Token.dragon",
    name: "Dragon",
    actor: target,
    parent: scene,
    x: 1200,
    y: 0,
    width: 2,
    height: 2,
    elevation: 0,
    object: null
  };
  scene.tokens.push(sourceToken, targetToken);
  const tauntAction = { uuid: "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb", getRollOptions: () => ["origin:item:taunt"] };
  const tauntEffect = {
    type: "effect",
    toObject: () => ({ _id: "source-effect", system: { traits: { value: [] }, context: {} } })
  };
  let chat;

  try {
    globalThis.canvas = { scene: { id: "different-scene" } };
    globalThis.CONST = { GRID_TYPES: { SQUARE: 1 }, CHAT_MESSAGE_STYLES: { OTHER: 0 } };
    globalThis.ChatMessage = {
      getSpeaker: ({ actor, scene: speakerScene, token }) => ({
        actor: actor.uuid,
        scene: speakerScene.id,
        token: token === sourceToken ? sourceToken.uuid : null
      }),
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
    assert.deepEqual(chat.speaker, {
      actor: guardian.uuid,
      scene: scene.id,
      token: sourceToken.uuid
    });
    assert.match(chat.content, /Guardian raises Tower Shield and taunts <strong>Dragon<\/strong>/);

    // PF2e's nearest occupied squares can be in range when a Large token's center is not.
    guardian.items = guardian.items.filter((item) => item.slug !== "long-distance-taunt");
    targetToken.x = 600;
    const largeTargetResult = await executeShieldingTaunt({
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid
    });
    assert.equal(largeTargetResult.maximumRange, 30);
    assert.equal(largeTargetResult.distance, 30);

    // Overlapping creature heights add no vertical distance.
    targetToken.elevation = 5;
    const overlappingElevationResult = await executeShieldingTaunt({
      sourceTokenUuid: sourceToken.uuid,
      targetTokenUuid: targetToken.uuid
    });
    assert.equal(overlappingElevationResult.distance, 30);

    // Elevation can put the same target beyond the 30-foot range.
    targetToken.elevation = 15;
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


test("overlapping Shielding Taunts leave only the latest target affected", async () => {
  const prior = Object.fromEntries([
    "canvas", "ChatMessage", "CONST", "fromUuid", "game"
  ].map((key) => [key, globalThis[key]]));

  const grid = { type: 1, size: 100, sizeX: 100, sizeY: 100, distance: 5 };
  const scene = { id: "scene", tokens: [], grid, dimensions: { size: 100, distance: 5 } };
  const guardian = {
    uuid: "Actor.shared-guardian", name: "Guardian",
    items: [{ slug: "shielding-taunt", name: "Shielding Taunt" }],
    heldShield: { name: "Shield", isBroken: false, isDestroyed: false },
    dimensions: { height: 5 },
    system: { attributes: { shield: { raised: true } } }
  };
  const tauntUuid = "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW";
  const action = { uuid: "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb" };
  const effect = {
    type: "effect",
    toObject: () => ({ system: { traits: { value: [] }, context: {} } })
  };
  const events = [];
  let releaseFirst;
  const firstCreationReleased = new Promise((resolve) => { releaseFirst = resolve; });
  let signalFirstStarted;
  const firstCreationStarted = new Promise((resolve) => { signalFirstStarted = resolve; });

  /** Models Foundry adding a created Effect to the target's live Item collection. */
  function makeTarget(name) {
    return {
      uuid: "Actor." + name, name,
      dimensions: { height: 5 },
      itemTypes: { effect: [] },
      async createEmbeddedDocuments(type, [source]) {
        assert.equal(type, "Item");
        events.push("create:" + name);
        if (name === "First") {
          signalFirstStarted();
          await firstCreationReleased;
        }
        const item = {
          id: "taunt-" + name,
          sourceId: tauntUuid,
          system: { context: { origin: { actor: source.system.context.origin.actor } } }
        };
        this.itemTypes.effect.push(item);
        return [item];
      },
      async deleteEmbeddedDocuments(type, ids) {
        assert.equal(type, "Item");
        events.push("delete:" + name);
        this.itemTypes.effect = this.itemTypes.effect.filter((item) => !ids.includes(item.id));
      }
    };
  }

  const first = makeTarget("First");
  const second = makeTarget("Second");
  const sourceToken = {
    documentName: "Token", uuid: "Scene.scene.Token.guardian", name: "Guardian",
    actor: guardian, parent: scene, x: 0, y: 0, width: 1, height: 1, elevation: 0, object: null
  };
  const firstToken = {
    documentName: "Token", uuid: "Scene.scene.Token.first", name: "First",
    actor: first, parent: scene, x: 200, y: 0, width: 1, height: 1, elevation: 0, object: null
  };
  const secondToken = {
    documentName: "Token", uuid: "Scene.scene.Token.second", name: "Second",
    actor: second, parent: scene, x: 300, y: 0, width: 1, height: 1, elevation: 0, object: null
  };
  scene.tokens.push(sourceToken, firstToken, secondToken);

  try {
    globalThis.canvas = { scene: { id: "different-scene" } };
    globalThis.CONST = { GRID_TYPES: { SQUARE: 1 }, CHAT_MESSAGE_STYLES: { OTHER: 0 } };
    globalThis.ChatMessage = {
      getSpeaker: () => ({}),
      create: async () => {}
    };
    globalThis.game = {
      user: { isGM: true }, actors: [guardian, first, second], scenes: [scene]
    };
    const documents = new Map([
      [sourceToken.uuid, sourceToken], [firstToken.uuid, firstToken],
      [secondToken.uuid, secondToken], [action.uuid, action], [tauntUuid, effect]
    ]);
    globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;

    const firstRequest = executeShieldingTaunt({
      sourceTokenUuid: sourceToken.uuid, targetTokenUuid: firstToken.uuid
    });
    await firstCreationStarted;
    const secondRequest = executeShieldingTaunt({
      sourceTokenUuid: sourceToken.uuid, targetTokenUuid: secondToken.uuid
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondStartedBeforeFirstFinished = events.includes("create:Second");
    releaseFirst();
    const results = await Promise.all([firstRequest, secondRequest]);

    assert.equal(secondStartedBeforeFirstFinished, false);
    assert.deepEqual(results.map((result) => result.target), ["First", "Second"]);
    assert.deepEqual(events, ["create:First", "create:Second", "delete:First"]);
    assert.equal(first.itemTypes.effect.length, 0);
    assert.deepEqual(second.itemTypes.effect.map((item) => item.id), ["taunt-Second"]);
  } finally {
    releaseFirst();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
