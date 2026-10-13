import assert from "node:assert/strict";
import test from "node:test";
import { executeShieldingTaunt } from "../scripts/shielding-taunt-worker.js";

let recoveryOperationCounter = 0;

function setupTauntRecovery() {
  const prior = Object.fromEntries(["ChatMessage", "CONST", "fromUuid", "game"].map((key) => [key, globalThis[key]]));
  const gm = { id: "gm", isGM: true, active: true };
  const otherGM = { id: "other-gm", isGM: true, active: false };
  const player = { id: "player", isGM: false, active: true };
  const users = [gm, otherGM, player];
  users.get = (id) => users.find((user) => user.id === id);
  users.activeGM = gm;
  const scene = { id: "recovery", tokens: [], grid: { type: 1, size: 100, sizeX: 100, sizeY: 100, distance: 5 },
    dimensions: { size: 100, distance: 5 } };
  const tauntUuid = "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW";
  const action = { uuid: "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb" };
  const effect = { type: "effect", toObject: () => ({ system: { traits: { value: [] }, context: {} } }) };
  const events = [];
  let effectCounter = 0;
  const makeActor = (name) => ({
    uuid: `Actor.${name}`, name, dimensions: { height: 5 }, itemTypes: { effect: [] },
    async createEmbeddedDocuments(_type, [source]) {
      events.push(`create:${name}`);
      const item = { ...structuredClone(source), id: `effect-${++effectCounter}`, sourceId: tauntUuid };
      this.itemTypes.effect.push(item);
      return [item];
    },
    async deleteEmbeddedDocuments(_type, ids) {
      events.push(`delete:${name}`);
      this.itemTypes.effect = this.itemTypes.effect.filter((item) => !ids.includes(item.id));
    }
  });
  const guardian = makeActor("Guardian");
  guardian.items = [{ slug: "shielding-taunt" }];
  guardian.heldShield = { name: "Shield" };
  guardian.system = { attributes: { shield: { raised: true } } };
  const target = makeActor("Target");
  const newerTarget = makeActor("Newer");
  const tokens = [guardian, target, newerTarget].map((actor, index) => ({
    documentName: "Token", uuid: `Scene.recovery.Token.${actor.name}`, name: actor.name,
    actor, parent: scene, x: index * 100, y: 0, width: 1, height: 1, elevation: 0
  }));
  scene.tokens.push(...tokens);
  const documents = new Map([...tokens.map((token) => [token.uuid, token]), [action.uuid, action], [tauntUuid, effect]]);
  const messages = [];
  globalThis.CONST = { GRID_TYPES: { SQUARE: 1 }, CHAT_MESSAGE_STYLES: { OTHER: 0 } };
  globalThis.game = { user: gm, users, actors: [guardian, target, newerTarget], scenes: [scene], messages: { contents: messages } };
  globalThis.fromUuid = async (uuid) => documents.get(uuid);
  globalThis.ChatMessage = { getSpeaker: () => ({}), async create(source) {
    assert.equal(source.author, game.user.id);
    const card = { ...source, id: `message-${messages.length + 1}` };
    messages.push(card);
    return card;
  } };
  return {
    gm, otherGM, player, guardian, target, newerTarget, tokens, events, messages,
    request: { operationId: `taunt-recovery-${++recoveryOperationCounter}`, requesterUserId: player.id,
      sourceTokenUuid: tokens[0].uuid, targetTokenUuid: tokens[1].uuid },
    restore() {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

for (const [name, change] of [
  ["player author", (card, f) => { card.author = f.player.id; }],
  ["claimed GM role on a player", (card, f) => { card.author = { id: f.player.id, isGM: true }; }],
  ["unknown author", (card) => { card.author = { id: "missing-user", isGM: true }; }],
  ["missing author", (card) => { delete card.author; }],
  ["conflicting canonical author", (card, f) => { card.author = f.player.id; card.user = f.gm.id; }],
  ["missing requester", (_card, _f, marker) => { delete marker.requesterUserId; }],
  ["missing source token", (_card, _f, marker) => { delete marker.sourceTokenUuid; }],
  ["missing target token", (_card, _f, marker) => { delete marker.targetTokenUuid; }],
  ["missing Guardian Actor", (_card, _f, marker) => { delete marker.guardianActorUuid; }],
  ["missing target Actor", (_card, _f, marker) => { delete marker.targetActorUuid; }],
  ["missing result", (_card, _f, marker) => { delete marker.result; }],
  ["wrong action", (_card, _f, marker) => { marker.result.action = "ask-question"; }],
  ["blank Guardian", (_card, _f, marker) => { marker.result.guardian = " "; }],
  ["missing target name", (_card, _f, marker) => { delete marker.result.target; }],
  ["nonnumeric distance", (_card, _f, marker) => { marker.result.distance = "5"; }],
  ["out-of-range result", (_card, _f, marker) => { marker.result.distance = marker.result.maximumRange + 5; }],
  ["missing maximum range", (_card, _f, marker) => { delete marker.result.maximumRange; }],
  ["forged conflicting details", (card, f, marker) => {
    card.author = f.player.id;
    marker.targetTokenUuid = "Scene.recovery.Token.Forged";
  }]
]) {
  test(`Shielding Taunt ignores completion with ${name} instead of skipping the action`, async () => {
    const f = setupTauntRecovery();
    try {
      const original = await executeShieldingTaunt(f.request);
      const card = f.messages[0];
      change(card, f, card.flags.world.pf2eZoneShieldingTauntMessage);
      f.target.itemTypes.effect = [];
      f.events.length = 0;
      const result = await executeShieldingTaunt(f.request);
      assert.deepEqual(result, original);
      assert.deepEqual(f.events, ["create:Target"]);
      assert.equal(f.target.itemTypes.effect.length, 1);
      assert.equal(f.messages.length, 2, "An invalid marker must not suppress the authentic announcement");
    } finally { f.restore(); }
  });
}

for (const legacy of [false, true]) {
  test(`Shielding Taunt reuses a GM completion after refresh without reverting a newer target${legacy ? " with a legacy author" : ""}`, async () => {
    const f = setupTauntRecovery();
    try {
      const original = await executeShieldingTaunt(f.request);
      const card = f.messages[0];
      if (legacy) { card.user = f.gm.id; delete card.author; }
      else card.author = f.gm;
      await executeShieldingTaunt({ ...f.request, operationId: `${f.request.operationId}-newer`, targetTokenUuid: f.tokens[2].uuid });
      const forged = structuredClone(f.messages[1]);
      forged.author = f.player.id;
      forged.flags.world.pf2eZoneShieldingTauntMessage.operationId = f.request.operationId;
      f.messages.unshift(forged);
      f.gm.active = false;
      f.otherGM.active = true;
      game.user = f.otherGM;
      game.users.activeGM = f.otherGM;
      game.messages = { values: () => f.messages.values() };
      f.events.length = 0;
      const fresh = await import(`../scripts/shielding-taunt-worker.js?refresh=${f.request.operationId}`);
      assert.deepEqual(await fresh.executeShieldingTaunt(f.request), original);
      assert.deepEqual(f.events, []);
      assert.equal(f.target.itemTypes.effect.length, 0);
      assert.equal(f.newerTarget.itemTypes.effect.length, 1);
      assert.equal(f.messages.length, 3);
      await assert.rejects(fresh.executeShieldingTaunt({ ...f.request, targetTokenUuid: f.tokens[2].uuid }), /reused with different request details/);
    } finally { f.restore(); }
  });
}

test("Shielding Taunt retains completion recovery for direct GM operations with a null requester", async () => {
  const f = setupTauntRecovery();
  try {
    const payload = { ...f.request, requesterUserId: null };
    const result = await executeShieldingTaunt(payload);
    f.events.length = 0;
    assert.deepEqual(await executeShieldingTaunt(payload), result);
    assert.deepEqual(f.events, []);
    assert.equal(f.messages.length, 1);
  } finally { f.restore(); }
});

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

test("Shielding Taunt rolls back failed cleanup, resumes a partial rollback, and isolates chat failure", async () => {
  const prior = Object.fromEntries([
    "ChatMessage", "CONST", "fromUuid", "game"
  ].map((key) => [key, globalThis[key]]));
  const priorConsoleWarn = console.warn;
  const tauntUuid = "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW";
  const action = { uuid: "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb" };
  const effect = {
    type: "effect",
    toObject: () => ({ system: { traits: { value: [] }, context: {} } })
  };
  const scene = {
    id: "transaction-scene",
    tokens: [],
    grid: { type: 1, size: 100, sizeX: 100, sizeY: 100, distance: 5 },
    dimensions: { size: 100, distance: 5 }
  };
  const guardian = {
    uuid: "Actor.transaction-guardian", name: "Guardian",
    items: [{ slug: "shielding-taunt", name: "Shielding Taunt" }],
    itemTypes: { effect: [] },
    heldShield: { name: "Steel Shield", isBroken: false, isDestroyed: false },
    dimensions: { height: 5 },
    system: { attributes: { shield: { raised: true } } }
  };
  let failOldDelete = true;
  let failReplacementDelete = false;
  let failChat = false;
  let creationCount = 0;
  const oldTarget = {
    uuid: "Actor.old-target", name: "Old target", dimensions: { height: 5 },
    itemTypes: { effect: [{
      id: "old-taunt", sourceId: tauntUuid,
      system: { context: { origin: { actor: guardian.uuid } } }
    }] },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      if (failOldDelete) throw new Error("injected old cleanup failure");
      this.itemTypes.effect = this.itemTypes.effect.filter((item) => !ids.includes(item.id));
    }
  };
  const newTarget = {
    uuid: "Actor.new-target", name: "New target", dimensions: { height: 5 },
    itemTypes: { effect: [] },
    async createEmbeddedDocuments(type, [source]) {
      assert.equal(type, "Item");
      creationCount += 1;
      const item = {
        ...structuredClone(source),
        id: `replacement-${creationCount}`,
        sourceId: tauntUuid
      };
      this.itemTypes.effect.push(item);
      return [item];
    },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      if (failReplacementDelete) throw new Error("injected rollback failure");
      this.itemTypes.effect = this.itemTypes.effect.filter((item) => !ids.includes(item.id));
    }
  };
  const sourceToken = {
    documentName: "Token", uuid: "Scene.transaction-scene.Token.guardian", name: "Guardian",
    actor: guardian, parent: scene, x: 0, y: 0, width: 1, height: 1, elevation: 0
  };
  const oldToken = {
    documentName: "Token", uuid: "Scene.transaction-scene.Token.old", name: "Old target",
    actor: oldTarget, parent: scene, x: 100, y: 0, width: 1, height: 1, elevation: 0
  };
  const newToken = {
    documentName: "Token", uuid: "Scene.transaction-scene.Token.new", name: "New target",
    actor: newTarget, parent: scene, x: 200, y: 0, width: 1, height: 1, elevation: 0
  };
  scene.tokens.push(sourceToken, oldToken, newToken);
  const messages = [];
  const documents = new Map([
    [sourceToken.uuid, sourceToken], [newToken.uuid, newToken],
    [action.uuid, action], [tauntUuid, effect]
  ]);
  const request = {
    requesterUserId: "gm-user",
    sourceTokenUuid: sourceToken.uuid,
    targetTokenUuid: newToken.uuid
  };
  const countTaunts = () => [oldTarget, newTarget]
    .flatMap((actor) => actor.itemTypes.effect)
    .filter((item) => item.sourceId === tauntUuid && item.system?.context?.origin?.actor === guardian.uuid)
    .length;

  try {
    console.warn = () => {};
    globalThis.CONST = { GRID_TYPES: { SQUARE: 1 }, CHAT_MESSAGE_STYLES: { OTHER: 0 } };
    globalThis.game = {
      user: { id: "gm-user", isGM: true },
      users: { get: (id) => id === "gm-user" ? game.user : null },
      actors: [guardian, oldTarget, newTarget], scenes: [scene],
      messages: { contents: messages }
    };
    globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;
    globalThis.ChatMessage = {
      getSpeaker: () => ({}),
      async create(source) {
        if (failChat) throw new Error("injected chat failure");
        messages.push(source);
        return source;
      }
    };

    await assert.rejects(
      executeShieldingTaunt({ ...request, operationId: "operation-rollback-001" }),
      /previous Taunt could not be replaced/
    );
    assert.equal(countTaunts(), 1);
    assert.equal(oldTarget.itemTypes.effect.length, 1);
    assert.equal(newTarget.itemTypes.effect.length, 0);

    failReplacementDelete = true;
    await assert.rejects(
      executeShieldingTaunt({ ...request, operationId: "operation-resume-0001" }),
      /replacement could not be rolled back/
    );
    assert.equal(countTaunts(), 2);
    assert.equal(creationCount, 2);

    failOldDelete = false;
    failReplacementDelete = false;
    failChat = true;
    const recovered = await executeShieldingTaunt({ ...request, operationId: "operation-resume-0001" });
    assert.equal(recovered.mechanicalSuccess, true);
    assert.match(recovered.warnings.join(" "), /chat message could not be posted/i);
    assert.equal(countTaunts(), 1);
    assert.equal(oldTarget.itemTypes.effect.length, 0);
    assert.equal(newTarget.itemTypes.effect.length, 1);
    assert.equal(creationCount, 2);
    assert.equal(
      newTarget.itemTypes.effect[0].flags.world.pf2eZoneShieldingTaunt.operationId,
      "operation-resume-0001"
    );

    failChat = false;
    const delivered = await executeShieldingTaunt({ ...request, operationId: "operation-resume-0001" });
    assert.equal(delivered.mechanicalSuccess, true);
    assert.equal(messages.length, 1);
    assert.equal(creationCount, 2);

    const duplicate = await executeShieldingTaunt({ ...request, operationId: "operation-resume-0001" });
    assert.equal(duplicate.mechanicalSuccess, true);
    assert.equal(messages.length, 1);
    assert.equal(creationCount, 2);

    await assert.rejects(
      executeShieldingTaunt({
        ...request,
        operationId: "operation-resume-0001",
        targetTokenUuid: "Scene.transaction-scene.Token.different"
      }),
      /reused with different request details/
    );
  } finally {
    console.warn = priorConsoleWarn;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
