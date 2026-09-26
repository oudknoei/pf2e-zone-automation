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
}

let nextId = 0;
const notices = [];
const effectUuid = "Item.builder-smoke-effect";
const effect = {
  documentName: "Item", type: "effect", uuid: effectUuid,
  name: "Builder smoke effect", img: "icons/smoke.webp"
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
globalThis.fromUuid = async (uuid) => ({
  [effectUuid]: effect, [actor.uuid]: actor, [tokenDocument.uuid]: tokenDocument
})[uuid] ?? null;
globalThis.PF2EZoneRuntime = {
  version: "0.5.16",
  installHooks() {},
  async activateRegion(region) { runtimeCalls.activated.push(region); },
  async endZone(region) {
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

test("builder opens, edits, accepts an Effect Item drop, creates, and dismisses a zone", async () => {
  try {
    await openZoneBuilder();
    const builderDialog = dialogs.at(-1);
    assert.equal(builderDialog.title, `PF2e Zone Automation v${moduleVersion}`);
    let root = builderDialog.window.content.querySelector(".pf2e-zone-builder");
    assert.ok(root);

    change(root.querySelector('[data-zone="name"]'), "Smoke Zone", "input");
    change(root.querySelector('[data-zone="affects-enemies"]'), true);
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

    root.querySelector(".zb-create").click();
    await until(() => regions.size === 1);
    const region = [...regions][0];
    assert.equal(region.name, "Smoke Zone");
    assert.equal(region.getFlag("world", "pf2eZone").config.effects[0].outcomes.noSave.effects[0].uuid, effectUuid);
    assert.deepEqual(runtimeCalls.activated, [region]);
    await until(() => !builderDialog.element.isConnected);

    await openZoneBuilder();
    const reopenedDialog = dialogs.at(-1);
    root = reopenedDialog.window.content.querySelector(".pf2e-zone-builder");
    root.querySelector(".zb-manage").click();
    await until(() => dialogs.at(-1).title === "Manage PF2e Zones");
    const manageDialog = dialogs.at(-1);
    assert.match(manageDialog.window.content.textContent, /Smoke Zone/);

    manageDialog.window.content.querySelector('[data-action="end"]').click();
    await until(() => regions.size === 0);
    await until(() => !manageDialog.element.isConnected);
    assert.deepEqual(runtimeCalls.ended, [region]);
    root = reopenedDialog.window.content.querySelector(".pf2e-zone-builder");
    assert.equal(root.querySelector('[data-zone="name"]').value, "Smoke Zone");
    assert.equal(root.querySelector('[data-outcome="noSave"] [data-field="effect-uuid"]').value, effectUuid);
    assert.deepEqual(notices.filter((notice) => notice.level === "error"), []);
  } finally {
    for (const dialog of dialogs) if (dialog.element.isConnected) await dialog.close();
    dom.window.close();
  }
});

