import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const hooks = new Map();
globalThis.Hooks = {
  once(name, handler) { hooks.set(name, handler); },
  on(name, handler) { hooks.set(name, handler); }
};
globalThis.foundry = { utils: {} };
const module = {};
globalThis.game = {
  modules: { get: (id) => id === "pf2e-zone-automation" ? module : null },
  system: { id: "pf2e" },
  user: { id: "gm", isGM: true }
};

const { handleWorkerRequest } = await import("../scripts/worker.js");
await import("../scripts/main.js");

test("manifest points to files that ship", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "module.json"), "utf8"));
  assert.equal(manifest.id, "pf2e-zone-automation");
  assert.equal(manifest.author, "m.mestemaker");
  assert.deepEqual(manifest.authors, [{ name: "m.mestemaker" }]);
  assert.deepEqual(manifest.relationships.systems, [{
    id: "pf2e",
    type: "system",
    manifest: "https://github.com/foundryvtt/pf2e/releases/latest/download/system.json",
    compatibility: { minimum: "8.5.1" }
  }]);
  assert.equal(manifest.socket, true);
  assert.ok(manifest.packs.every((pack) => pack.system === "pf2e"));
  assert.deepEqual(
    new Set(manifest.relationships.requires.map(({ id }) => id)),
    new Set(["advanced-macros", "pf2e-flatcheck-helper", "lib-wrapper"])
  );
  for (const file of [...manifest.esmodules, ...manifest.styles]) {
    assert.ok(existsSync(resolve(root, file)), `${file} is missing`);
  }
  const forbiddenMacroReferences = [/game\.macros\b/, /\bGM_WORKER_NAME\b/, /\bpf2eZoneWorkerRequest\b/];
  for (const script of readdirSync(resolve(root, "scripts")).filter((file) => file.endsWith(".js"))) {
    const source = readFileSync(resolve(root, "scripts", script), "utf8");
    for (const reference of forbiddenMacroReferences) {
      assert.doesNotMatch(source, reference, `scripts/${script} retains a macro-only reference`);
    }
  }
});

test("Foundry hooks expose the builder and add its Token control", () => {
  hooks.get("init")();
  assert.equal(typeof module.api.openBuilder, "function");
  assert.equal(typeof module.api.openShieldingTaunt, "function");
  assert.equal(typeof module.api.requestShieldingTaunt, "function");
  assert.equal(typeof module.api.handleRegionEvent, "function");
  const controls = { tokens: { tools: { select: {} } } };
  hooks.get("getSceneControlButtons")(controls);
  assert.equal(controls.tokens.tools.pf2eZoneBuilder.button, true);
  assert.equal(controls.tokens.tools.pf2eZoneBuilder.visible, true);
});

test("a source owner can dismiss a zone regardless of its retired dismissal flag", async () => {
  const prior = {
    user: game.user,
    users: game.users,
    scenes: game.scenes,
    fromUuid: globalThis.fromUuid,
    runtime: globalThis.PF2EZoneRuntime
  };
  const requester = { id: "player", name: "Player", active: true, isGM: false };
  const sourceActor = { testUserPermission: (user, level) => user === requester && level === "OWNER" };
  const scene = { id: "scene", regions: { get: (id) => id === "zone" ? region : null } };
  const region = {
    id: "zone",
    parent: scene,
    getFlag: () => ({
      config: { duration: { type: "unlimited", dismissible: false } },
      state: { sourceActorUuid: "Actor.source" }
    })
  };
  let ended = null;

  try {
    game.user = { id: "gm", isGM: true };
    game.users = { get: (id) => id === requester.id ? requester : null };
    game.scenes = { get: (id) => id === scene.id ? scene : null };
    globalThis.fromUuid = async (uuid) => uuid === "Actor.source" ? sourceActor : null;
    globalThis.PF2EZoneRuntime = {
      version: "0.5.16",
      installHooks: () => undefined,
      endZone: async (target, reason) => { ended = { target, reason }; }
    };

    const result = await handleWorkerRequest({
      protocol: 1,
      action: "end",
      requesterUserId: requester.id,
      sceneId: scene.id,
      regionId: region.id
    });

    assert.equal(result.ok, true);
    assert.equal(ended?.target, region);
  } finally {
    game.user = prior.user;
    game.users = prior.users;
    game.scenes = prior.scenes;
    if (prior.fromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = prior.fromUuid;
    if (prior.runtime === undefined) delete globalThis.PF2EZoneRuntime;
    else globalThis.PF2EZoneRuntime = prior.runtime;
  }
});

test("worker rejects non-GM execution and dispatches GM requests", async () => {
  const request = { protocol: 1, action: "ping", requesterUserId: "gm" };
  game.user.isGM = false;
  const denied = await handleWorkerRequest(request);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /active GM client/);

  game.user.isGM = true;
  assert.deepEqual((await handleWorkerRequest(request)).action, "ping");
  const unknown = await handleWorkerRequest({ ...request, action: "unknown" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unsupported worker action/);
});
