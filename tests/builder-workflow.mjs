import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.test/" });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.innerWidth = 1280;
Math.clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const moduleVersion = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")).version;
const dialogs = [];
let importResponse = null;
class TestDialog extends window.EventTarget {
  constructor(options) {
    super();
    this.title = options.window.title;
    this.element = document.createElement("section");
    this.element.append(options.content);
    this.window = { content: options.content, element: this.element };
    dialogs.push(this);
  }

  async render() {
    document.body.append(this.element);
    this.dispatchEvent(new window.Event("render"));
    return this;
  }

  async close() {
    this.element.remove();
    this.dispatchEvent(new window.Event("close"));
  }

  static async prompt() { return null; }

  static async input() {
    const response = importResponse;
    importResponse = null;
    return response;
  }
}

let nextId = 0;
const notices = [];
const effectUuid = "Item.builder-smoke-effect";
const effect = {
  documentName: "Item", type: "effect", uuid: effectUuid,
  name: "Builder smoke effect", img: "icons/smoke.webp"
};
const effectDocuments = new Map([[effectUuid, effect]]);
const hookCallbacks = new Map();
let nextHookId = 0;
globalThis.Hooks = {
  on(name, callback) {
    const id = ++nextHookId;
    if (!hookCallbacks.has(name)) hookCallbacks.set(name, new Map());
    hookCallbacks.get(name).set(id, callback);
    return id;
  },
  off(name, id) { hookCallbacks.get(name)?.delete(id); },
  call(name, ...args) {
    for (const callback of hookCallbacks.get(name)?.values() ?? []) callback(...args);
  }
};
const actor = {
  uuid: "Actor.source", name: "Source", img: "icons/source.webp",
  combatant: null, testUserPermission: () => true
};
class RegionCollection extends Map {
  [Symbol.iterator]() { return this.values(); }
}
const regions = new RegionCollection();
const scene = { id: "scene", regions };
const tokenDocument = {
  uuid: "Scene.scene.Token.source", documentName: "Token",
  parent: scene, actor, texture: { src: "icons/source.webp" }
};
const token = { actor, name: "Source", document: tokenDocument };
const gm = { id: "gm", name: "GM", isGM: true, color: "#336699" };
const runtimeCalls = { activated: [], ended: [] };
let failDismissal = false;

globalThis.foundry = {
  utils: {
    randomID: () => `test-${++nextId}`,
    getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
    setProperty: (object, path, value) => {
      const keys = path.split(".");
      let current = object;
      for (const key of keys.slice(0, -1)) current = current[key] ??= {};
      current[keys.at(-1)] = value;
    }
  },
  applications: {
    api: { DialogV2: TestDialog },
    ux: { TextEditor: { getDragEventData: (event) => JSON.parse(event.dataTransfer.getData("text/plain")) } }
  }
};
globalThis.CONFIG = {
  PF2E: { conditionTypes: {}, damageTypes: {} },
  RegionBehavior: { dataModels: {} },
  Region: {
    documentClass: {
      async createTokenEmanation(source, radius, data) {
        assert.equal(source, tokenDocument);
        assert.ok(radius > 0);
        const id = `region-${++nextId}`;
        const region = {
          id, uuid: `Scene.scene.Region.${id}`, name: data.name, parent: scene,
          getFlag: (scope, key) => data.flags?.[scope]?.[key]
        };
        regions.set(id, region);
        return region;
      }
    }
  }
};
globalThis.CONST = {
  REGION_VISIBILITY: { ALWAYS: 2, OBSERVER: 3 },
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2 }
};
globalThis.game = {
  system: { id: "pf2e" },
  user: gm, users: { activeGM: gm },
  modules: new Map([["pf2e-zone-automation", { version: moduleVersion }]]),
  scenes: { get: (id) => id === scene.id ? scene : null },
  time: { worldTime: 0 }, combat: null,
  i18n: { localize: (key) => key }
};
globalThis.canvas = { ready: true, scene, tokens: { controlled: [token] } };
globalThis.ui = {
  notifications: {
    info: (message) => notices.push({ level: "info", message }),
    warn: (message) => notices.push({ level: "warn", message }),
    error: (message) => notices.push({ level: "error", message })
  }
};
globalThis.fromUuid = async (uuid) => effectDocuments.get(uuid) ?? ({
  [actor.uuid]: actor, [tokenDocument.uuid]: tokenDocument
})[uuid] ?? null;
globalThis.PF2EZoneRuntime = {
  version: "0.5.20",
  installHooks() {},
  async activateRegion(region) { runtimeCalls.activated.push(region); },
  async endZone(region) {
    if (failDismissal) throw new Error("Region deletion failed");
    runtimeCalls.ended.push(region);
    regions.delete(region.id);
  }
};

