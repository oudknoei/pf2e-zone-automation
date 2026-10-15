import assert from "node:assert/strict";
import { VERSION as RUNTIME_VERSION } from "../scripts/runtime-constants.js";
import test from "node:test";
import { WORKER_ACTION_POLICY, getWorkerActionPolicy } from "../scripts/worker-action-policy.js";

const sent = [];
let listener;
const gm = { id: "gm", name: "GM", isGM: true, active: true };
const player = { id: "player", name: "Player", isGM: false, active: true };
const users = new Map([[gm.id, gm], [player.id, player]]);
users.activeGM = gm;
let randomId = 0;
globalThis.foundry = { utils: { randomID: () => `request-${String(++randomId).padStart(12, "0")}` } };
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
const { requestShieldingTaunt } = await import("../scripts/shielding-taunt.js");
const { setHeroPoints } = await import("../scripts/hero-points.js");
const { createHeroPointReminder } = await import("../scripts/hero-point-reminders.js");
registerZoneSocket();

test("every shared worker action routes a secondary GM to the active GM using the centralized policy", async () => {
  const otherGM = { id: "policy-other-gm", name: "Other GM", isGM: true, active: true };
  users.set(otherGM.id, otherGM);
  const actions = ["library-list", "library-save", "library-delete", "cancel-pending-save",
    "shielding-taunt", "ask-question", "set-hero-points", "create-hero-point-reminder", "clear-hero-point-reminders"];
  try {
    game.user = otherGM;
    for (const action of actions) {
      assert.equal(getWorkerActionPolicy(action).authority, "active-gm");
      const result = requestGMWorker({ protocol: 1, action, requesterUserId: otherGM.id });
      const outgoing = sent.shift();
      assert.equal(outgoing.kind, "request");
      assert.equal(outgoing.gmId, gm.id);
      assert.equal(outgoing.request.action, action);
      await listener({ kind: "response", id: outgoing.id, gmId: gm.id,
        recipientUserId: otherGM.id, response: { ok: true, action } }, gm.id);
      assert.deepEqual(await result, { ok: true, action });
    }
    assert.equal(sent.length, 0);
  } finally {
    users.delete(otherGM.id);
    game.user = player;
  }
});

test("secondary GMs retain direct zone operations and ping when the socket is unavailable", async () => {
  const previous = { user: game.user, scenes: game.scenes, fromUuid: globalThis.fromUuid, error: console.error };
  const otherGM = { id: "policy-direct-gm", name: "Other GM", isGM: true, active: true };
  users.set(otherGM.id, otherGM);
  game.user = otherGM;
  game.scenes = new Map();
  game.socket.connected = false;
  console.error = () => {};
  try {
    for (const action of ["create", "move", "end", "ping"]) {
      assert.equal(getWorkerActionPolicy(action).authority, "gm");
      const result = await requestGMWorker({ protocol: 1, action, requesterUserId: otherGM.id });
      if (action === "ping") assert.equal(result.ok, true);
      else {
        assert.equal(result.ok, false);
        assert.match(result.error, /Scene was not found|no longer exists/);
      }
      assert.equal(sent.length, 0);
    }
  } finally {
    users.delete(otherGM.id);
    game.user = previous.user;
    game.scenes = previous.scenes;
    globalThis.fromUuid = previous.fromUuid;
    console.error = previous.error;
    game.socket.connected = true;
  }
});

test("all policy handlers dispatch locally for the active GM and preserve the no-active-GM fallback", async () => {
  const previous = { user: game.user, error: console.error };
  game.user = gm;
  game.socket.connected = false;
  console.error = () => {};
  try {
    for (const activeGM of [gm, null]) {
      users.activeGM = activeGM;
      for (const action of Object.keys(WORKER_ACTION_POLICY)) {
        // A missing requester stops each privileged handler before any document lookup or write.
        const result = await requestGMWorker({ protocol: 1, action, requesterUserId: "missing-user",
          question: "What is it?", operationId: "PolicyDispatch0001" });
        if (action === "ping") assert.equal(result.ok, true);
        else {
          assert.equal(result.ok, false);
          assert.match(result.error, /requesting user|active GM|active user/i, action);
        }
        assert.equal(sent.length, 0);
      }
    }
  } finally {
    users.activeGM = gm;
    game.user = previous.user;
    console.error = previous.error;
    game.socket.connected = true;
  }
});

