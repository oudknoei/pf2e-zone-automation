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
