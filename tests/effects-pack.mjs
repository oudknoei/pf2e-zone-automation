import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { extractPack } from "@foundryvtt/foundryvtt-cli";

const root = resolve(import.meta.dirname, "..");
const expected = new Map([
  ["WGhBnNhQNH3uVgP1", "shadow-raid-obscured-vision.png"],
  ["j42JjZYGnRM1wf6R", "focusing-hum-protection.png"],
  ["Qz16EDTu2GVTtUPV", "toxic-cloud-obscured-vision.png"]
]);

test("compiled Effect pack contains three Items with bundled PNG images", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const pack = manifest.packs.find(({ name }) => name === "zone-effects");
  assert.equal(pack.type, "Item");
  assert.equal(pack.system, "pf2e");

  const scratch = mkdtempSync(join(tmpdir(), "pf2e-zone-pack-"));
  try {
    const packCopy = join(scratch, "pack");
    const destination = join(scratch, "extracted");
    cpSync(join(root, pack.path), packCopy, { recursive: true });
    await extractPack(packCopy, destination, { folders: true });
    const folders = readdirSync(destination, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.equal(folders.length, 1);
    const folderPath = join(destination, folders[0].name);
    const folder = JSON.parse(readFileSync(join(folderPath, "_Folder.json"), "utf8"));
    assert.equal(folder.name, "PF2e Zone Automation");
    assert.equal(folder.type, "Item");
    assert.equal(folder._id, "pzaZoneEffects01");
    const records = readdirSync(folderPath)
      .filter((name) => name.endsWith(".json") && name !== "_Folder.json")
      .map((name) => JSON.parse(readFileSync(join(folderPath, name), "utf8")));
    assert.equal(records.length, expected.size);
    const sourcePath = join(root, "packs", "src", "zone-effects", "pf2e-zone-automation");
    const sourceItems = new Map(
      readdirSync(sourcePath).filter((name) => name.endsWith(".json") && name !== "_Folder.json").map((name) => {
        const item = JSON.parse(readFileSync(join(sourcePath, name), "utf8"));
        return [item._id, item];
      })
    );

    for (const item of records) {
      const image = expected.get(item._id);
      assert.ok(image, `Unexpected Item ${item._id}`);
      assert.equal(item.type, "effect");
      assert.equal(item.folder, folder._id);
      assert.equal(item.name, sourceItems.get(item._id)?.name);
      assert.deepEqual(item.system.rules, sourceItems.get(item._id)?.system.rules);
      assert.equal(item.img, `modules/pf2e-zone-automation/assets/effects/${image}`);
      const data = readFileSync(join(root, "assets", "effects", image));
      assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    }
  } finally {
    assert.ok(scratch.startsWith(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
