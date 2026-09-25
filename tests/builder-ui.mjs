import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const builder = readFileSync(resolve(root, "scripts", "builder.js"), "utf8");
const config = readFileSync(resolve(root, "scripts", "zone-config.js"), "utf8");
const creation = readFileSync(resolve(root, "scripts", "zone-creation.js"), "utf8");
const styles = readFileSync(resolve(root, "styles", "pf2e-zone.css"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

test("builder uses plain-language triggers and summarizes collapsed Effect Blocks", () => {
  assert.match(builder, /Post Preview to Chat/);
  assert.doesNotMatch(builder, /Validate & Preview/);
  assert.match(builder, /When the zone is created/);
  assert.match(builder, /When a creature enters after creation/);
  assert.match(builder, /At the start of a creature's turn/);
  assert.match(builder, /When a creature casts a spell/);
  assert.match(config, /spellCast: false/);
  assert.match(builder, /value="creator"/);
  assert.match(creation, /REGION_VISIBILITY\?\.OBSERVER/);
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
  assert.doesNotMatch(builder, /data-action="load-config"/);
  assert.match(builder, /data-action="end"/);
  assert.match(builder, /const savedPresetId = loadedPreset\?\.id \?\? null/);
  assert.match(builder, /loadedPreset = savedPreset \? clone\(savedPreset\) : null/);
  assert.match(builder, /class="zb-load-saved"[^\n]*Open<\/button>/);
  assert.match(builder, /class="zb-clear"/);
  assert.match(builder, /Zone configuration cleared/);
  assert.doesNotMatch(builder, /data-action="export"/);
  assert.doesNotMatch(builder, /\{outcome\}/);
  assert.match(builder, /Source actor was not changed/);
  assert.doesNotMatch(builder, /Player GM bridge: module socket/);
  assert.match(builder, /function renderInlineValidation/);
  assert.match(builder, /function refreshLiveValidation/);
  assert.match(builder, /function refreshOperationStatus/);
  assert.match(config, /name: ""/);
  assert.match(config, /traits: \[\]/);
  assert.match(config, /enter: false/);
  assert.match(config, /repeat: "once-per-round"/);
  assert.match(config, /pf2eFormulaError\(block\.damage\.formula/);
  assert.match(config, /dc: \{ mode: "custom", value: "" \}/);
  assert.match(builder, /data-zone="name" type="text" value="\$\{esc\(state\.name\)\}" required/);
  assert.match(config, /type: "unlimited"/);
  assert.doesNotMatch(builder, /option value="until-dismissed"/);
  assert.doesNotMatch(builder, /data-zone="dismissible"/);
  assert.match(builder, /data-trait-use-trait/);
  assert.match(builder, /WATCHED_TRAITS/);
  assert.doesNotMatch(builder, /trait: "vitality"/);
  const zoneStart = builder.indexOf("<h3>Zone</h3>");
  const zoneEnd = builder.indexOf("</section>", zoneStart);
  const zoneMarkup = builder.slice(zoneStart, zoneEnd);
  assert.ok(zoneMarkup.indexOf('data-zone="visibility"') < zoneMarkup.indexOf('data-zone="duration-type"'));
  assert.ok(zoneMarkup.indexOf('data-zone="duration-type"') < zoneMarkup.indexOf('data-zone="affects-allies"'));
  assert.match(zoneMarkup, /data-zone="affects-allies"/);
  assert.match(zoneMarkup, /data-zone="affects-enemies"/);
  assert.match(zoneMarkup, /data-zone="affects-self"/);
  assert.doesNotMatch(zoneMarkup, /<select data-zone="affects">/);
  assert.doesNotMatch(zoneMarkup, /Include source actor/);
  assert.match(zoneMarkup, /option value="area-circle"/);
  assert.match(zoneMarkup, /option value="area-square"/);
  assert.doesNotMatch(zoneMarkup, /data-zone="area-shape"/);
  assert.match(builder, /zoneTypeChoice\(state\)/);
  assert.match(builder, /\.\.\.zoneTypeFields\(field\(root, '\[data-zone="mode"\]'\)\.value\)/);
  assert.doesNotMatch(builder, /<h3>Duration<\/h3>/);
  assert.match(styles, /\.zb-source img \{ width:36px; height:36px;/);
});

test("builder imports the runtime used during startup and zone management", () => {
  assert.match(builder, /import \{ zoneRuntimeEntrypoint \} from "\.\/runtime\.js"/);
  assert.match(builder, /await zoneRuntimeEntrypoint\(\)/);
});

test("builder accepts persistent Item drops and shows resolved effect details", () => {
  assert.match(builder, /getDragEventData\(event\)/);
  assert.match(builder, /inspectEffectItem\(dragData\.uuid\)/);
  assert.match(builder, /class="zb-effect-info"/);
  assert.match(builder, /image\.src = result\.img/);
  assert.match(builder, /Checking Effect Items/);
  assert.match(builder, /await validateForAction\(root, cfg\)/);
  assert.match(styles, /\.zb-effect-info img/);
});

test("builder validates current size and duration input before applying legacy defaults", () => {
  assert.match(config, /radius: editableZoneSize\(cfg\.radius, base\.radius\)/);
  assert.match(config, /sideLength: editableZoneSize\(cfg\.sideLength, base\.sideLength\)/);
  assert.match(config, /rounds: cfg\.duration\?\.type === "1-round"[\s\S]*editableDurationRounds\(cfg\.duration\?\.rounds, base\.duration\.rounds\)/);
  assert.match(builder, /radius: editableZoneSize\(field\(root, '\[data-zone="radius"\]'\)\.value\)/);
  assert.match(builder, /sideLength: editableZoneSize\(field\(root, '\[data-zone="side-length"\]'\)\.value\)/);
  assert.match(config, /!Number\.isFinite\(cfg\.radius\)/);
  assert.match(config, /!Number\.isFinite\(cfg\.sideLength\)/);
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