import assert from "node:assert/strict";
import test from "node:test";

import { createZoneDocument, creationRequestFingerprint, requireValidConfig } from "../scripts/zone-creation.js";
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
  scenes: new Map([[scene.id, scene]]),
  time: { worldTime: 100 }, combat: null,
  i18n: { localize: (key) => key }
};
const effectDocuments = new Map();
globalThis.fromUuid = async (uuid) => uuid === token.uuid ? token : effectDocuments.get(uuid) ?? null;
globalThis.PF2EZoneRuntime = {
  version: "0.5.21", installHooks() {},
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

let fingerprintOperationCounter = 0;

function fingerprintRequest(extra = {}) {
  return {
    protocol: 1, action: "create", requesterUserId: gm.id,
    operationId: `creation-fingerprint-${++fingerprintOperationCounter}`,
    sceneId: scene.id, sourceTokenUuid: token.uuid, config: validConfig(),
    savedPresetId: null, savedPresetRevision: null, chosenDamageType: null,
    color: gm.color, areaCenter: null, ...extra
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
  }
  return value;
}

async function rejectedCreation(worker, request) {
  const prior = console.error;
  console.error = () => {};
  try { return await worker(request); }
  finally { console.error = prior; }
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
  assert.equal(created[0].data.displayMeasurements, true);
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
    assert.equal(scene.regions.get(firstResult.regionId).getFlag("world", "pf2eZone").state.creationFingerprint, creationRequestFingerprint(request));
  } finally {
    finishCreation();
    CONFIG.Region.documentClass.createTokenEmanation = originalCreate;
  }
});

for (const [name, change] of [
  ["zone name", (request) => { request.config.name = "Changed zone"; }],
  ["nested configuration", (request) => { request.config.effects[0].chatAlert.text = "Changed alert"; }],
  ["effect order", (request) => { request.config.effects.reverse(); }],
  ["preset identity", (request) => { request.savedPresetId = "another-preset"; }],
  ["preset revision", (request) => { request.savedPresetRevision = 2; }],
  ["activation choice", (request) => { request.chosenDamageType = "fire"; }],
  ["color", (request) => { request.color = "#ff0000"; }],
  ["area placement", (request) => { request.areaCenter.x += 100; }]
]) {
  test(`creation rejects changed ${name} both in memory and after a worker refresh`, async () => {
    const config = validConfig();
    config.mode = "area";
    const second = structuredClone(config.effects[0]);
    second.id = "another-effect";
    second.chatAlert.text = "Second alert";
    config.effects.push(second);
    const request = fingerprintRequest({ config, areaCenter: { x: 100, y: 200 } });
    const original = await handleWorkerRequest(request);
    assert.equal(original.ok, true, original.error);
    const before = created.length;
    const beforeActivations = activated.length;
    const state = scene.regions.get(original.regionId).getFlag("world", "pf2eZone").state;
    assert.equal(state.creationFingerprint, creationRequestFingerprint(request));
    const changed = structuredClone(request);
    change(changed);
    const cached = await rejectedCreation(handleWorkerRequest, changed);
    assert.equal(cached.ok, false);
    assert.match(cached.error, /reused with different zone details/);
    const fresh = await import(`../scripts/worker.js?fingerprint=${request.operationId}`);
    const reloaded = await rejectedCreation(fresh.handleWorkerRequest, changed);
    assert.equal(reloaded.ok, false);
    assert.equal(reloaded.error, cached.error);
    const identical = await fresh.handleWorkerRequest(request);
    assert.equal(identical.ok, true, identical.error);
    assert.equal(identical.regionId, original.regionId);
    assert.equal(created.length, before);
    assert.equal(activated.length, beforeActivations);
  });
}

test("a changed source token cannot reuse a creation after refresh", async () => {
  const request = fingerprintRequest();
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const before = created.length;
  const prior = fromUuid;
  const otherToken = { ...token, uuid: "Scene.scene.Token.other-source" };
  globalThis.fromUuid = async (uuid) => uuid === otherToken.uuid ? otherToken : prior(uuid);
  try {
    const fresh = await import(`../scripts/worker.js?source=${request.operationId}`);
    const changed = await rejectedCreation(fresh.handleWorkerRequest, { ...request, sourceTokenUuid: otherToken.uuid });
    assert.equal(changed.ok, false);
    assert.match(changed.error, /reused with different zone details/);
    assert.equal(created.length, before);
  } finally { globalThis.fromUuid = prior; }
});

