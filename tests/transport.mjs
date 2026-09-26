import assert from "node:assert/strict";
import test from "node:test";

const sent = [];
let listener;
const gm = { id: "gm", name: "GM", isGM: true, active: true };
const player = { id: "player", name: "Player", isGM: false, active: true };
const users = new Map([[gm.id, gm], [player.id, player]]);
users.activeGM = gm;
globalThis.foundry = { utils: { randomID: () => "request-id" } };
globalThis.game = {
  system: { id: "pf2e" },
  user: player,
  users,
  socket: {
    connected: true,
    on(channel, callback) {
      assert.equal(channel, "module.pf2e-zone-automation");
      listener = callback;
    },
    emit(channel, message) {
      assert.equal(channel, "module.pf2e-zone-automation");
      sent.push(message);
    }
  }
};

const { registerZoneSocket, requestGMWorker } = await import("../scripts/transport.js");
registerZoneSocket();

test("player request reaches the module GM Worker without a world macro", async () => {
  game.user = player;
  const resultPromise = requestGMWorker({ protocol: 1, action: "ping", requesterUserId: player.id });
  const request = sent.shift();
  assert.equal(request.kind, "request");
  assert.equal(request.gmId, gm.id);

  game.user = gm;
  await listener(request, player.id);
  const reply = sent.shift();
  assert.equal(reply.kind, "response");
  assert.equal(reply.recipientUserId, player.id);

  game.user = player;
  await listener(reply, gm.id);
  assert.equal((await resultPromise).action, "ping");
});

test("a secondary GM routes shared-library requests to the active GM", async () => {
  const otherGM = { id: "other-gm", name: "Other GM", isGM: true, active: true };
  users.set(otherGM.id, otherGM);
  try {
    game.user = otherGM;
    const resultPromise = requestGMWorker({
      protocol: 1, action: "library-list", requesterUserId: otherGM.id
    });
    const request = sent.shift();
    assert.equal(request.kind, "request");
    assert.equal(request.gmId, gm.id);
    assert.equal(request.request.requesterUserId, otherGM.id);

    await listener({
      kind: "response", id: request.id, gmId: gm.id,
      recipientUserId: otherGM.id, response: { ok: true, action: "library-list", records: [] }
    }, gm.id);
    assert.equal((await resultPromise).ok, true);
  } finally {
    users.delete(otherGM.id);
    game.user = player;
  }
});

test("GM rejects a forged requester id supplied in the socket payload", async () => {
  game.user = player;
  const resultPromise = requestGMWorker({ protocol: 1, action: "ping", requesterUserId: gm.id });
  const request = sent.shift();

  game.user = gm;
  await listener(request, player.id);
  const reply = sent.shift();

  game.user = player;
  await listener(reply, gm.id);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the socket sender/);
});

test("GM Worker rejects a player's request for an unowned source Actor", async () => {
  const scene = { id: "scene" };
  const actor = {
    name: "Unowned Actor",
    testUserPermission: () => false
  };
  game.scenes = { get: (id) => id === scene.id ? scene : null };
  globalThis.fromUuid = async () => ({
    documentName: "Token",
    parent: scene,
    actor
  });

  game.user = player;
  const resultPromise = requestGMWorker({
    protocol: 1,
    action: "create",
    requesterUserId: player.id,
    sceneId: scene.id,
    sourceTokenUuid: "Scene.scene.Token.token",
    config: { name: "Unauthorized", mode: "emanation", radius: 10, effects: [] }
  });
  const request = sent.shift();

  game.user = gm;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await listener(request, player.id);
  } finally {
    console.error = originalConsoleError;
  }
  const reply = sent.shift();

  game.user = player;
  await listener(reply, gm.id);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.error, /does not own the source Actor/);
});

test("GM Worker rejects a player's Shielding Taunt request for an unowned Guardian", async () => {
  const scene = { id: "scene" };
  const actor = {
    name: "Unowned Guardian",
    testUserPermission: () => false
  };
  game.scenes = { get: (id) => id === scene.id ? scene : null };
  globalThis.fromUuid = async () => ({
    documentName: "Token",
    parent: scene,
    actor
  });

  game.user = player;
  const resultPromise = requestGMWorker({
    protocol: 1,
    action: "shielding-taunt",
    requesterUserId: player.id,
    sourceTokenUuid: "Scene.scene.Token.guardian",
    targetTokenUuid: "Scene.scene.Token.target"
  });
  const request = sent.shift();

  game.user = gm;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await listener(request, player.id);
  } finally {
    console.error = originalConsoleError;
  }
  const reply = sent.shift();

  game.user = player;
  await listener(reply, gm.id);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.error, /does not own the source Actor/);
});