const { openZoneBuilder } = await import("../scripts/builder.js");

/** Waits for asynchronous browser event handlers to finish observable work. */
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Builder action did not finish");
}

/** Sends actual DOM events so the test exercises builder listeners and form reads. */
function change(element, value, event = "change") {
  if (element.type === "checkbox") element.checked = Boolean(value);
  else element.value = value;
  element.dispatchEvent(new window.Event(event, { bubbles: true }));
}

test("overlapping Save actions leave edits made during the GM response intact", async () => {
  const previous = { user: game.user, users: game.users, socket: game.socket };
  const player = { id: "player", name: "Player", active: true, isGM: false, color: "#336699" };
  const users = new Map([[gm.id, gm], [player.id, player]]);
  users.activeGM = gm;
  let socketListener;
  const sent = [];
  game.user = player;
  game.users = users;
  game.socket = {
    connected: true,
    on(_channel, listener) { socketListener = listener; },
    emit(_channel, message) { sent.push(message); }
  };
  const { registerZoneSocket } = await import("../scripts/transport.js");
  registerZoneSocket();
  let builderDialog;
  try {
    await openZoneBuilder();
    builderDialog = dialogs.at(-1);
    const root = builderDialog.window.content.querySelector(".pf2e-zone-builder");
    change(root.querySelector('[data-zone="name"]'), "Before Save", "input");
    change(root.querySelector('[data-zone="affects-enemies"]'), true);
    change(root.querySelector('[data-trigger="activation"]'), true);
    change(root.querySelector('[data-field="chat-alert-enabled"]'), true);
    change(root.querySelector('[data-field="chat-alert-text"]'), "Notice", "input");
    assert.equal(root.querySelector(".zb-create").disabled, false);

    const button = root.querySelector(".zb-save");
    button.click();
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
    root.querySelector(".zb-save-as").dispatchEvent(new window.Event("click", { bubbles: true }));
    await until(() => sent.length === 1);
    const request = sent.shift();
    assert.equal(request.request.action, "library-save");
    assert.equal(request.request.config.name, "Before Save");
    assert.equal(button.disabled, true, "Save is reserved before the GM responds");

    change(root.querySelector('[data-zone="name"]'), "Edited After Save", "input");
    await socketListener({
      kind: "response", id: request.id, gmId: gm.id, recipientUserId: player.id,
      response: {
        ok: true,
        record: {
          id: "saved-before-edit", name: "Before Save", revision: 1,
          createdBy: { userId: player.id, name: player.name },
          config: request.request.config
        }
      }
    }, gm.id);
    await until(() => !button.disabled);
    assert.equal(root.querySelector('[data-zone="name"]').value, "Edited After Save");
    assert.equal(builderDialog.window.content.querySelector(".pf2e-zone-builder"), root,
      "a delayed response does not rerender over newer edits");
    assert.equal(sent.length, 0, "overlapping Save and Save As did not send another write");
    assert.ok(notices.some((notice) => notice.message.includes("editor changed during saving")));
  } finally {
    if (builderDialog?.element.isConnected) await builderDialog.close();
    game.user = previous.user;
    game.users = previous.users;
    game.socket = previous.socket;
  }
});

