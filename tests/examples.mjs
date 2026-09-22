import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const examples = resolve(root, "examples", "zone-configurations");
const expectedFiles = [
  "courageous-anthem.json",
  "focusing-hum.json",
  "frightful-presence-adult-horned-dragon.json",
  "ghonatine-stench.json",
  "shadow-raid.json",
  "soulcutter-soothe-souls.json",
  "stoke-the-fervent-urdefhan-tormentor.json",
  "toxic-cloud.json"
];

test("each JSON template is available as a standalone import example", () => {
  const files = readdirSync(examples).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(files, expectedFiles);
  for (const file of files) {
    const config = JSON.parse(readFileSync(join(examples, file), "utf8"));
    assert.ok(Number.isInteger(config.schemaVersion), `${file} needs a schema version`);
    assert.match(config.name, /\S/, `${file} needs a name`);
    assert.ok(["area", "emanation"].includes(config.mode), `${file} has an invalid mode`);
    assert.ok(Number(config.radius) > 0, `${file} needs a positive radius`);
    assert.notEqual(config.duration?.type, "until-dismissed", `${file} uses a retired duration type`);
    assert.equal(config.duration?.dismissible, undefined, `${file} retains a retired dismissal setting`);
    assert.ok(Array.isArray(config.effects), `${file} needs Effect Blocks`);
  }
});