test("a creation operation is checked across Scenes after refresh", async () => {
  const request = fingerprintRequest();
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const before = created.length;
  const otherScene = { id: "another-scene", regions: new Map() };
  const otherToken = { ...token, uuid: "Scene.another-scene.Token.source", parent: otherScene };
  const prior = fromUuid;
  game.scenes.set(otherScene.id, otherScene);
  globalThis.fromUuid = async (uuid) => uuid === otherToken.uuid ? otherToken : prior(uuid);
  try {
    const fresh = await import(`../scripts/worker.js?scene=${request.operationId}`);
    const changed = await rejectedCreation(fresh.handleWorkerRequest, {
      ...request, sceneId: otherScene.id, sourceTokenUuid: otherToken.uuid
    });
    assert.equal(changed.ok, false);
    assert.match(changed.error, /reused with different zone details/);
    assert.equal(created.length, before);
    assert.equal(otherScene.regions.size, 0);
  } finally {
    game.scenes.delete(otherScene.id);
    globalThis.fromUuid = prior;
  }
});

test("canonical creation fingerprints ignore object key order and omitted optional fields, preserving array order", async () => {
  const request = fingerprintRequest();
  const second = structuredClone(request.config.effects[0]);
  second.id = "second-effect";
  second.chatAlert.text = "Second effect";
  request.config.effects.push(second);
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const reordered = reverseObjectKeys(request);
  for (const field of ["savedPresetId", "savedPresetRevision", "chosenDamageType", "areaCenter"]) delete reordered[field];
  assert.equal(creationRequestFingerprint(reordered), creationRequestFingerprint(request));
  assert.equal((await handleWorkerRequest(reordered)).regionId, original.regionId);
  const before = created.length;
  const fresh = await import(`../scripts/worker.js?canonical=${request.operationId}`);
  assert.equal((await fresh.handleWorkerRequest(reordered)).regionId, original.regionId);
  assert.equal(created.length, before);
  const changed = structuredClone(reordered);
  changed.config.effects.reverse();
  assert.notEqual(creationRequestFingerprint(changed), creationRequestFingerprint(request));
});

test("creation snapshots the request before waiting and fingerprints the accepted raw configuration", async () => {
  const request = fingerprintRequest();
  // Normalization repairs this ID, so fingerprinting the normalized Region config would reject a genuine retry.
  request.config.effects.push(structuredClone(request.config.effects[0]));
  const originalRequest = structuredClone(request);
  const prior = fromUuid;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  globalThis.fromUuid = async (uuid) => { entered(); await wait; return prior(uuid); };
  try {
    const pending = handleWorkerRequest(request);
    await started;
    request.config.name = "Changed while waiting";
    request.color = "#ff0000";
    release();
    const result = await pending;
    assert.equal(result.ok, true, result.error);
    const payload = scene.regions.get(result.regionId).getFlag("world", "pf2eZone");
    assert.equal(payload.config.name, originalRequest.config.name);
    assert.notEqual(payload.config.effects[0].id, payload.config.effects[1].id);
    assert.equal(payload.state.creationFingerprint, creationRequestFingerprint(originalRequest));
    const before = created.length;
    const fresh = await import(`../scripts/worker.js?snapshot=${originalRequest.operationId}`);
    assert.equal((await fresh.handleWorkerRequest(originalRequest)).regionId, result.regionId);
    assert.equal(created.length, before);
  } finally { release(); globalThis.fromUuid = prior; }
});

test("durable creation validation still rejects changed details when the ten-minute cache expires", async () => {
  const request = fingerprintRequest();
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const before = created.length;
  const prior = Date.now;
  Date.now = () => prior() + 10 * 60 * 1000 + 1;
  try {
    const changed = await rejectedCreation(handleWorkerRequest, { ...request, color: "#ff0000" });
    assert.equal(changed.ok, false);
    assert.match(changed.error, /reused with different zone details/);
    assert.equal((await handleWorkerRequest(request)).regionId, original.regionId);
    assert.equal(created.length, before);
  } finally { Date.now = prior; }
});

for (const fingerprint of [undefined, null, "", 42]) {
  test(`legacy creation retry fails safely for a ${String(fingerprint)} fingerprint`, async () => {
    const request = fingerprintRequest();
    const original = await handleWorkerRequest(request);
    assert.equal(original.ok, true, original.error);
    const region = scene.regions.get(original.regionId);
    const state = region.getFlag("world", "pf2eZone").state;
    if (fingerprint === undefined) delete state.creationFingerprint;
    else state.creationFingerprint = fingerprint;
    const before = created.length;
    const beforeActivations = activated.length;
    const fresh = await import(`../scripts/worker.js?legacy=${request.operationId}`);
    const result = await rejectedCreation(fresh.handleWorkerRequest, request);
    assert.equal(result.ok, false);
    assert.match(result.error, /cannot verify the retry details.*Manage Existing Zones/);
    assert.equal(created.length, before);
    assert.equal(activated.length, beforeActivations);
    assert.equal(scene.regions.get(original.regionId), region, "Existing zones remain intact");
    assert.equal(state.creationFingerprint, fingerprint, "Never infer or backfill an unverified original request");
  });
}

