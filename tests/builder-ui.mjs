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
  assert.match(builder, /When a creature casts a spell/);
  assert.match(builder, /spellCast: false/);
  assert.match(builder, /value="creator"/);
  assert.match(builder, /REGION_VISIBILITY\?\.OBSERVER/);
  assert.doesNotMatch(builder, />GM only<\/option>/);
  assert.match(builder, /data-block-summary/);
  assert.match(builder, /PF2e Zone Automation v\$\{game\.modules\.get\("pf2e-zone-automation"\)\?\.version/);
  assert.match(builder, /function blockSummary/);
  assert.match(builder, /data-validation-status/);
  assert.match(builder, /Ready to create/);
  assert.match(builder, /data-operation-status/);
  assert.match(builder, /GM connected/);
  assert.match(builder, /Player creation available/);
  assert.match(builder, /Source token changed/);
  assert.doesNotMatch(builder, /Player GM bridge: module socket/);
  assert.match(builder, /function renderInlineValidation/);
  assert.match(builder, /function refreshLiveValidation/);
  assert.match(builder, /function refreshOperationStatus/);
  assert.match(builder, /name: ""/);
  assert.match(builder, /traits: \[\]/);
  assert.match(builder, /enter: false/);
  assert.match(builder, /dc: \{ mode: "custom", value: "" \}/);
  assert.match(builder, /data-zone="name" type="text" value="\$\{esc\(state\.name\)\}" required/);
  assert.match(builder, /data-trait-use-trait/);
  assert.match(builder, /WATCHED_TRAITS/);
  assert.doesNotMatch(builder, /trait: "vitality"/);
});

test("README provides a complete How To and omits retired sections", () => {
  assert.match(readme, /^## How To$/m);
  assert.match(readme, /^### Configure an Effect Block$/m);
  assert.match(readme, /^### Save, import, and reuse configurations$/m);
  assert.match(readme, /GM connected/);
  assert.match(readme, /Player creation available/);
  assert.match(readme, /Source token changed/);
  assert.doesNotMatch(readme, /^## Create a Zone$/m);
  assert.doesNotMatch(readme, /^## Player Use$/m);
  assert.doesNotMatch(readme, /^## PF2e Zone Effects$/m);
  assert.doesNotMatch(readme, /^## Releasing a New Version$/m);
});