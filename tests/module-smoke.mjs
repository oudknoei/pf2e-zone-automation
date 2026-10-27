import assert from "node:assert/strict";
import { VERSION as RUNTIME_VERSION } from "../scripts/runtime-constants.js";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const hooks = new Map();
globalThis.Hooks = {
  once(name, handler) { hooks.set(name, handler); },
  on(name, handler) { hooks.set(name, handler); }
};
globalThis.foundry = { utils: {}, applications: { api: { DialogV2: class {} } } };
const module = {};
const settings = new Map();
const settingValues = new Map();
const wrappers = new Map();
globalThis.libWrapper = {
  register(_namespace, target, wrapper) { wrappers.set(target, wrapper); }
};
globalThis.game = {
  modules: { get: (id) => id === "pf2e-zone-automation" ? module : null },
  settings: {
    register: (namespace, key, config) => settings.set(`${namespace}.${key}`, config),
    registerMenu: (namespace, key, config) => settings.set(`${namespace}.${key}`, config),
    get: (namespace, key) => settingValues.get(`${namespace}.${key}`) ?? settings.get(`${namespace}.${key}`)?.default
  },
  pf2e: {
    Modifier: class { constructor(data) { Object.assign(this, data); } },
    settings: { variants: { abp: "ABPRulesAsWritten" } },
    variantRules: {
      AutomaticBonusProgression: {
        concatModifiers() {},
        isEnabled: (actor) => game.pf2e.settings.variants.abp !== "noABP" && !actor.flags.pf2e.disableABP,
        getAttackPotency: (level) => level < 2 ? 0 : level < 10 ? 1 : level < 16 ? 2 : 3
      }
    }
  },
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
  assert.equal(settings.get("pf2e-zone-automation.abpSpellAttacks")?.default, false);
  assert.equal(typeof module.api.openBuilder, "function");
  assert.equal(typeof module.api.openShieldingTaunt, "function");
  assert.equal(typeof module.api.requestShieldingTaunt, "function");
  assert.equal(typeof module.api.handleRegionEvent, "function");
  assert.equal(typeof module.api.setHeroPoints, "function");
  assert.equal(typeof module.api.promptSetHeroPoints, "function");
  assert.equal(typeof module.api.createHeroPointReminder, "function");
  assert.equal(typeof module.api.openSessionNotes, "function");
  assert.equal(typeof module.api.openQuickNote, "function");
  assert.equal(settings.get("pf2e-zone-automation.sessionRecapPrompt").scope, "world");
  assert.equal(settings.get("pf2e-zone-automation.sessionRecapPromptEditor").restricted, true);
  assert.equal(typeof hooks.get("renderChatMessageHTML"), "function", "Reminder buttons must be registered before chat history renders");
  assert.equal(typeof hooks.get("renderChatLog"), "function", "Session Notes shortcuts must be registered before the chat sidebar renders");
  assert.equal(typeof hooks.get("renderChatInput"), "function", "Session Notes shortcuts must follow Foundry's separately rendered chat input");
  const controls = { tokens: { tools: { select: {} } } };
  hooks.get("getSceneControlButtons")(controls);
  assert.equal(controls.tokens.tools.pf2eZoneBuilder.button, true);
  assert.equal(controls.tokens.tools.pf2eZoneBuilder.visible, true);
});

test("ABP spell attacks work on the first character preparation, before the setup hook", () => {
  // Foundry v14 initializes world Documents between init and setup. Do not fire setup here.
  const wrapper = wrappers.get("game.pf2e.variantRules.AutomaticBonusProgression.concatModifiers");
  assert.equal(typeof wrapper, "function", "The ABP wrapper must already be installed by init");
  settingValues.set("pf2e-zone-automation.abpSpellAttacks", true);
  for (const mode of ["ABPRulesAsWritten", "ABPFundamentalPotency", "noABP"]) {
    game.pf2e.settings.variants.abp = mode;
    const actor = { type: "character", level: 10, flags: { pf2e: {} }, synthetics: { modifiers: {} } };
    wrapper(() => {}, actor);
    const bonuses = (actor.synthetics.modifiers["spell-attack-roll"] ?? []).map((factory) => factory());
    assert.equal(18 + bonuses.reduce((total, modifier) => total + modifier.modifier, 0), mode === "noABP" ? 18 : 20,
      `Initial preparation must apply spell attack potency only with ABP enabled (${mode})`);
    assert.equal(actor.synthetics.modifiers["spell-dc"], undefined, "The spell DC must remain 28");
  }
  game.pf2e.settings.variants.abp = "ABPRulesAsWritten";
  settingValues.clear();
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
      version: RUNTIME_VERSION,
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

test("a source owner can move a fixed area but an unowned request is rejected", async () => {
  const prior = {
    user: game.user,
    users: game.users,
    scenes: game.scenes,
    fromUuid: globalThis.fromUuid
  };
  const requester = { id: "player", name: "Player", active: true, isGM: false };
  let ownsSource = true;
  const sourceActor = {
    testUserPermission: (user, level) => ownsSource && user === requester && level === "OWNER"
  };
  let shape = { type: "rectangle", x: 0, y: 20, width: 100, height: 60, rotation: 15 };
  const scene = { id: "scene", regions: { get: (id) => id === "zone" ? region : null } };
  const region = {
    id: "zone",
    parent: scene,
    get shapes() { return [{ toObject: () => ({ ...shape }) }]; },
    getFlag: () => ({
      config: { mode: "area", areaShape: "square", sideLength: 10 },
      state: { sourceActorUuid: "Actor.source" }
    }),
    async update(changes) { [shape] = changes.shapes; }
  };

  try {
    game.user = { id: "gm", isGM: true };
    game.users = { get: (id) => id === requester.id ? requester : null };
    game.scenes = { get: (id) => id === scene.id ? scene : null };
    globalThis.fromUuid = async (uuid) => uuid === "Actor.source" ? sourceActor : null;

    const moved = await handleWorkerRequest({
      protocol: 1,
      action: "move",
      requesterUserId: requester.id,
      sceneId: scene.id,
      regionId: region.id,
      areaCenter: { x: 300, y: 250 }
    });
    assert.equal(moved.ok, true, moved.error);
    assert.deepEqual(shape, {
      type: "rectangle", x: 250, y: 220, width: 100, height: 60, rotation: 15
    });

    ownsSource = false;
    const previousConsoleError = console.error;
    console.error = () => {};
    try {
      const denied = await handleWorkerRequest({
        protocol: 1,
        action: "move",
        requesterUserId: requester.id,
        sceneId: scene.id,
        regionId: region.id,
        areaCenter: { x: 500, y: 500 }
      });
      assert.equal(denied.ok, false);
      assert.match(denied.error, /do not own the source Actor/);
    } finally {
      console.error = previousConsoleError;
    }
  } finally {
    game.user = prior.user;
    game.users = prior.users;
    game.scenes = prior.scenes;
    if (prior.fromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = prior.fromUuid;
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