test("a fingerprint is scoped to the creator, allowing different users to use the same operation ID", async () => {
  const request = fingerprintRequest();
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const other = { ...gm, id: "another-gm", name: "Another GM" };
  game.users.set(other.id, other);
  try {
    const fresh = await import(`../scripts/worker.js?creator=${request.operationId}`);
    const otherRequest = { ...request, requesterUserId: other.id };
    const result = await fresh.handleWorkerRequest(otherRequest);
    assert.equal(result.ok, true, result.error);
    assert.notEqual(result.regionId, original.regionId);
    const state = scene.regions.get(result.regionId).getFlag("world", "pf2eZone").state;
    assert.equal(state.createdBy.userId, other.id);
    assert.equal(state.creationFingerprint, creationRequestFingerprint(otherRequest));
    assert.notEqual(state.creationFingerprint, creationRequestFingerprint(request));
  } finally { game.users.delete(other.id); }
});

test("post-refresh creation recovery retains a rolled duration without repeating activation or chat", async () => {
  const priorRoll = globalThis.Roll;
  const priorChat = globalThis.ChatMessage;
  let rolls = 0;
  let announcements = 0;
  globalThis.Roll = class {
    static validate() { return true; }
    async evaluate() { rolls++; return { total: 3 }; }
  };
  globalThis.ChatMessage = { getSpeaker: () => ({}), async create() { announcements++; return { id: "duration-message" }; } };
  try {
    const request = fingerprintRequest();
    request.config.visibility = "all";
    request.config.duration = { type: "custom-rounds", rounds: "1d4" };
    const original = await handleWorkerRequest(request);
    assert.equal(original.ok, true, original.error);
    const before = activated.length;
    const fresh = await import(`../scripts/worker.js?duration=${request.operationId}`);
    const retry = await fresh.handleWorkerRequest(request);
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.regionId, original.regionId);
    assert.deepEqual(retry.duration, { formula: "1d4", rounds: 3 });
    assert.equal(rolls, 1);
    assert.equal(announcements, 1);
    assert.equal(activated.length, before);
  } finally {
    if (priorRoll === undefined) delete globalThis.Roll; else globalThis.Roll = priorRoll;
    if (priorChat === undefined) delete globalThis.ChatMessage; else globalThis.ChatMessage = priorChat;
  }
});

test("creation fingerprint recovery survives an executing-GM handoff for the same requester", async () => {
  const request = fingerprintRequest();
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const before = created.length;
  const otherGM = { ...gm, id: "handoff-gm", name: "Handoff GM" };
  const previousUser = game.user;
  const previousActiveGM = game.users.activeGM;
  game.users.set(otherGM.id, otherGM);
  game.user = otherGM;
  game.users.activeGM = otherGM;
  try {
    const fresh = await import(`../scripts/worker.js?handoff=${request.operationId}`);
    const retry = await fresh.handleWorkerRequest(request);
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.regionId, original.regionId);
    assert.equal(created.length, before);
  } finally {
    game.user = previousUser;
    if (previousActiveGM === undefined) delete game.users.activeGM;
    else game.users.activeGM = previousActiveGM;
    game.users.delete(otherGM.id);
  }
});

test("creation retries compare the original request after the Region is moved or its live configuration changes", async () => {
  const request = fingerprintRequest({ areaCenter: { x: 100, y: 200 } });
  request.config.mode = "area";
  const original = await handleWorkerRequest(request);
  assert.equal(original.ok, true, original.error);
  const region = scene.regions.get(original.regionId);
  const payload = region.getFlag("world", "pf2eZone");
  payload.config.radius += 5;
  payload.state.activationProcessed = true;
  await region.update({ shapes: [{ type: "circle", x: 400, y: 500, radius: 600, gridBased: true }] });
  const before = created.length;
  const beforeActivations = activated.length;
  const fresh = await import(`../scripts/worker.js?edited=${request.operationId}`);
  const retry = await fresh.handleWorkerRequest(request);
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.regionId, original.regionId);
  assert.equal(payload.state.creationFingerprint, creationRequestFingerprint(request));
  assert.equal(region.shapes[0].toObject().x, 400, "A retry must not undo a later move");
  assert.equal(payload.config.radius, request.config.radius + 5);
  assert.equal(created.length, before);
  assert.equal(activated.length, beforeActivations);
  const changed = await rejectedCreation(fresh.handleWorkerRequest, { ...request, config: payload.config });
  assert.equal(changed.ok, false);
  assert.match(changed.error, /reused with different zone details/);
});
