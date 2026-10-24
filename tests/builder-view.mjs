import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { defaultConfig, normalizeConfig } from "../scripts/zone-config.js";
import { readConfig } from "../scripts/builder-form.js";
import { createBuilderView, blockSummary, renderSavedZones, renderManagedZones, renderJsonExport,
  renderJsonImport, renderValidationDialog, renderActivationDamageChoice } from "../scripts/builder-view.js";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function viewModel() {
  const state = defaultConfig();
  state.name = "Flame <script>";
  state.mode = "area";
  state.areaShape = "square";
  state.sideLength = 30;
  state.duration = { type: "custom-rounds", rounds: "2d4" };
  state.activationChoices.damageType.options = ["fire", "untyped"];
  state.effects[0].name = "Reactive & Dangerous";
  state.effects[0].save.enabled = true;
  state.effects[0].save.dc.value = 17;
  state.effects[0].triggers.enter = true;
  state.effects[0].immunity.starts = ["critical-success-only"];
  state.effects[0].outcomes.failure.conditions = [{ slug: "frightened", value: 2, removal: "on-exit", condition: "" }];
  return freeze({
    state: normalizeConfig(state),
    sourceActor: { name: "Scholar <img>", img: "icons/source.webp" },
    sourceToken: { name: "Token & Name", document: { texture: { src: "icons/token.webp" } } },
    loadedPreset: { name: "Other <b> preset", createdBy: { name: "Owner & Name" } },
    sourceMatches: false, canOverwrite: false,
    conditionChoices: [{ slug: "frightened", label: "Frightened" }, { slug: "prone", label: "Prone" }],
    damageChoices: [{ slug: "fire", label: "Fire" }, { slug: "untyped", label: "Untyped" }],
    dcChoices: [{ statistic: "spell", label: "Spell DC", dc: 25 }]
  });
}

test("editor rendering uses frozen snapshots without Foundry globals and preserves the serialized configuration", () => {
  const model = viewModel();
  const original = JSON.stringify(model);
  const descriptors = new Map();
  let html;
  let preview;
  try {
    for (const name of ["game", "canvas", "CONFIG", "foundry", "document"]) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, get: () => assert.fail(`Rendering read ${name}`) });
    }
    const view = createBuilderView(model);
    html = view.renderRoot();
    preview = view.previewHtml(model.state, { errors: [], warnings: [] });
    assert.match(blockSummary(model.state.effects[0]), /When a creature enters/);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  const dom = new JSDOM(html);
  try {
    const root = dom.window.document.querySelector(".pf2e-zone-builder");
    assert.deepEqual(readConfig(root), model.state);
    assert.equal(root.querySelector(".zb-source-name").textContent, "Source: Token & Name (Scholar <img>)");
    assert.equal(root.querySelector(".zb-save").disabled, true);
    assert.match(root.querySelector(".zb-warning").textContent, /controlled token has changed/);
    assert.equal(root.querySelector(".zb-load-saved").textContent.trim(), "Open");
    assert.equal(root.querySelector('[data-field="immunity-group"]').placeholder, "e.g. stench");
    assert.equal(root.querySelector('[data-immunity-start="critical-success-only"]').checked, true);
    assert.match(root.querySelector('[data-immunity-start="critical-success-only"]').parentElement.textContent, /On critical success only/);
    assert.equal(root.querySelectorAll("script, style, [style]").length, 0);
    assert.equal(root.querySelectorAll("img").length, 1);
    assert.equal(root.querySelector("img").getAttribute("src"), "icons/token.webp");
    assert.doesNotMatch(preview, /<script>|<img>|style=/);
    assert.match(preview, /rolled when created/);
    assert.equal(JSON.stringify(model), original);
  } finally { dom.window.close(); }
});

test("saved-preset views preserve literal labels and requester-specific controls without mutating records", () => {
  const records = freeze([
    { id: "own", name: "My <img> zone", createdBy: { userId: "player", name: "Player" } },
    { id: "other", name: "Other & zone", createdBy: { userId: "other", name: "Other" } }
  ]);
  const dom = new JSDOM(renderSavedZones(records, { isGM: false, userId: "player" }));
  try {
    const own = dom.window.document.querySelector('[data-record-id="own"]');
    const other = dom.window.document.querySelector('[data-record-id="other"]');
    assert.equal(own.querySelector("b").textContent, "My <img> zone (Player)");
    assert.equal(own.querySelector('[data-action="load"]').textContent.trim(), "Load");
    assert.ok(own.querySelector('[data-action="delete"]'));
    assert.equal(other.querySelector('[data-action="delete"]'), null);
    assert.equal(dom.window.document.querySelectorAll("img, style, [style]").length, 0);
    const gmMarkup = renderSavedZones(records, { isGM: true, userId: "gm" });
    dom.window.document.body.innerHTML = gmMarkup;
    assert.equal(dom.window.document.querySelectorAll('[data-action="delete"]').length, 2);
  } finally { dom.window.close(); }
});

