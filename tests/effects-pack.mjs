import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { compiledPackRecords } from "./compiled-pack-records.mjs";

const root = resolve(import.meta.dirname, "..");
const expected = new Map([
  ["WGhBnNhQNH3uVgP1", "shadow-raid-obscured-vision.webp"],
  ["j42JjZYGnRM1wf6R", "focusing-hum-protection.webp"],
  ["Qz16EDTu2GVTtUPV", "toxic-cloud-obscured-vision.webp"]
]);

test("compiled Effect pack contains three top-level Items with bundled WebP images", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const pack = manifest.packs.find(({ name }) => name === "zone-effects");
  assert.equal(pack.type, "Item");
  assert.equal(pack.system, "pf2e");

  const scratchRoot = join(root, "test-results");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "pf2e-zone-pack-"));
  try {
    const packCopy = join(scratch, "pack");
    cpSync(join(root, pack.path), packCopy, { recursive: true });
    const records = await compiledPackRecords(packCopy);
    assert.equal(records.length, expected.size);
    const sourceItems = new Map(
      readdirSync(join(root, "packs", "src", "zone-effects")).filter((name) => name.endsWith(".json")).map((name) => {
        const item = JSON.parse(readFileSync(join(root, "packs", "src", "zone-effects", name), "utf8"));
        return [item._id, item];
      })
    );

    for (const item of records) {
      const image = expected.get(item._id);
      assert.ok(image, `Unexpected Item ${item._id}`);
      assert.equal(item.type, "effect");
      assert.equal(item.folder, null);
      assert.equal(item.name, sourceItems.get(item._id)?.name);
      assert.deepEqual(item.system.rules, sourceItems.get(item._id)?.system.rules);
      assert.equal(item.img, `modules/pf2e-zone-automation/assets/effects/${image}`);
      const data = readFileSync(join(root, "assets", "effects", image));
      assert.equal(data.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(data.subarray(8, 12).toString("ascii"), "WEBP");
    }
  } finally {
    assert.ok(scratch.startsWith(`${scratchRoot}${sep}`));
    rmSync(scratch, { recursive: true, force: true });
  }
});