test("action policy is immutable and inherited or unknown action names cannot invoke a worker handler", async () => {
  const previousUser = game.user;
  game.user = gm;
  try {
    assert.ok(Object.isFrozen(WORKER_ACTION_POLICY));
    assert.ok(Object.values(WORKER_ACTION_POLICY).every(Object.isFrozen));
    assert.throws(() => { WORKER_ACTION_POLICY.ping.authority = "active-gm"; }, TypeError);
    for (const action of ["constructor", "__proto__", "toString", "unknown", undefined, 1]) {
      assert.equal(getWorkerActionPolicy(action), null);
      const response = await requestGMWorker({ protocol: 1, action, requesterUserId: gm.id });
      assert.equal(response.ok, false);
      assert.match(response.error, /Unsupported worker action/);
      assert.equal(sent.length, 0);
    }
  } finally { game.user = previousUser; }
});

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

test("a secondary GM routes Recall Knowledge questions to the authoritative GM", async () => {
  const otherGM = { id: "other-gm", name: "Other GM", isGM: true, active: true };
  users.set(otherGM.id, otherGM);
  try {
    game.user = otherGM;
    const resultPromise = requestGMWorker({
      protocol: 1, action: "ask-question", requesterUserId: otherGM.id,
      sourceTokenUuid: "Scene.scene.Token.source", targetTokenUuid: "Scene.scene.Token.target",
      question: "What is it?", loreSlug: null, operationId: "question00000001"
    });
    const request = sent.shift();
    assert.equal(request.kind, "request");
    assert.equal(request.gmId, gm.id);
    assert.equal(request.request.action, "ask-question");
    await listener({
      kind: "response", id: request.id, gmId: gm.id,
      recipientUserId: otherGM.id, response: { ok: true, action: "ask-question", messageId: "private-message" }
    }, gm.id);
    assert.deepEqual(await resultPromise, { ok: true, action: "ask-question", messageId: "private-message" });
  } finally {
    users.delete(otherGM.id);
    game.user = player;
  }
});

test("two GM clients award through one authoritative Actor queue with authenticated request identities", async () => {
  const otherGM = { id: "hero-other-gm", name: "Other GM", isGM: true, active: true };
  users.set(otherGM.id, otherGM);
  const originalActors = game.actors;
  const originalChatMessage = globalThis.ChatMessage;
  const originalIterator = users[Symbol.iterator];
  const announcements = [];
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const actor = {
    id: "two-gm-hero", name: "Hero", type: "character", hasPlayerOwner: true, flags: {},
    system: { resources: { heroPoints: { value: 0, max: 3 } } },
    async update(data) {
      await gate;
      writes.push(data);
      this.system.resources.heroPoints.value = data["system.resources.heroPoints.value"];
      this.flags["pf2e-zone-automation"] = { heroPointOperation: data["flags.pf2e-zone-automation.heroPointOperation"] };
    }
  };
  game.actors = [actor];
  game.actors.get = (id) => id === actor.id ? actor : null;
  // Foundry Collections iterate their document values, unlike a plain Map.
  users[Symbol.iterator] = users.values;
  globalThis.ChatMessage = { create: async (data) => { announcements.push(data); } };
  try {
    game.user = otherGM;
    const secondaryAward = setHeroPoints(1, actor);
    const request = sent.shift();
    assert.equal(request.gmId, gm.id);
    assert.equal(request.request.action, "set-hero-points");
    assert.equal(request.request.requesterUserId, otherGM.id);
    game.user = gm;
    const secondaryProcessing = listener(request, otherGM.id);
    const primaryAward = setHeroPoints(1, actor);
    await new Promise(setImmediate);
    assert.equal(writes.length, 0);
    release();
    await Promise.all([secondaryProcessing, primaryAward]);
    const reply = sent.shift();
    assert.equal(reply.response.ok, true);
    game.user = otherGM;
    await listener(reply, gm.id);
    const secondaryResult = await secondaryAward;
    assert.equal(actor.system.resources.heroPoints.value, 2);
    assert.deepEqual(writes.map((data) => data["system.resources.heroPoints.value"]), [1, 2]);
    assert.equal(secondaryResult[0].before, 0);
    assert.deepEqual(announcements.map((data) => data.author), [otherGM.id, gm.id]);
    assert.ok(announcements.every((data) => data.whisper.includes(gm.id) && data.whisper.includes(otherGM.id)));
  } finally {
    release();
    users[Symbol.iterator] = originalIterator;
    users.delete(otherGM.id);
    game.actors = originalActors;
    globalThis.ChatMessage = originalChatMessage;
    game.user = player;
  }
});

