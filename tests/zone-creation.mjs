import assert from "node:assert/strict";
import test from "node:test";

import { createZoneDocument, requireValidConfig } from "../scripts/zone-creation.js";
import { defaultConfig, validateConfig } from "../scripts/zone-config.js";
import { handleWorkerRequest } from "../scripts/worker.js";

const gm = { id: "gm", name: "GM", active: true, isGM: true, color: "#336699" };
const created = [];
const activated = [];
const scene = {
  id: "scene",
  dimensions: { distancePixels: 20 },
  regions: new Map(),
  async createEmbeddedDocuments(type, [data]) {
    assert.equal(type, "Region");
    return [makeRegion(data)];
  }
};
const actor = { uuid: "Actor.source", name: "Source", combatant: null };
const token = { uuid: "Scene.scene.Token.source", documentName: "Token", parent: scene, actor };

/** Keeps both entry points on the same simulated Foundry document service. */
function makeRegion(data) {
  const id = `region-${created.length + 1}`;
  const region = {
    id, uuid: `Scene.scene.Region.${id}`, parent: scene,
    get shapes() { return (data.shapes ?? []).map((shape) => ({ toObject: () => structuredClone(shape) })); },
    getFlag: (scope, key) => data.flags?.[scope]?.[key],
    async update(changes) { Object.assign(data, structuredClone(changes)); }
  };
  created.push({ data, region });
  scene.regions.set(id, region);
  return region;
}

Math.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
globalThis.foundry = { utils: { randomID: () => "generated" } };
globalThis.CONST = {
  REGION_VISIBILITY: { ALWAYS: 2, OBSERVER: 3 },
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2 }
};
globalThis.CONFIG = {
  PF2E: {
    conditionTypes: {},
    damageTypes: {
      bludgeoning: "PF2E.Damage.RollFlavor.bludgeoning",
      piercing: "PF2E.Damage.RollFlavor.piercing",
      slashing: "PF2E.Damage.RollFlavor.slashing",
      fire: "PF2E.Damage.RollFlavor.fire"
    }
  },
  Region: { documentClass: { async createTokenEmanation(_token, _radius, data) { return makeRegion(data); } } }
};
globalThis.game = {
  system: { id: "pf2e" }, user: gm, users: new Map([[gm.id, gm]]),
  scenes: { get: (id) => id === scene.id ? scene : null },
  time: { worldTime: 100 }, combat: null,
  i18n: { localize: (key) => key }
};
const effectDocuments = new Map();
globalThis.fromUuid = async (uuid) => uuid === token.uuid ? token : effectDocuments.get(uuid) ?? null;
globalThis.PF2EZoneRuntime = {
  version: "0.5.20", installHooks() {},
  async activateRegion(region) { activated.push(region); }
};

/** Starts from a real builder default while selecting the minimum meaningful action. */
function validConfig() {
  const config = defaultConfig();
  config.name = "Shared Zone";
  config.targeting.affects = "enemies";
  config.effects[0].triggers.activation = true;
  config.effects[0].chatAlert.enabled = true;
  return config;
}

test("direct GM and worker creation persist identical normalized config and initial state", async () => {
  const config = validConfig();
  config.duration = { type: "custom-rounds", rounds: 3 };
  const direct = await createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm, color: gm.color
  });
  const worker = await handleWorkerRequest({
    protocol: 1, action: "create", requesterUserId: gm.id,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config, color: gm.color
  });
  assert.equal(worker.ok, true, worker.error);
  assert.equal(direct.durationResolution.rounds, 3);
  assert.deepEqual(created[0].data, created[1].data);
  assert.equal(created[0].data.flags.world.pf2eZone.state.sourceTokenUuid, token.uuid);
  assert.deepEqual(created[0].data.flags.world.pf2eZone.state.resolvedSaves, {});
  assert.deepEqual(activated, created.map((entry) => entry.region));
});

test("direct GM and worker creation repair duplicate block IDs before persistence", async () => {
  const config = validConfig();
  const second = structuredClone(config.effects[0]);
  second.name = "Other outcome";
  second.chatAlert.text = "Other block";
  config.effects.push(second);
  assert.match(validateConfig(config, { sourceActor: actor }).errors.join(" "), /shares ID/);

  const direct = await createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
  });
  const response = await handleWorkerRequest({
    protocol: 1, action: "create", requesterUserId: gm.id,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config
  });
  assert.equal(response.ok, true, response.error);
  const directIds = direct.region.getFlag("world", "pf2eZone").config.effects.map((block) => block.id);
  const workerIds = created.at(-1).data.flags.world.pf2eZone.config.effects.map((block) => block.id);
  assert.deepEqual(directIds, [config.effects[0].id, "generated-1"]);
  assert.deepEqual(workerIds, directIds);
});

