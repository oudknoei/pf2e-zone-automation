import assert from "node:assert/strict";
import test from "node:test";

import { handleWorkerRequest } from "../scripts/worker.js";
import { normalizeConfig } from "../scripts/zone-config.js";
import { savedPresetFromZone } from "../scripts/zone-creation.js";

test("player zones retain their saved preset revision and reject stale overwrites", async () => {
  const priorClamp = Math.clamp;
  const gm = { id: "gm", name: "GM", active: true, isGM: true, color: "#336699" };
  const player = { id: "player", name: "Player", active: true, isGM: false, color: "#336699" };
  const config = {
    name: "Original Zone",
    mode: "emanation",
    radius: 5,
    targeting: { affects: "enemies", includeSelf: false },
    visibility: "all",
    duration: { type: "unlimited", rounds: 1 },
    effects: [{ id: "alert-block", name: "Alert", triggers: { activation: true }, chatAlert: { enabled: true, text: "Alert" } }]
  };
  const record = {
    id: "saved-zone",
    name: config.name,
    createdBy: { userId: player.id, name: player.name },
    revision: 1,
    config
  };
  const folder = { id: "zone-folder", name: "PF2e Zone Automation", type: "JournalEntry", getFlag: () => false };
  const page = {
    id: "index",
    getFlag: (_scope, key) => key === "pf2eZoneLibraryIndex",
    async update() {}
  };
  const journal = {
    id: "library",
    folder: folder.id,
    flags: { world: { pf2eZoneLibrary: { zones: { [record.id]: record } } } },
    pages: [page],
    getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
    async update(changes) {
      const replacement = changes["flags.world.pf2eZoneLibrary"];
      this.flags.world.pf2eZoneLibrary = structuredClone(replacement.value);
    }
  };
  let createdData = null;
  let creations = 0;
  let endedRegion = null;
  const scene = { id: "scene", regions: { get: (id) => id === "region" ? region : null } };
  const sourceActor = {
    uuid: "Actor.source",
    testUserPermission: (user, level) => user === player && level === "OWNER"
  };
  const sourceToken = {
    uuid: "Scene.scene.Token.source",
    documentName: "Token",
    parent: scene,
    actor: sourceActor
  };
  const region = {
    id: "region",
    uuid: "Scene.scene.Region.region",
    parent: scene,
    getFlag(scope, key) { return createdData?.flags?.[scope]?.[key]; }
  };

  try {
    Math.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    globalThis.foundry = { utils: {} };
    globalThis._replace = (value) => ({ value });
    globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 2 } };
    globalThis.CONFIG = {
      Region: {
        documentClass: {
          async createTokenEmanation(_token, _radius, data) {
            creations += 1;
            createdData = data;
            return region;
          }
        }
      }
    };
    globalThis.game = {
      system: { id: "pf2e" },
      user: gm,
      users: new Map([[gm.id, gm], [player.id, player]]),
      scenes: { get: (id) => id === scene.id ? scene : null },
      folders: [folder],
      journal: [journal],
      time: { worldTime: 0 },
      combat: null
    };
    globalThis.fromUuid = async (uuid) => ({
      [sourceToken.uuid]: sourceToken,
      [sourceActor.uuid]: sourceActor
    })[uuid] ?? null;
    globalThis.PF2EZoneRuntime = {
      version: "0.5.16",
      installHooks() {},
      async activateRegion() {},
      async endZone(target) { endedRegion = target; }
    };

    const request = {
      protocol: 1,
      action: "create",
      requesterUserId: player.id,
      sceneId: scene.id,
      sourceTokenUuid: sourceToken.uuid,
      config,
      savedPresetId: record.id,
      savedPresetRevision: record.revision
    };
    const created = await handleWorkerRequest(request);
    assert.equal(created.ok, true, created.error);
    assert.equal(createdData.flags.world.pf2eZone.state.savedPresetId, record.id);
    assert.equal(createdData.flags.world.pf2eZone.state.savedPresetRevision, 1);
    assert.deepEqual(createdData.flags.world.pf2eZone.config, normalizeConfig(config, { strict: true }));

    const newer = await handleWorkerRequest({
      protocol: 1, action: "library-save", requesterUserId: player.id,
      recordId: record.id, expectedRevision: 1, sourceActorUuid: sourceActor.uuid,
      config: { ...config, name: "Newer preset" }
    });
    assert.equal(newer.ok, true, newer.error);
    assert.equal(newer.record.revision, 2);

    const zoneState = createdData.flags.world.pf2eZone.state;
    const reopened = savedPresetFromZone(newer.record, zoneState);
    assert.equal(reopened.revision, 1, "the dismissed zone keeps its creation revision");
    assert.equal(newer.record.revision, 2, "restoring the old revision does not mutate the library record");
    assert.equal(savedPresetFromZone(newer.record, { savedPresetId: record.id }).revision, null,
      "zones created before revision tracking must not inherit the current revision");
    assert.equal(savedPresetFromZone(null, zoneState), null);

    const dismissed = await handleWorkerRequest({
      protocol: 1,
      action: "end",
      requesterUserId: player.id,
      sceneId: scene.id,
      regionId: region.id
    });
    assert.equal(dismissed.ok, true, dismissed.error);
    assert.equal(endedRegion, region);

    const previousError = console.error;
    let stale;
    try {
      console.error = () => {};
      stale = await handleWorkerRequest({
        protocol: 1, action: "library-save", requesterUserId: player.id,
        recordId: reopened.id, expectedRevision: reopened.revision,
        sourceActorUuid: sourceActor.uuid, config: { ...config, name: "Old zone edits" }
      });
    } finally {
      console.error = previousError;
    }
    assert.equal(stale.ok, false);
    assert.match(stale.error, /changed since you opened it/);
    assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones[record.id].name, "Newer preset");

    const saved = await handleWorkerRequest({
      protocol: 1,
      action: "library-save",
      requesterUserId: player.id,
      recordId: createdData.flags.world.pf2eZone.state.savedPresetId,
      expectedRevision: newer.record.revision,
      sourceActorUuid: sourceActor.uuid,
      config: { ...config, name: "Revised Zone" }
    });
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.record.id, record.id);
    assert.equal(saved.record.revision, 3);
    assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones[record.id].name, "Revised Zone");

    const priorError = console.error;
    let invalid;
    try {
      console.error = () => {};
      invalid = await handleWorkerRequest({ ...request, savedPresetId: "missing-zone" });
    } finally {
      console.error = priorError;
    }
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /no longer exists/);
    assert.equal(creations, 1);

    let emptyTargets;
    const priorTargetError = console.error;
    try {
      console.error = () => {};
      emptyTargets = await handleWorkerRequest({
        ...request,
        config: { ...config, targeting: { affects: "none", includeSelf: false } }
      });
    } finally {
      console.error = priorTargetError;
    }
    assert.equal(emptyTargets.ok, false);
    assert.match(emptyTargets.error, /Select at least one target/);

    globalThis.CONFIG.Dice = { rolls: [class DamageRoll {
      static validate(formula) { return !formula.includes("2d6+"); }
    }] };
    let invalidDamage;
    const priorFormulaError = console.error;
    try {
      console.error = () => {};
      invalidDamage = await handleWorkerRequest({
        ...request,
        config: {
          ...config,
          effects: [{
            name: "Invalid Damage",
            triggers: { activation: true },
            damage: { enabled: true, formula: "2d6+", typeMode: "fixed", type: "fire" }
          }]
        }
      });
    } finally {
      console.error = priorFormulaError;
    }
    assert.equal(invalidDamage.ok, false);
    assert.match(invalidDamage.error, /PF2e does not recognize this formula/);

    globalThis.Roll = class {
      static validate(formula) { return formula !== "2d4 +"; }
    };
    let invalidDuration;
    const priorDurationError = console.error;
    try {
      console.error = () => {};
      invalidDuration = await handleWorkerRequest({
        ...request,
        config: { ...config, duration: { type: "custom-rounds", rounds: "2d4 +" } }
      });
    } finally {
      console.error = priorDurationError;
    }
    assert.equal(invalidDuration.ok, false);
    assert.match(invalidDuration.error, /Foundry does not recognize this duration formula/);
    assert.equal(creations, 1);

    scene.dimensions = { distancePixels: 10 };
    scene.createEmbeddedDocuments = async (_type, data) => {
      createdData = data[0];
      return [region];
    };
    const square = await handleWorkerRequest({
      ...request,
      savedPresetId: null,
      config: { ...config, mode: "area", areaShape: "square", sideLength: 10 },
      areaCenter: { x: 250, y: 350 }
    });
    assert.equal(square.ok, true, square.error);
    assert.deepEqual(createdData.shapes, [{
      type: "rectangle", x: 200, y: 300, width: 100, height: 100,
      rotation: 0, gridBased: true
    }]);
  } finally {
    if (priorClamp === undefined) delete Math.clamp;
    else Math.clamp = priorClamp;
  }
});