test("the authenticated worker rejects a player's Hero Point mutation of an unowned character", async () => {
  const previousActors = game.actors;
  const actor = { id: "any-actor", type: "character", hasPlayerOwner: true, testUserPermission: () => false };
  game.actors = { get: id => id === actor.id ? actor : null };
  game.user = player;
  const pendingChange = requestGMWorker({
    protocol: 1, action: "set-hero-points", requesterUserId: player.id,
    actorIds: ["any-actor"], amount: 1, mode: "add", operationId: "PlayerHeroOp00001"
  });
  const request = sent.shift();
  game.user = gm;
  const originalError = console.error;
  console.error = () => {};
  try { await listener(request, player.id); } finally { console.error = originalError; }
  const reply = sent.shift();
  game.user = player;
  await listener(reply, gm.id);
  const result = await pendingChange;
  assert.equal(result.ok, false);
  assert.match(result.error, /characters you own/);
  game.actors = previousActors;
});

test("a secondary GM routes save cancellation to the authoritative GM", async () => {
  const otherGM = { id: "other-gm", name: "Other GM", isGM: true, active: true };
  users.set(otherGM.id, otherGM);
  try {
    game.user = otherGM;
    const resultPromise = requestGMWorker({
      protocol: 1, action: "cancel-pending-save", requesterUserId: otherGM.id,
      sceneId: "scene", regionId: "zone", pendingId: "pending", identifier: "save-id"
    });
    const request = sent.shift();
    assert.equal(request.kind, "request");
    assert.equal(request.gmId, gm.id);
    assert.equal(request.request.action, "cancel-pending-save");

    await listener({
      kind: "response", id: request.id, gmId: gm.id,
      recipientUserId: otherGM.id, response: { ok: true, status: "cancelled" }
    }, gm.id);
    assert.equal((await resultPromise).status, "cancelled");
  } finally {
    users.delete(otherGM.id);
    game.user = player;
  }
});

test("concurrent reminder requests from a secondary GM share one authenticated active-GM save", async () => {
  const otherGM = {
    id: "reminder-other-gm", isGM: true, active: true,
    flags: { "pf2e-zone-automation": { heroPointReminders: {} } }
  };
  users.set(otherGM.id, otherGM);
  let release;
  let markStarted;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  let writes = 0;
  otherGM.update = async data => {
    writes++;
    markStarted();
    await blocked;
    for (const [path, record] of Object.entries(data)) otherGM.flags["pf2e-zone-automation"].heroPointReminders[path.split(".").at(-1)] = record;
  };
  try {
    game.user = otherGM;
    const first = createHeroPointReminder("20:00");
    const second = createHeroPointReminder("20:00");
    const requests = [sent.shift(), sent.shift()];
    assert.ok(requests.every(request => request.gmId === gm.id && request.request.action === "create-hero-point-reminder"));
    assert.ok(requests.every(request => request.request.requesterUserId === otherGM.id));
    assert.equal(requests[0].request.remindAt, requests[1].request.remindAt, "The sender supplies an absolute timestamp");
    game.user = gm;
    const processing = Promise.all(requests.map(request => listener(request, otherGM.id)));
    await started;
    assert.equal(writes, 1);
    release();
    await processing;
    const replies = [sent.shift(), sent.shift()];
    assert.ok(replies.every(reply => reply.recipientUserId === otherGM.id && reply.response.ok));
    game.user = otherGM;
    for (const reply of replies) await listener(reply, gm.id);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.recipientUserId, otherGM.id);
    assert.equal(Object.keys(otherGM.flags["pf2e-zone-automation"].heroPointReminders).length, 1);
  } finally {
    release();
    users.delete(otherGM.id);
    game.user = player;
  }
});

