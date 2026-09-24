import assert from "node:assert/strict";
import test from "node:test";
import { editableDurationRounds, editableZoneSize } from "../scripts/config-input.js";
import { durationRoundsError } from "../scripts/duration.js";

test("missing legacy fields receive defaults while cleared dimensions remain invalid", () => {
  assert.equal(editableZoneSize(undefined, 15), 15);
  assert.equal(editableZoneSize(null, 10), 10);
  assert.equal(editableZoneSize("", 15), "");
  assert.equal(editableZoneSize("   ", 10), "");
  assert.equal(editableZoneSize("0", 15), 0);
  assert.equal(editableZoneSize("-5", 15), -5);
  assert.equal(editableZoneSize("25", 15), 25);
});

test("missing legacy durations receive a default while cleared custom durations remain blank", () => {
  assert.equal(editableDurationRounds(undefined, 1), 1);
  assert.equal(editableDurationRounds(null, 1), 1);
  assert.equal(editableDurationRounds("", 1), "");
  assert.equal(editableDurationRounds("   ", 1), "");
  assert.match(durationRoundsError(editableDurationRounds("", 1)), /positive whole number/);
  assert.equal(editableDurationRounds("0", 1), "0");
  assert.equal(editableDurationRounds("2d4", 1), "2d4");
});
