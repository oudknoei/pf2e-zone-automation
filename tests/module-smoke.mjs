import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { DEFAULT_KNOWLEDGE_PROMPT, KNOWLEDGE_PROMPT_SETTING } from "../scripts/recall-knowledge-prompt.js";
import { DEFAULT_KNOWLEDGE_API_ENDPOINT, DEFAULT_KNOWLEDGE_MODEL, KNOWLEDGE_API_ENDPOINT_SETTING, KNOWLEDGE_MODEL_SETTING } from "../scripts/recall-knowledge-ai-config.js";

const root = resolve(import.meta.dirname, "..");
const hooks = new Map();
globalThis.Hooks = {
  once(name, handler) { hooks.set(name, handler); },
  on(name, handler) { hooks.set(name, handler); }
};
globalThis.foundry = { utils: {}, applications: { api: { DialogV2: class {} } }, data: { fields: { StringField: class {
  constructor(options) { this.options = options; }
  getInitialValue() { return this.options.initial ?? ""; }
} } } };
const module = {};
const settings = new Map();
const menus = new Map();
globalThis.game = {
  modules: { get: (id) => id === "pf2e-zone-automation" ? module : null },
  settings: {
    register: (namespace, key, config) => settings.set(`${namespace}.${key}`, config),
    registerMenu: (namespace, key, config) => menus.set(`${namespace}.${key}`, config),
    get: (namespace, key) => settings.get(`${namespace}.${key}`)?.type?.getInitialValue()
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
  assert.equal(typeof module.api.openBuilder, "function");
  assert.equal(typeof module.api.openShieldingTaunt, "function");
  assert.equal(typeof module.api.requestShieldingTaunt, "function");
  assert.equal(typeof module.api.openAskQuestion, "function");
  assert.equal(typeof module.api.requestAskQuestion, "function");
  assert.equal(typeof module.api.handleRegionEvent, "function");
  assert.equal(typeof module.api.setHeroPoints, "function");
  assert.equal(typeof module.api.promptSetHeroPoints, "function");
  assert.equal(typeof module.api.createHeroPointReminder, "function");
  assert.equal(typeof hooks.get("renderChatMessageHTML"), "function", "Reminder buttons must be registered before chat history renders");
  const controls = { tokens: { tools: { select: {} } } };
  hooks.get("getSceneControlButtons")(controls);
  assert.equal(controls.tokens.tools.pf2eZoneBuilder.button, true);
  assert.equal(controls.tokens.tools.pf2eZoneBuilder.visible, true);
});

test("Recall Knowledge instructions are editable as literal multiline text in world settings", () => {
  const setting = settings.get(`pf2e-zone-automation.${KNOWLEDGE_PROMPT_SETTING}`);
  assert.equal(setting.scope, "world");
  assert.equal(setting.config, true);
  assert.equal(setting.default, DEFAULT_KNOWLEDGE_PROMPT);
  assert.equal(setting.type.options.blank, false);
  const dom = new JSDOM("<form></form>");
  const previousDocument = globalThis.document;
  const previousSettingsGet = game.settings.get;
  globalThis.document = dom.window.document;
  try {
    const name = `pf2e-zone-automation.${KNOWLEDGE_PROMPT_SETTING}`;
    assert.equal(game.settings.get("pf2e-zone-automation", KNOWLEDGE_PROMPT_SETTING), DEFAULT_KNOWLEDGE_PROMPT);
    for (const value of [undefined, null, "", " \n "]) {
      const initial = setting.input(setting.type, { name, value });
      assert.equal(initial.value, DEFAULT_KNOWLEDGE_PROMPT, "Show active default instructions when no saved value is supplied");
    }
    const value = 'Speak as a scholar.\n<script>literal reference</script>\nKeep it short.';
    game.settings.get = () => value;
    assert.equal(setting.input(setting.type, { name }).value, value, "An omitted form value must show the current saved instructions");
    assert.equal(setting.input(setting.type, { name, value: DEFAULT_KNOWLEDGE_PROMPT }).value, DEFAULT_KNOWLEDGE_PROMPT,
      "An explicit form value must take precedence over saved instructions, including when resetting defaults");
    const input = setting.input(setting.type, { name, value, rootId: "settings-config" });
    dom.window.document.querySelector("form").append(input);
    assert.equal(input.tagName, "TEXTAREA");
    assert.equal(input.value, value);
    assert.equal(dom.window.document.querySelector("script"), null);
    assert.equal(new dom.window.FormData(input.form).get(name), value);
    const disabled = setting.input(setting.type, { name, value, disabled: true, readonly: true });
    assert.equal(disabled.disabled, true);
    assert.equal(disabled.readOnly, true);
  } finally {
    game.settings.get = previousSettingsGet;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    dom.window.close();
  }
});

test("AI settings expose the endpoint and model, and restrict key entry to a GM submenu", () => {
  const endpoint = settings.get(`pf2e-zone-automation.${KNOWLEDGE_API_ENDPOINT_SETTING}`);
  const model = settings.get(`pf2e-zone-automation.${KNOWLEDGE_MODEL_SETTING}`);
  assert.equal(endpoint.default, DEFAULT_KNOWLEDGE_API_ENDPOINT);
  assert.equal(endpoint.scope, "world");
  assert.equal(endpoint.type.options.initial, DEFAULT_KNOWLEDGE_API_ENDPOINT);
  assert.equal(model.default, DEFAULT_KNOWLEDGE_MODEL);
  assert.equal(model.scope, "world");
  assert.equal(menus.get("pf2e-zone-automation.recallKnowledgeAIConnection").restricted, true);
  assert.deepEqual([...settings.keys()].filter((key) => /api.?key|token|credential/i.test(key)), []);
  assert.equal(module.api.setKnowledgeApiKey, undefined);
  assert.equal(module.api.queueKnowledgeAnswer, undefined);
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
      version: "0.5.20",
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