test("an authenticated player reminder is saved on the player rather than the active GM", async () => {
  const previous = { flags: player.flags, update: player.update };
  player.flags = {};
  player.update = async data => {
    const [path, record] = Object.entries(data)[0];
    player.flags["pf2e-zone-automation"] ??= { heroPointReminders: {} };
    player.flags["pf2e-zone-automation"].heroPointReminders[path.split(".").at(-1)] = record;
  };
  game.user = player;
  const creating = requestGMWorker({ protocol: 1, action: "create-hero-point-reminder", requesterUserId: player.id, remindAt: Date.now() + 60000 });
  const request = sent.shift();
  game.user = gm;
  const previousError = console.error;
  console.error = () => {};
  try { await listener(request, player.id); } finally { console.error = previousError; }
  const reply = sent.shift();
  game.user = player;
  await listener(reply, gm.id);
  const result = await creating;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.reminder.recipientUserId, player.id);
  assert.ok(player.flags["pf2e-zone-automation"].heroPointReminders[result.reminder.id]);
  player.flags = previous.flags;
  player.update = previous.update;
});

test("Shielding Taunt sends one operation ID for concurrent client retries", async () => {
  game.user = player;
  const sourceTokenUuid = "Scene.scene.Token.guardian";
  const targetTokenUuid = "Scene.scene.Token.target";
  const first = requestShieldingTaunt(sourceTokenUuid, targetTokenUuid);
  const second = requestShieldingTaunt(sourceTokenUuid, targetTokenUuid);
  assert.equal(sent.length, 1);
  const request = sent.shift();
  assert.equal(request.request.action, "shielding-taunt");
  assert.match(request.request.operationId, /^[a-zA-Z0-9_-]{12,64}$/);

  await listener({
    kind: "response", id: request.id, gmId: gm.id,
    recipientUserId: player.id,
    response: { ok: true, action: "shielding-taunt", mechanicalSuccess: true, warnings: [] }
  }, gm.id);
  assert.equal((await first).mechanicalSuccess, true);
  assert.equal((await second).mechanicalSuccess, true);

  const failed = requestShieldingTaunt(sourceTokenUuid, targetTokenUuid);
  const failedRequest = sent.shift();
  await listener({
    kind: "response", id: failedRequest.id, gmId: gm.id,
    recipientUserId: player.id,
    response: {
      ok: false,
      error: "Cleanup is incomplete.",
      errorCode: "PF2E_ZONE_TAUNT_CLEANUP_INCOMPLETE",
      retryable: true
    }
  }, gm.id);
  await assert.rejects(failed, /Cleanup is incomplete/);

  const retry = requestShieldingTaunt(sourceTokenUuid, targetTokenUuid);
  const retryRequest = sent.shift();
  assert.equal(retryRequest.request.operationId, failedRequest.request.operationId);
  await listener({
    kind: "response", id: retryRequest.id, gmId: gm.id,
    recipientUserId: player.id,
    response: { ok: true, action: "shielding-taunt", mechanicalSuccess: true, warnings: [] }
  }, gm.id);
  assert.equal((await retry).mechanicalSuccess, true);
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
      version: RUNTIME_VERSION,
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
