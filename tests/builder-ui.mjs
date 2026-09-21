import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const builder = readFileSync(resolve(root, "scripts", "builder.js"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

test("builder uses plain-language triggers and summarizes collapsed Effect Blocks", () => {
  assert.match(builder, /Post Preview to Chat/);
  assert.doesNotMatch(builder, /Validate & Preview/);
  assert.match(builder, /When the zone is created/);
  assert.match(builder, /When a creature enters after creation/);
  assert.match(builder, /At the start of a creature's turn/);
  assert.match(builder, /data-block-summary/);
  assert.match(builder, /function blockSummary/);
});

test("README provides a complete How To and omits retired sections", () => {
  assert.match(readme, /^## How To$/m);
  assert.match(readme, /^### Configure an Effect Block$/m);
  assert.match(readme, /^### Save, import, and reuse configurations$/m);
  assert.doesNotMatch(readme, /^## Create a Zone$/m);
  assert.doesNotMatch(readme, /^## Player Use$/m);
  assert.doesNotMatch(readme, /^## PF2e Zone Effects$/m);
  assert.doesNotMatch(readme, /^## Releasing a New Version$/m);
});