test("direct GM creation retains the revision of its saved preset", async () => {
  const result = await createZoneDocument({
    rawConfig: validConfig(), scene, sourceActor: actor, sourceToken: token, requester: gm,
    savedPresetId: "saved-zone", savedPresetRevision: 4
  });
  const state = result.region.getFlag("world", "pf2eZone").state;
  assert.equal(state.savedPresetId, "saved-zone");
  assert.equal(state.savedPresetRevision, 4);
});

test("the worker rejects invalid triggers and saving-throw setups before creating a Region", async () => {
  for (const invalid of [
    (config) => { config.effects[0].triggers.activation = false; },
    (config) => { config.effects[0].save.enabled = true; config.effects[0].save.dc.value = ""; },
    (config) => { config.effects[0].triggers.continuous = true; config.effects[0].save.enabled = true; config.effects[0].save.dc.value = 20; }
  ]) {
    const config = validConfig();
    invalid(config);
    assert.ok(validateConfig(config, { sourceActor: actor }).errors.length);
    assert.throws(() => requireValidConfig(config, actor));
    const before = created.length;
    const prior = console.error;
    console.error = () => {};
    let response;
    try {
      response = await handleWorkerRequest({
        protocol: 1, action: "create", requesterUserId: gm.id,
        sceneId: scene.id, sourceTokenUuid: token.uuid, config
      });
    } finally {
      console.error = prior;
    }
    assert.equal(response.ok, false);
    assert.equal(created.length, before);
  }
});

test("GM and worker reject a saved spell DC that the source Actor does not have", async () => {
  const config = validConfig();
  config.effects[0].save.enabled = true;
  config.effects[0].save.dc = { mode: "actorStatistic", statistic: "spell-dc" };
  const validation = validateConfig(config, { sourceActor: actor });
  assert.match(validation.errors.join(" "), /spell-dc.*not available/);
  const before = created.length;
  assert.throws(() => requireValidConfig(config, actor), /spell-dc.*not available/);
  await assert.rejects(createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
  }), /spell-dc.*not available/);
  const previous = console.error;
  console.error = () => {};
  try {
    const response = await handleWorkerRequest({
      protocol: 1, action: "create", requesterUserId: gm.id,
      sceneId: scene.id, sourceTokenUuid: token.uuid, config
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /spell-dc.*not available/);
  } finally {
    console.error = previous;
  }
  assert.equal(created.length, before);
});

test("GM and worker reject unknown imported durations, conditions, and damage types", async () => {
  const invalid = [
    [(config) => { config.duration.type = "1-hour"; }, /Duration type.*1-hour/],
    [(config) => {
      config.effects[0].outcomes.noSave.conditions.push({
        slug: "not-a-condition", value: 1, removal: "normal", condition: null
      });
    }, /not-a-condition.*unavailable/],
    [(config) => {
      config.activationChoices.damageType = { enabled: true, options: ["fire", "legacy-shadow"] };
    }, /legacy-shadow.*unavailable in this PF2e version/]
  ];
  for (const [mutate, message] of invalid) {
    const config = validConfig();
    mutate(config);
    const before = created.length;
    await assert.rejects(createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    }), message);
    const previous = console.error;
    console.error = () => {};
    try {
      const response = await handleWorkerRequest({
        protocol: 1, action: "create", requesterUserId: gm.id,
        sceneId: scene.id, sourceTokenUuid: token.uuid, config
      });
      assert.equal(response.ok, false);
      assert.match(response.error, message);
    } finally {
      console.error = previous;
    }
    assert.equal(created.length, before);
  }
});

