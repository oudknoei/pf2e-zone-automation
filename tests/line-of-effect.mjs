import assert from "node:assert/strict";
import test from "node:test";
import { hasLineOfEffect, isPhysicalBarrier, tokenCenter, zoneOrigin } from "../scripts/line-of-effect.js";

globalThis.CONST = {
  WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
  WALL_DOOR_TYPES: { NONE: 0, DOOR: 1 },
  WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 }
};

test("closed physical walls block line of effect while open doors and non-movement walls do not", () => {
  const origin = { x: 50, y: 50 };
  const target = { x: 250, y: 50 };
  const wall = { c: [150, 0, 150, 100], move: 20, door: 0, ds: 0 };
  const openDoor = { ...wall, door: 1, ds: 1 };
  const closedDoor = { ...wall, door: 1, ds: 0 };
  const windowOpening = { ...wall, move: 0 };

  assert.equal(isPhysicalBarrier(wall), true);
  assert.equal(hasLineOfEffect({ walls: [wall] }, origin, target), false);
  assert.equal(hasLineOfEffect({ walls: [closedDoor] }, origin, target), false);
  assert.equal(hasLineOfEffect({ walls: [openDoor] }, origin, target), true);
  assert.equal(hasLineOfEffect({ walls: [windowOpening] }, origin, target), true);
});

test("walls outside the path and contact at a path endpoint do not block", () => {
  const origin = { x: 50, y: 50 };
  const target = { x: 250, y: 50 };
  const distant = { c: [150, 150, 150, 250], move: 20 };
  const touchesOrigin = { c: [50, 0, 50, 100], move: 20 };

  assert.equal(hasLineOfEffect({ walls: [distant] }, origin, target), true);
  assert.equal(hasLineOfEffect({ walls: [touchesOrigin] }, origin, target), true);
});

test("emanations use the source Token center and placed areas use the shape center", () => {
  const source = { x: 0, y: 100, getSize: () => ({ width: 100, height: 100 }) };
  assert.deepEqual(tokenCenter(source), { x: 50, y: 150 });
  assert.deepEqual(zoneOrigin(null, { config: { mode: "emanation" } }, source), { x: 50, y: 150 });
  assert.deepEqual(
    zoneOrigin({ shapes: [{ type: "circle", x: 300, y: 400 }] }, { config: { mode: "area" } }, source),
    { x: 300, y: 400 }
  );
  assert.deepEqual(
    zoneOrigin(
      { shapes: [{ type: "rectangle", x: 200, y: 300, width: 100, height: 200 }] },
      { config: { mode: "area" } },
      source
    ),
    { x: 250, y: 400 }
  );
});