test("manager views preserve pending-save identities, cleanup labels and resolved action permissions", () => {
  const zones = freeze([
    { id: "movable", name: "Area <img>", config: { mode: "area", areaShape: "square", sideLength: 20 },
      createdByName: "Owner", canMove: true, canEnd: true, cleanupPending: false, pendingRows: [] },
    { id: "cleanup", name: "Cleanup zone", config: { mode: "emanation", radius: 10 },
      createdByName: "Other", canMove: false, canEnd: true, cleanupPending: true,
      pendingRows: [{ pendingId: "pending-1", targetName: "Creature <script>", blockName: "Cloud", saveTypes: "Fortitude", dc: 22 }] }
  ]);
  const dom = new JSDOM(renderManagedZones(zones));
  try {
    const area = dom.window.document.querySelector('[data-region-id="movable"]');
    assert.equal(area.querySelector("b").textContent, "Area <img>");
    assert.equal(area.querySelector('[data-action="move"]').textContent.trim(), "Move");
    const cleanup = dom.window.document.querySelector('[data-region-id="cleanup"]');
    assert.equal(cleanup.querySelector('[data-action="move"]'), null);
    assert.equal(cleanup.querySelector('[data-action="end"]').textContent.trim(), "Retry Dismiss");
    assert.equal(cleanup.querySelector(".pza-pending-count").textContent, "Pending saves (1)");
    assert.equal(cleanup.querySelector('[data-action="cancel-save"]').dataset.pendingId, "pending-1");
    assert.match(cleanup.querySelector(".pza-pending-row").textContent, /Creature <script> — Cloud · Fortitude DC 22/);
    assert.equal(dom.window.document.querySelectorAll("script, img, style, [style]").length, 0);
  } finally { dom.window.close(); }
});

test("dialog and preview presentation comes from the shipped stylesheet while reference text remains literal", () => {
  const styles = readFileSync(new URL("../styles/pf2e-zone.css", import.meta.url), "utf8");
  const json = '{"name":"</textarea><script>bad()</script>"}';
  const html = renderJsonExport(json) + renderJsonImport("Actor <img>")
    + renderSavedZones([{ id: "saved", name: "Saved" }], { isGM: true, userId: "gm" })
    + renderManagedZones([{ id: "area", name: "Area", config: {}, pendingRows: [] }])
    + '<div class="pf2e-zone-preview"><span class="zb-preview-details">Details</span><p class="zb-preview-note">Note</p></div>';
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("script, img, style, [style]").length, 0);
    assert.equal(document.querySelector(".zb-json").value, json);
    const style = document.createElement("style");
    style.textContent = styles;
    document.head.append(style);
    const computed = selector => dom.window.getComputedStyle(document.querySelector(selector));
    assert.equal(computed(".zb-json").height, "360px");
    assert.equal(computed(".zb-json").maxHeight, "45vh");
    assert.equal(computed(".zb-json").whiteSpace, "pre");
    assert.equal(computed(".zb-json-import").height, "320px");
    assert.equal(computed(".pza-saved-row").display, "grid");
    assert.equal(computed(".pza-manage").maxHeight, "55vh");
    assert.equal(computed(".zb-preview-details").opacity, "0.8");
    assert.equal(computed(".zb-preview-note").opacity, "0.7");
    document.body.innerHTML = renderValidationDialog({ errors: ["Bad <img> value"], warnings: ["Warning & reason"] });
    assert.equal(document.querySelectorAll("img").length, 0);
    assert.match(document.body.textContent, /Bad <img> value/);
    document.body.innerHTML = renderActivationDamageChoice(["fire", "cold"]);
    assert.deepEqual([...document.querySelectorAll("option")].map(option => option.value), ["fire", "cold"]);
  } finally { dom.window.close(); }
});
