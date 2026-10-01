import assert from "node:assert/strict";
import test from "node:test";

import { drawZoneOutline, installZoneOutlines } from "../scripts/zone-outline.js";

const registrations = new Map();
const hooks = new Map();
const graphics = [];
globalThis.PIXI = { Graphics: class {
  constructor() { this.calls = []; graphics.push(this); }
  clear() { this.calls.push(["clear"]); }
  lineStyle(...args) { this.calls.push(["lineStyle", ...args]); }
  moveTo(...args) { this.calls.push(["moveTo", ...args]); }
  lineTo(...args) { this.calls.push(["lineTo", ...args]); }
  closePath() { this.calls.push(["closePath"]); }
  destroy() { this.destroyed = true; }
} };
globalThis.game = { system: { id: "pf2e" } };
globalThis.libWrapper = {
  register(moduleId, target, wrapper, mode) {
    assert.equal(moduleId, "pf2e-zone-automation");
    registrations.set(target, { wrapper, mode });
  }
};
globalThis.Hooks = { on(name, handler) { hooks.set(name, handler); } };
globalThis.canvas = { regions: { placeables: [] } };

/** Creates a minimal canvas Region with a real zone flag and a polygon hole. */
function zone(color = "#336699") {
  const region = {
    document: {
      color,
      getFlag: () => ({}),
      polygonTree: [
        { path: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }] },
        { path: [{ x: 2, y: 2 }, { x: 2.5, y: 2 }, { x: 2.5, y: 3 }] }
      ]
    },
    addChild(child) { child.parent = this; }
  };
  return region;
}

test("module Regions render two outlined boundaries without any fill", () => {
  const region = zone();
  drawZoneOutline(region);
  assert.equal(graphics.length, 1);
  const outline = graphics[0];
  assert.equal(outline.eventMode, "none");
  assert.deepEqual(outline.calls.filter(([name]) => name === "lineStyle"), [
    ["lineStyle", 7, 0x000000, 0.9],
    ["lineStyle", 4, 0x336699, 1]
  ]);
  assert.equal(outline.calls.filter(([name]) => name === "closePath").length, 4);
  assert.equal(outline.calls.some(([name]) => name.toLowerCase().includes("fill")), false);
  drawZoneOutline(region);
  assert.equal(graphics.length, 1, "refresh reuses the same line object");
  outline.destroy();
  drawZoneOutline(region);
  assert.equal(graphics.length, 2, "a native redraw replaces a destroyed line object");
});

test("Foundry Color objects and numeric colors draw without restoring the fill", () => {
  class FoundryColor extends Number {
    toString() { return "#336699"; }
  }
  const colorObjectZone = zone(new FoundryColor(0x336699));
  drawZoneOutline(colorObjectZone);
  assert.deepEqual(graphics.at(-1).calls.filter(([name]) => name === "lineStyle").at(-1),
    ["lineStyle", 4, 0x336699, 1]);
  const numericZone = zone(0xabcdef);
  drawZoneOutline(numericZone);
  assert.deepEqual(graphics.at(-1).calls.filter(([name]) => name === "lineStyle").at(-1),
    ["lineStyle", 4, 0xabcdef, 1]);
});

test("unrelated Regions keep their ordinary Foundry rendering", async () => {
  const ordinary = zone();
  ordinary.document.getFlag = () => null;
  const before = graphics.length;
  drawZoneOutline(ordinary);
  assert.equal(graphics.length, before);
  canvas.regions.placeables = [ordinary, zone()];
  installZoneOutlines();
  assert.equal(graphics.length, before + 1, "an already viewed zone gets its line");
  assert.equal(hooks.has("canvasReady"), true);
  let nativeRenders = 0;
  const render = registrations.get("foundry.canvas.placeables.regions.RegionMesh.prototype._render");
  assert.equal(render.mode, "MIXED");
  const native = () => { nativeRenders += 1; };
  render.wrapper.call({ region: ordinary }, native);
  render.wrapper.call({ region: canvas.regions.placeables[1] }, native);
  assert.equal(nativeRenders, 1, "only the module zone fill is suppressed");
  render.wrapper.call({ region: zone() }, native);
  assert.equal(nativeRenders, 2, "a zone without a working outline keeps the native fill");

  const drawn = registrations.get("CONFIG.Region.objectClass.prototype._draw");
  assert.equal(drawn.mode, "WRAPPER");
  const newZone = zone();
  await drawn.wrapper.call(newZone, async () => undefined);
  assert.equal(graphics.length, before + 2);
  const refreshed = registrations.get("CONFIG.Region.objectClass.prototype._refreshGeometry");
  newZone.document.polygonTree = [{ path: [{ x: 10, y: 20 }, { x: 30, y: 20 }] }];
  refreshed.wrapper.call(newZone, () => undefined);
  assert.equal(graphics.length, before + 2);
  assert.ok(graphics.at(-1).calls.some((call) => call[0] === "moveTo" && call[1] === 10));
  assert.ok(registrations.has("CONFIG.Region.objectClass.prototype._onTokenAnimationFrame"));
});