test("continuous maintenance and saving throws must use separate Effect Blocks", () => {
  const config = validConfig();
  const block = config.effects[0];
  block.triggers.continuous = true;
  block.save.enabled = true;
  block.save.dc.value = 20;
  const validation = validateConfig(config, { sourceActor: actor });
  assert.match(validation.errors.join(" "), /While a creature is inside.*separate Effect Block/);
  assert.deepEqual(validation.issues.find((issue) => issue.target?.field === "save-enabled")?.target, {
    scope: "block", index: 0, field: "save-enabled"
  });

  block.triggers.continuous = false;
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, [], "save-only blocks remain valid");
  block.triggers.continuous = true;
  block.save.enabled = false;
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, [], "continuous No Save blocks remain valid");

  const saveBlock = structuredClone(block);
  saveBlock.id = "separate-save";
  saveBlock.triggers = { ...saveBlock.triggers, activation: false, continuous: false, enter: true };
  saveBlock.save.enabled = true;
  config.effects.push(saveBlock);
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, [], "separate maintenance and save blocks remain valid");
});

test("direct and player creation reject missing and non-Effect Items before making a Region", async () => {
  effectDocuments.set("Item.valid", { documentName: "Item", type: "effect", name: "Valid" });
  effectDocuments.set("Item.action", { documentName: "Item", type: "action", name: "Wrong type" });
  for (const uuid of ["Item.missing", "Item.action"]) {
    const config = validConfig();
    config.effects[0].outcomes.noSave.effects.push({ uuid, removal: "item-duration" });
    const before = created.length;
    await assert.rejects(createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    }), /Effect Item/);
    const previous = console.error;
    console.error = () => {};
    try {
      const response = await handleWorkerRequest({
        protocol: 1, action: "create", requesterUserId: gm.id,
        sceneId: scene.id, sourceTokenUuid: token.uuid, config
      });
      assert.equal(response.ok, false);
      assert.match(response.error, /Effect Item/);
    } finally {
      console.error = previous;
    }
    assert.equal(created.length, before);
  }
  const config = validConfig();
  config.effects[0].outcomes.noSave.effects.push({ uuid: "Item.valid", removal: "item-duration" });
  const result = await createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
  });
  assert.ok(result.region);
});

test("inactive outcomes do not prevent GM or worker creation, but become validatable when enabled", async () => {
  const config = validConfig();
  config.effects[0].outcomes.failure.effects.push({ uuid: "Item.deleted", removal: "item-duration" });
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, []);
  const direct = await createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
  });
  assert.ok(direct.region);
  const beforeWorker = created.length;
  const worker = await handleWorkerRequest({
    protocol: 1, action: "create", requesterUserId: gm.id,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config
  });
  assert.equal(worker.ok, true, worker.error);
  assert.equal(created.length, beforeWorker + 1);
  assert.equal(created.at(-1).data.flags.world.pf2eZone.config.effects[0].outcomes.failure.effects[0].uuid, "Item.deleted");

  config.effects[0].save.enabled = true;
  config.effects[0].save.dc.value = 20;
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, []);
  const beforeRejected = created.length;
  await assert.rejects(createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
  }), /failure Effect Item 1/);
  const previous = console.error;
  console.error = () => {};
  try {
    const rejected = await handleWorkerRequest({
      protocol: 1, action: "create", requesterUserId: gm.id,
      sceneId: scene.id, sourceTokenUuid: token.uuid, config
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /failure Effect Item 1/);
  } finally {
    console.error = previous;
  }
  assert.equal(created.length, beforeRejected);
});

test("inactive linked conditions do not block a No Save zone", () => {
  const config = validConfig();
  config.effects[0].outcomes.failure.conditions.push({
    slug: "frightened", value: 1, removal: "condition-end", condition: null
  });
  assert.deepEqual(validateConfig(config, { sourceActor: actor }).errors, []);
  config.effects[0].save.enabled = true;
  config.effects[0].save.dc.value = 20;
  assert.match(validateConfig(config, { sourceActor: actor }).errors.join(" "), /Failure condition/);
});

test("activation failure still reports the committed Region to GM and player paths", async () => {
  const originalActivate = globalThis.PF2EZoneRuntime.activateRegion;
  const originalConsoleError = console.error;
  const before = created.length;
  globalThis.PF2EZoneRuntime.activateRegion = async () => {
    throw new Error("Simulated activation failure");
  };
  console.error = () => {};
  try {
    const config = validConfig();
    const direct = await createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    });
    assert.ok(direct.region);
    assert.match(direct.warnings[0], /zone was created, but activation did not finish/);
    assert.equal(created.length, before + 1);

    const response = await handleWorkerRequest({
      protocol: 1, action: "create", requesterUserId: gm.id,
      sceneId: scene.id, sourceTokenUuid: token.uuid, config
    });
    assert.equal(response.ok, true, response.error);
    assert.equal(response.regionId, created.at(-1).region.id);
    assert.match(response.warnings[0], /zone was created, but activation did not finish/);
    assert.equal(created.length, before + 2, "each request creates exactly one Region");
  } finally {
    globalThis.PF2EZoneRuntime.activateRegion = originalActivate;
    console.error = originalConsoleError;
  }
});