test("player request requires an active GM", async () => {
  game.user = player;
  users.activeGM = null;
  await assert.rejects(
    requestGMWorker({ protocol: 1, action: "ping", requesterUserId: player.id }),
    /active GM/
  );
  users.activeGM = gm;
});

test("player creates and dismisses a Region through the authenticated GM socket", async () => {
  const previous = {
    CONFIG: globalThis.CONFIG, CONST: globalThis.CONST,
    runtime: globalThis.PF2EZoneRuntime, fromUuid: globalThis.fromUuid,
    scenes: game.scenes, time: game.time, combat: game.combat,
    clamp: Math.clamp
  };
  const regions = new Map();
  const scene = { id: "player-scene", regions };
  const actor = {
    uuid: "Actor.player-source", name: "Player Source", combatant: null,
    testUserPermission: (user, permission) => user.id === player.id && permission === "OWNER"
  };
  const token = {
    uuid: "Scene.player-scene.Token.source", documentName: "Token",
    parent: scene, actor
  };
  const activated = [];
  const ended = [];
  try {
    Math.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 2 } };
    globalThis.CONFIG = {
      RegionBehavior: { dataModels: {} },
      Region: {
        documentClass: {
          async createTokenEmanation(source, radius, data) {
            assert.equal(source, token);
            assert.equal(radius, 5);
            const region = {
              id: "created-zone", uuid: "Scene.player-scene.Region.created-zone",
              parent: scene, name: data.name,
              getFlag: (scope, key) => data.flags?.[scope]?.[key]
            };
            regions.set(region.id, region);
            return region;
          }
        }
      }
    };
    game.scenes = { get: (id) => id === scene.id ? scene : null };
    game.time = { worldTime: 0 };
    game.combat = null;
    globalThis.fromUuid = async (uuid) =>
      uuid === token.uuid ? token : uuid === actor.uuid ? actor : null;
    globalThis.PF2EZoneRuntime = {
      version: "0.5.16",
      installHooks() {},
      async activateRegion(region) { activated.push(region); },
      async endZone(region) {
        ended.push(region);
        regions.delete(region.id);
      }
    };

    const config = {
      name: "Player-created zone", mode: "emanation", radius: 5,
      targeting: { affects: "enemies", includeSelf: false },
      visibility: "all", duration: { type: "unlimited", rounds: 1 },
      effects: [{
        id: "alert", name: "Alert", triggers: { activation: true },
        chatAlert: { enabled: true, text: "A zone is active." }
      }]
    };

    game.user = player;
    const createPromise = requestGMWorker({
      protocol: 1, action: "create", requesterUserId: player.id,
      sceneId: scene.id, sourceTokenUuid: token.uuid, config
    });
    const createRequest = sent.shift();
    assert.equal(createRequest.kind, "request");
    game.user = gm;
    await listener(createRequest, player.id);
    const createReply = sent.shift();
    game.user = player;
    await listener(createReply, gm.id);
    const created = await createPromise;
    assert.equal(created.ok, true, created.error);
    assert.equal(created.regionId, "created-zone");
    const region = regions.get(created.regionId);
    assert.equal(region.getFlag("world", "pf2eZone").state.createdBy.userId, player.id);
    assert.deepEqual(activated, [region]);

    const endPromise = requestGMWorker({
      protocol: 1, action: "end", requesterUserId: player.id,
      sceneId: scene.id, regionId: region.id
    });
    const endRequest = sent.shift();
    game.user = gm;
    await listener(endRequest, player.id);
    const endReply = sent.shift();
    game.user = player;
    await listener(endReply, gm.id);
    const dismissed = await endPromise;
    assert.equal(dismissed.ok, true, dismissed.error);
    assert.equal(regions.size, 0);
    assert.deepEqual(ended, [region]);
  } finally {
    globalThis.CONFIG = previous.CONFIG;
    globalThis.CONST = previous.CONST;
    globalThis.PF2EZoneRuntime = previous.runtime;
    globalThis.fromUuid = previous.fromUuid;
    game.scenes = previous.scenes;
    game.time = previous.time;
    game.combat = previous.combat;
    Math.clamp = previous.clamp;
    game.user = player;
  }
});
