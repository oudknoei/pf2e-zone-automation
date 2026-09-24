import assert from "node:assert/strict";
import test from "node:test";
import { fixedAreaShape, sweptAreaIntersectsToken, tokenBounds, translatedAreaShapes } from "../scripts/area-shape.js";

test("a 10-foot square is centered on the placement point", () => {
  assert.deepEqual(fixedAreaShape({ areaShape: "square", sideLength: 10 }, { x: 250, y: 350 }, 10), {
    type: "rectangle", x: 200, y: 300, width: 100, height: 100, rotation: 0, gridBased: true
  });
  assert.deepEqual(fixedAreaShape({ radius: 5 }, { x: 250, y: 350 }, 10), {
    type: "circle", x: 250, y: 350, radius: 50, gridBased: true
  });
});

test("a translated square reaches tokens passed over between its endpoints", () => {
  const before = { type: "rectangle", x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  const after = { ...before, x: 300 };
  const translation = translatedAreaShapes([before], [after]);
  assert.ok(translation);
  assert.equal(sweptAreaIntersectsToken(translation, { x: 160, y: 40, width: 50, height: 50 }), true);
  assert.equal(sweptAreaIntersectsToken(translation, { x: 160, y: 150, width: 50, height: 50 }), false);
  assert.equal(sweptAreaIntersectsToken(translation, { x: 310, y: 40, width: 50, height: 50 }), true);
  assert.equal(translatedAreaShapes([before], [{ ...after, width: 150 }]), null);
});

test("a dragged circle also reaches tokens along its path", () => {
  const before = { type: "circle", x: 0, y: 0, radius: 40 };
  const translation = translatedAreaShapes([before], [{ ...before, x: 200 }]);
  assert.equal(sweptAreaIntersectsToken(translation, { x: 90, y: 20, width: 20, height: 20 }), true);
  assert.equal(sweptAreaIntersectsToken(translation, { x: 90, y: 60, width: 20, height: 20 }), false);
});

test("moved-area Entry runs once for crossed and destination creatures", async () => {
  const handlers = new Map();
  globalThis.Hooks = {
    on: (name, fn) => { handlers.set(name, fn); return name; },
    off: (name) => handlers.delete(name)
  };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.foundry = { utils: { randomID: () => "move-test" } };
  globalThis.game = {
    actors: { contents: [] }, scenes: { contents: [] },
    users: { activeGM: { id: "gm" } }, user: { id: "gm", isGM: true },
    time: { worldTime: 0 }, combat: { id: "combat", round: 1, turn: 0 }
  };

  const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
  const runtime = await zoneRuntimeEntrypoint();
  runtime.reconcileAllLinkedConditions = async () => {};
  const makeToken = (id, x, y) => ({ uuid: id, name: id, x, y, getSize: () => ({ width: 50, height: 50 }) });
  const crossed = makeToken("crossed", 160, 20);
  const destination = makeToken("destination", 310, 20);
  const offPath = makeToken("off-path", 310, 160);
  const scene = { tokens: [crossed, destination, offPath], regions: new Map() };
  let shape = { type: "rectangle", x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  const region = {
    id: "area", uuid: "Scene.test.Region.area", parent: scene,
    get shapes() { return [{ toObject: () => ({ ...shape }) }]; },
    getFlag: () => ({ config: { mode: "area" }, state: { activationProcessed: true } })
  };
  scene.regions.set(region.id, region);
  let occupants = [];
  runtime.tokensInside = () => occupants;
  runtime.eligible = async () => true;
  runtime.withState = async (_region, callback) => callback({ state: {}, config: { effects: [] } });
  const processed = [];
  runtime.processTriggerUnlocked = async (_region, _payload, token, trigger) => processed.push([token.uuid, trigger]);

  handlers.get("preUpdateRegion")(region, { shapes: [shape] });
  shape = { ...shape, x: 300 };
  occupants = [destination];
  await runtime.handleRegionEvent({ region, event: { name: "tokenEnter", data: { token: destination, movement: null } } });
  assert.equal(processed.length, 0, "early Foundry boundary entry waits for the full area sweep");
  handlers.get("updateRegion")(region, { shapes: [shape] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, [["crossed", "enter"], ["destination", "enter"]]);

  await runtime.handleRegionEvent({ region, event: { name: "tokenEnter", data: { token: destination, movement: null } } });
  assert.equal(processed.length, 2, "Foundry boundary entry is not applied twice");

  await runtime.handleRegionEvent({ region, event: { name: "tokenEnter", data: { token: destination, movement: {} } } });
  assert.equal(processed.length, 3, "actual Token movement still triggers Entry");

  handlers.get("preUpdateRegion")(region, { shapes: [shape] });
  shape = { ...shape, height: 200 };
  occupants = [destination, offPath];
  handlers.get("updateRegion")(region, { shapes: [shape] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed.at(-1), ["off-path", "enter"], "resize applies Entry only to newly covered tokens");
  runtime.teardownHooks();
});