test("failed rolled-duration announcement does not hide the created Region", async () => {
  const originalRoll = globalThis.Roll;
  const originalChat = globalThis.ChatMessage;
  const originalConsoleError = console.error;
  globalThis.Roll = class {
    static validate() { return true; }
    async evaluate() { return { total: 3 }; }
  };
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    async create() { throw new Error("Simulated chat failure"); }
  };
  console.error = () => {};
  try {
    const config = validConfig();
    config.duration = { type: "custom-rounds", rounds: "1d4" };
    const result = await createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    });
    assert.ok(result.region);
    assert.equal(result.durationResolution.rounds, 3);
    assert.match(result.warnings[0], /rolled duration could not be posted/);
  } finally {
    if (originalRoll === undefined) delete globalThis.Roll;
    else globalThis.Roll = originalRoll;
    if (originalChat === undefined) delete globalThis.ChatMessage;
    else globalThis.ChatMessage = originalChat;
    console.error = originalConsoleError;
  }
});

test("GM worker reports a failed dismissal instead of claiming success", async () => {
  const previousRegions = scene.regions;
  const originalEndZone = globalThis.PF2EZoneRuntime.endZone;
  const previousConsoleError = console.error;
  const region = { id: "failed-dismissal", getFlag: () => ({ state: {} }) };
  scene.regions = new Map([[region.id, region]]);
  globalThis.PF2EZoneRuntime.endZone = async () => {
    throw new Error("Region deletion failed");
  };
  console.error = () => {};
  try {
    const response = await handleWorkerRequest({
      protocol: 1, action: "end", requesterUserId: gm.id,
      sceneId: scene.id, regionId: region.id
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /Region deletion failed/);
    assert.equal(scene.regions.has(region.id), true);
  } finally {
    console.error = previousConsoleError;
    globalThis.PF2EZoneRuntime.endZone = originalEndZone;
    if (previousRegions === undefined) delete scene.regions;
    else scene.regions = previousRegions;
  }
});

test("both area placement adapters use the shared payload and state", async () => {
  const config = validConfig();
  config.mode = "area";
  config.areaShape = "square";
  config.sideLength = 10;
  const direct = await createZoneDocument({
    rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm,
    placeArea: async (regionData) => makeRegion(regionData)
  });
  const worker = await handleWorkerRequest({
    protocol: 1, action: "create", requesterUserId: gm.id,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config,
    areaCenter: { x: 100, y: 100 }
  });
  assert.equal(worker.ok, true, worker.error);
  assert.ok(direct.region);
  assert.deepEqual(created.at(-2).data.flags, created.at(-1).data.flags);
  assert.equal(created.at(-1).data.shapes[0].type, "rectangle");
});

test("the worker manually moves a fixed area through a Region shape update", async () => {
  const config = validConfig();
  config.mode = "area";
  config.areaShape = "circle";
  config.radius = 15;
  const creation = await handleWorkerRequest({
    protocol: 1, action: "create", requesterUserId: gm.id,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config,
    areaCenter: { x: 100, y: 120 }
  });
  assert.equal(creation.ok, true, creation.error);
  const record = created.find((entry) => entry.region.id === creation.regionId);
  assert.deepEqual(record.data.shapes, [{
    type: "circle", x: 100, y: 120, radius: 300, gridBased: true
  }]);

  const moved = await handleWorkerRequest({
    protocol: 1, action: "move", requesterUserId: gm.id,
    sceneId: scene.id, regionId: creation.regionId,
    areaCenter: { x: 460, y: 240 }
  });
  assert.equal(moved.ok, true, moved.error);
  assert.deepEqual(moved.areaCenter, { x: 460, y: 240 });
  assert.deepEqual(record.data.shapes, [{
    type: "circle", x: 460, y: 240, radius: 300, gridBased: true
  }]);
});

test("the worker does not offer fixed-area movement to emanations", async () => {
  const config = validConfig();
  const creation = await handleWorkerRequest({
    protocol: 1, action: "create", requesterUserId: gm.id,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config
  });
  assert.equal(creation.ok, true, creation.error);
  const previous = console.error;
  console.error = () => {};
  try {
    const moved = await handleWorkerRequest({
      protocol: 1, action: "move", requesterUserId: gm.id,
      sceneId: scene.id, regionId: creation.regionId,
      areaCenter: { x: 200, y: 200 }
    });
    assert.equal(moved.ok, false);
    assert.match(moved.error, /Only fixed-area zones/);
  } finally {
    console.error = previous;
  }
});

test("creation anchors to a matching Scene encounter, never the GM's unrelated combat", async () => {
  const previousCombat = game.combat;
  const previousCombats = game.combats;
  const previousCombatant = actor.combatant;
  const otherScene = { id: "other" };
  const otherCombatant = {
    id: "other-source", actor,
    token: { uuid: "Scene.other.Token.source", parent: otherScene }
  };
  const otherCombat = {
    id: "other-fight", scene: otherScene, round: 9, turn: 0,
    turns: [otherCombatant], combatant: otherCombatant
  };
  const sourceCombatant = { id: "source", actor, token };
  const sceneCombat = {
    id: "scene-fight", scene, round: 2, turn: 0,
    turns: [sourceCombatant], combatant: sourceCombatant
  };
  const config = validConfig();
  config.duration = { type: "custom-rounds", rounds: 3 };

  try {
    game.combat = otherCombat;
    game.combats = { contents: [otherCombat] };
    actor.combatant = otherCombatant;
    const outside = await createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    });
    assert.equal(outside.region.getFlag("world", "pf2eZone").state.duration.combatId, null);

    game.combats.contents.push({
      id: "wrong-token", scene, round: 4, turn: 0,
      turns: [{
        id: "same-actor", actor,
        token: { uuid: "Scene.scene.Token.another", parent: scene }
      }]
    });
    const sameActor = await createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    });
    assert.equal(sameActor.region.getFlag("world", "pf2eZone").state.duration.combatId, null);

    game.combats.contents.push(sceneCombat);
    const inside = await createZoneDocument({
      rawConfig: config, scene, sourceActor: actor, sourceToken: token, requester: gm
    });
    const duration = inside.region.getFlag("world", "pf2eZone").state.duration;
    assert.equal(duration.combatId, sceneCombat.id);
    assert.equal(duration.sourceCombatantId, sourceCombatant.id);
    assert.equal(duration.combatExpiresAtRound, 5);
  } finally {
    game.combat = previousCombat;
    game.combats = previousCombats;
    actor.combatant = previousCombatant;
  }
});

