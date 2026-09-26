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
  const region = { id, uuid: `Scene.scene.Region.${id}`, parent: scene, getFlag: (scope, key) => data.flags?.[scope]?.[key] };
  created.push({ data, region });
  return region;
}

Math.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
globalThis.foundry = { utils: { randomID: () => "generated" } };
globalThis.CONST = {
  REGION_VISIBILITY: { ALWAYS: 2, OBSERVER: 3 },
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2 }
};
globalThis.CONFIG = {
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
  version: "0.5.16", installHooks() {},
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