test("builder opens, edits, accepts an Effect Item drop, creates, and dismisses a zone", async () => {
  try {
    await openZoneBuilder();
    const builderDialog = dialogs.at(-1);
    assert.equal(builderDialog.title, `PF2e Zone Automation v${moduleVersion}`);
    let root = builderDialog.window.content.querySelector(".pf2e-zone-builder");
    assert.ok(root);
    assert.equal(root.querySelector('[data-zone="line-of-effect"]').value, "respect");
    assert.deepEqual(
      [...root.querySelector('[data-field="dc-source"]').options].map((option) => option.textContent),
      ["Custom DC"],
      "an Actor without prepared DCs offers no DC 0 choices"
    );

    const { defaultConfig } = await import("../scripts/zone-config.js");
    const duplicateImport = defaultConfig();
    duplicateImport.name = "Imported duplicate blocks";
    duplicateImport.targeting.affects = "enemies";
    duplicateImport.effects[0].triggers.activation = true;
    duplicateImport.effects[0].chatAlert.enabled = true;
    duplicateImport.effects.push(structuredClone(duplicateImport.effects[0]));
    importResponse = { json: JSON.stringify(duplicateImport) };
    root.querySelector(".zb-import").click();
    await until(() => builderDialog.window.content.querySelector('[data-zone="name"]')?.value === duplicateImport.name);
    root = builderDialog.window.content.querySelector(".pf2e-zone-builder");
    const importedBlockIds = [...root.querySelectorAll("[data-block-id]")].map((block) => block.dataset.blockId);
    assert.equal(new Set(importedBlockIds).size, 2);
    assert.equal(importedBlockIds[0], duplicateImport.effects[0].id);
    assert.notEqual(importedBlockIds[1], importedBlockIds[0]);

    const invalidImport = defaultConfig();
    invalidImport.name = "Imported with unavailable choices";
    invalidImport.targeting.affects = "enemies";
    invalidImport.duration.type = "until-next-moon";
    invalidImport.effects[0].triggers.activation = true;
    invalidImport.effects[0].chatAlert.enabled = true;
    invalidImport.effects[0].outcomes.noSave.conditions.push({
      slug: "mystery-condition", value: 2, removal: "condition-end", condition: "missing-link"
    });
    importResponse = { json: JSON.stringify(invalidImport) };
    root.querySelector(".zb-import").click();
    await until(() => builderDialog.window.content.querySelector('[data-zone="name"]')?.value === invalidImport.name);
    root = builderDialog.window.content.querySelector(".pf2e-zone-builder");
    const durationChoice = root.querySelector('[data-zone="duration-type"]');
    const conditionRow = root.querySelector('[data-outcome="noSave"] .zb-condition-row');
    assert.equal(durationChoice.value, "until-next-moon");
    assert.match(durationChoice.selectedOptions[0].textContent, /Unavailable duration/);
    assert.equal(conditionRow.querySelector('[data-field="condition-slug"]').value, "mystery-condition");
    assert.match(conditionRow.querySelector('[data-field="condition-slug"]').selectedOptions[0].textContent, /Unavailable condition/);
    assert.equal(conditionRow.querySelector('[data-field="condition-link"]').value, "missing-link");
    assert.equal(root.querySelector(".zb-create").disabled, true);
    change(durationChoice, "unlimited");
    change(conditionRow.querySelector('[data-field="condition-slug"]'), "frightened");
    change(conditionRow.querySelector('[data-field="condition-link"]'), "sickened");
    assert.match(root.querySelector("[data-validation-status]").textContent, /Ready to create/);
    invalidImport.effects[0].repeat = "occasionally";
    importResponse = { json: JSON.stringify(invalidImport) };
    const importNoticeCount = notices.length;
    root.querySelector(".zb-import").click();
    await until(() => notices.slice(importNoticeCount).some((notice) => notice.level === "error"));
    assert.match(notices.at(-1).message, /repeat setting.*occasionally/);
    assert.equal(root.querySelector('[data-zone="duration-type"]').value, "unlimited", "rejected import keeps the current editor");
    root.querySelector(".zb-clear").click();
    root = builderDialog.window.content.querySelector(".pf2e-zone-builder");

    change(root.querySelector('[data-zone="name"]'), "Smoke Zone", "input");
    change(root.querySelector('[data-zone="affects-enemies"]'), true);
    change(root.querySelector('[data-trigger="activation"]'), true);
    change(root.querySelector('[data-trigger="continuous"]'), true);
    change(root.querySelector('[data-field="save-enabled"]'), true);
    change(root.querySelector('[data-field="custom-dc"]'), "20", "input");
    assert.match(root.querySelector('[data-field="save-enabled"]').closest("label").textContent, /separate Effect Block/);
    assert.equal(root.querySelector(".zb-create").disabled, true);
    change(root.querySelector('[data-field="save-enabled"]'), false);
    change(root.querySelector('[data-trigger="continuous"]'), false);

    change(root.querySelector('[data-trigger="activation"]'), false);
    change(root.querySelector('[data-trigger="hpThreshold"]'), true);
    const hpField = root.querySelector('[data-field="hp-threshold"]');
    assert.equal(hpField.closest(".zb-hp-threshold-options").style.display, "block");
    change(hpField, "2d4", "input");
    assert.match(hpField.closest("label").textContent, /whole-number Hit Point threshold/);
    change(hpField, "12", "input");
    const effectBlock = root.querySelector("details.zb-block");
    effectBlock.open = false;
    await until(() => /HP drops to 12/.test(root.querySelector("[data-block-summary]").textContent));
    effectBlock.open = true;
    change(root.querySelector('[data-trigger="hpThreshold"]'), false);
    change(root.querySelector('[data-trigger="activation"]'), true);

    const dropTarget = root.querySelector('[data-outcome="noSave"] .zb-effect-list');
    const drop = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { getData: () => JSON.stringify({ type: "Item", uuid: effectUuid }) }
    });
    dropTarget.dispatchEvent(drop);
    await until(() => root.querySelector('[data-outcome="noSave"] [data-field="effect-uuid"]')?.value === effectUuid);
    assert.match(root.querySelector('[data-outcome="noSave"] .zb-effect-info').textContent, /Builder smoke effect/);
    assert.match(root.querySelector("[data-validation-status]").textContent, /Ready to create/);

    const retryUuid = "Item.builder-retry-effect";
    root.querySelector('[data-outcome="noSave"] .zb-add-effect').click();
    const retryRow = [...root.querySelectorAll('[data-outcome="noSave"] .zb-effect-row')].at(-1);
    change(retryRow.querySelector('[data-field="effect-uuid"]'), retryUuid, "input");
    await until(() => /could not be found/.test(retryRow.querySelector(".zb-effect-info").textContent));
    assert.equal(root.querySelector(".zb-create").disabled, true);
    const retryEffect = {
      documentName: "Item", type: "effect", uuid: retryUuid,
      name: "Retry effect", img: "icons/retry.webp"
    };
    effectDocuments.set(retryUuid, retryEffect);
    retryRow.querySelector(".zb-retry-effect").click();
    await until(() => /Retry effect/.test(retryRow.querySelector(".zb-effect-info").textContent));
    assert.equal(root.querySelector(".zb-create").disabled, false);

    retryEffect.name = "Updated effect";
    Hooks.call("updateItem", retryEffect);
    await until(() => /Updated effect/.test(retryRow.querySelector(".zb-effect-info").textContent));

    effectDocuments.delete(retryUuid);
    Hooks.call("deleteItem", retryEffect);
    await until(() => /could not be found/.test(retryRow.querySelector(".zb-effect-info").textContent));
    effectDocuments.set(retryUuid, retryEffect);
    root.querySelector(".zb-validate").click();
    await until(() => /Updated effect/.test(retryRow.querySelector(".zb-effect-info").textContent));
    assert.equal(root.querySelector(".zb-create").disabled, false, "action-time validation replaces a cached failure");

    effectDocuments.delete(retryUuid);
    Hooks.call("deleteItem", retryEffect);
    await until(() => root.querySelector(".zb-create").disabled);
    effectDocuments.set(retryUuid, retryEffect);
    Hooks.call("createItem", retryEffect);
    await until(() => !root.querySelector(".zb-create").disabled);

    const compendiumUuid = "Compendium.test.effects.Item.cached";
    const compendiumEffect = {
      documentName: "Item", type: "effect", uuid: compendiumUuid,
      name: "Compendium effect", img: "icons/pack.webp"
    };
    effectDocuments.set(compendiumUuid, compendiumEffect);
    root.querySelector('[data-outcome="noSave"] .zb-add-effect').click();
    const compendiumRow = [...root.querySelectorAll('[data-outcome="noSave"] .zb-effect-row')].at(-1);
    change(compendiumRow.querySelector('[data-field="effect-uuid"]'), compendiumUuid, "input");
    await until(() => /Compendium effect/.test(compendiumRow.querySelector(".zb-effect-info").textContent));
    compendiumEffect.name = "Updated compendium effect";
    Hooks.call("updateCompendium", { collection: "test.effects" }, [compendiumEffect]);
    await until(() => /Updated compendium effect/.test(compendiumRow.querySelector(".zb-effect-info").textContent));

    root.querySelector('[data-outcome="failure"] .zb-add-effect').click();
    const hiddenEffect = root.querySelector('[data-outcome="failure"] [data-field="effect-uuid"]');
    change(hiddenEffect, "Item.deleted", "input");
    assert.equal(root.querySelector(".zb-create").disabled, false, "hidden Failure Item does not block No Save creation");
    change(root.querySelector('[data-field="save-enabled"]'), true);
    await until(() => root.querySelector(".zb-create").disabled &&
      /could not be found/.test(root.querySelector('[data-outcome="failure"] .zb-effect-info').textContent));
    change(root.querySelector('[data-field="save-enabled"]'), false);
    assert.equal(root.querySelector(".zb-create").disabled, false, "turning saves off restores readiness");

    const createButton = root.querySelector(".zb-create");
    createButton.click();
    createButton.dispatchEvent(new window.Event("click", { bubbles: true }));
    await until(() => regions.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(regions.size, 1, "two clicks before validation finishes create only one Region");
    const region = [...regions][0];
    assert.equal(region.name, "Smoke Zone");
    assert.equal(region.getFlag("world", "pf2eZone").config.targeting.lineOfEffect, "respect");
    assert.equal(region.getFlag("world", "pf2eZone").config.effects[0].outcomes.noSave.effects[0].uuid, effectUuid);
    assert.equal(region.getFlag("world", "pf2eZone").config.effects[0].outcomes.failure.effects[0].uuid, "Item.deleted");
    assert.deepEqual(runtimeCalls.activated, [region]);
    await until(() => !builderDialog.element.isConnected);
    assert.equal(hookCallbacks.get("updateItem")?.size, 0, "the closed builder removes its Item watches");
    assert.equal(hookCallbacks.get("updateCompendium")?.size, 0, "the closed builder removes its pack watch");
    region.getFlag("world", "pf2eZone").state.endRequested = true;
    region.getFlag("world", "pf2eZone").state.pendingSaves = {
      "save-1": {
        id: "save-1", identifier: "pf2e-zone:scene:region:save-1",
        tokenUuid: tokenDocument.uuid, actorUuid: actor.uuid,
        blockId: "block", blockName: "Battle Cry", saveTypes: ["will"], dc: 25
      }
    };

    await openZoneBuilder();
    const reopenedDialog = dialogs.at(-1);
    root = reopenedDialog.window.content.querySelector(".pf2e-zone-builder");
    root.querySelector(".zb-manage").click();
    await until(() => dialogs.at(-1).title === "Manage PF2e Zones");
    const manageDialog = dialogs.at(-1);
    assert.match(manageDialog.window.content.textContent, /Smoke Zone/);
    assert.match(manageDialog.window.content.textContent, /Cleanup pending/);
    assert.match(manageDialog.window.content.querySelector('[data-action="end"]').textContent, /Retry Dismiss/);
    assert.match(manageDialog.window.content.textContent, /Pending saves \(1\)/);
    assert.match(manageDialog.window.content.textContent, /Battle Cry.*Will DC 25/s);

    const originalCancel = globalThis.PF2EZoneRuntime.cancelPendingSave;
    const originalGetUser = game.users.get;
    game.users.get = (id) => id === gm.id ? { ...gm, active: true } : null;
    const cancelled = [];
    globalThis.PF2EZoneRuntime.cancelPendingSave = async (_region, pendingId, identifier) => {
      cancelled.push([pendingId, identifier]);
      delete region.getFlag("world", "pf2eZone").state.pendingSaves[pendingId];
      return { status: "cancelled" };
    };
    try {
      manageDialog.window.content.querySelector('[data-action="cancel-save"]').click();
      await until(() => !manageDialog.window.content.querySelector('[data-action="cancel-save"]'));
      assert.deepEqual(cancelled, [["save-1", "pf2e-zone:scene:region:save-1"]]);
      assert.equal(region.getFlag("world", "pf2eZone").state.pendingSaves["save-1"], undefined);
      assert.equal(manageDialog.window.content.querySelector(".pza-pending-list"), null);
      assert.equal(manageDialog.element.isConnected, true, "cancellation keeps the zone manager open");
    } finally {
      if (originalCancel === undefined) delete globalThis.PF2EZoneRuntime.cancelPendingSave;
      else globalThis.PF2EZoneRuntime.cancelPendingSave = originalCancel;
      if (originalGetUser === undefined) delete game.users.get;
      else game.users.get = originalGetUser;
    }

    const dismissButton = manageDialog.window.content.querySelector('[data-action="end"]');
    const dismissalNoticeStart = notices.length;
    failDismissal = true;
    const priorConsoleError = console.error;
    try {
      console.error = () => {};
      dismissButton.click();
      await until(() => notices.slice(dismissalNoticeStart).some((notice) => notice.level === "error"));
    } finally {
      console.error = priorConsoleError;
    }
    assert.equal(regions.size, 1, "failed dismissal leaves the Region intact");
    assert.equal(manageDialog.element.isConnected, true);
    assert.equal(dismissButton.disabled, false, "failed dismissal can be retried");
    assert.equal(notices.some((notice) => notice.level === "info" && notice.message.startsWith("Dismissed")), false);

    failDismissal = false;
    dismissButton.click();
    await until(() => regions.size === 0);
    await until(() => !manageDialog.element.isConnected);
    assert.deepEqual(runtimeCalls.ended, [region]);
    root = reopenedDialog.window.content.querySelector(".pf2e-zone-builder");
    assert.equal(root.querySelector('[data-zone="name"]').value, "Smoke Zone");
    assert.equal(root.querySelector('[data-outcome="noSave"] [data-field="effect-uuid"]').value, effectUuid);
    assert.deepEqual(notices.slice(dismissalNoticeStart).filter((notice) => notice.level === "error").map((notice) => notice.message), [
      "PF2e Zone dismissal failed: Region deletion failed"
    ]);

    const originalActivate = globalThis.PF2EZoneRuntime.activateRegion;
    const priorCreationError = console.error;
    const noticeCount = notices.length;
    globalThis.PF2EZoneRuntime.activateRegion = async () => {
      throw new Error("Simulated activation failure");
    };
    console.error = () => {};
    try {
      await until(() => !root.querySelector(".zb-create").disabled);
      root.querySelector(".zb-create").click();
      await until(() => regions.size === 1);
      await until(() => notices.slice(noticeCount).some((notice) => notice.level === "warn"));
      const creationNotices = notices.slice(noticeCount);
      assert.ok(creationNotices.some((notice) => notice.level === "info" && notice.message.includes("created")));
      assert.ok(creationNotices.some((notice) => notice.level === "warn" && notice.message.includes("activation did not finish")));
      assert.equal(creationNotices.some((notice) => notice.level === "error"), false);
    } finally {
      globalThis.PF2EZoneRuntime.activateRegion = originalActivate;
      console.error = priorCreationError;
    }
  } finally {
    for (const dialog of dialogs) if (dialog.element.isConnected) await dialog.close();
    dom.window.close();
  }
});