test("a retried creation request returns one Region during and after GM processing", async () => {
  const operationId = "creation-retry-12345";
  const request = {
    protocol: 1, action: "create", requesterUserId: gm.id,
    operationId, sceneId: scene.id, sourceTokenUuid: token.uuid,
    config: validConfig(), color: gm.color
  };
  const originalCreate = CONFIG.Region.documentClass.createTokenEmanation;
  let startCreation;
  const entered = new Promise((resolve) => { startCreation = resolve; });
  let finishCreation;
  const blocked = new Promise((resolve) => { finishCreation = resolve; });
  let calls = 0;
  CONFIG.Region.documentClass.createTokenEmanation = async (...args) => {
    calls++;
    startCreation();
    await blocked;
    return originalCreate(...args);
  };
  try {
    const first = handleWorkerRequest(request);
    await entered;
    const second = handleWorkerRequest(structuredClone(request));
    assert.equal(calls, 1, "the second request joins the in-flight creation");
    finishCreation();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true, firstResult.error);
    assert.equal(secondResult.regionId, firstResult.regionId);
    assert.equal(calls, 1);

    const completedRetry = await handleWorkerRequest(request);
    assert.equal(completedRetry.regionId, firstResult.regionId);
    assert.equal(calls, 1);

    const reloadedWorker = await import(`../scripts/worker.js?reload=${Date.now()}`);
    const retryAfterReload = await reloadedWorker.handleWorkerRequest(request);
    assert.equal(retryAfterReload.regionId, firstResult.regionId);
    assert.equal(calls, 1, "persisted operation ID also survives a GM refresh");
    assert.equal(scene.regions.get(firstResult.regionId).getFlag("world", "pf2eZone").state.creationOperationId, operationId);
  } finally {
    finishCreation();
    CONFIG.Region.documentClass.createTokenEmanation = originalCreate;
  }
});
