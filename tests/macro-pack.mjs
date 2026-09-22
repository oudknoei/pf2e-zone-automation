import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { extractPack } from "@foundryvtt/foundryvtt-cli";

const root = resolve(import.meta.dirname, "..");
const expectedMacros = new Map([
  [
    "pzaOpenBuilder01",
    {
      name: "Open PF2e Zone Builder",
      image: "modules/pf2e-zone-automation/assets/macros/pf2e-zone-builder.webp",
      api: "openBuilder"
    }
  ],
  [
    "pzaShieldTaunt01",
    {
      name: "Shielding Taunt",
      image: "modules/pf2e-zone-automation/assets/macros/shielding-taunt.webp",
      api: "openShieldingTaunt"
    }
  ]
]);

test("compiled Macro pack provides the module hotbar macros", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const pack = manifest.packs.find(({ name }) => name === "zone-macros");
  assert.equal(pack.type, "Macro");

  const scratch = mkdtempSync(join(tmpdir(), "pf2e-zone-macro-pack-"));
  try {
    const packCopy = join(scratch, "pack");
    const destination = join(scratch, "extracted");
    cpSync(join(root, pack.path), packCopy, { recursive: true });
    await extractPack(packCopy, destination);
    const records = readdirSync(destination)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(destination, name), "utf8")));
    assert.equal(records.length, expectedMacros.size);

    for (const macro of records) {
      const expected = expectedMacros.get(macro._id);
      assert.ok(expected, `Unexpected macro ${macro._id}`);
      assert.equal(macro.name, expected.name);
      assert.equal(macro.type, "script");
      assert.equal(macro.ownership.default, 2);
      assert.equal(macro.img, expected.image);
      assert.match(macro.command, /game\.modules\.get\("pf2e-zone-automation"\)/);
      assert.match(macro.command, new RegExp(`await zoneModule\\.api\\.${expected.api}\\(\\)`));
    }

    const builderImage = readFileSync(join(root, "assets", "macros", "pf2e-zone-builder.webp"));
    assert.equal(builderImage.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(builderImage.subarray(8, 12).toString("ascii"), "WEBP");
    const tauntImage = readFileSync(join(root, "assets", "macros", "shielding-taunt.webp"));
    assert.equal(tauntImage.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(tauntImage.subarray(8, 12).toString("ascii"), "WEBP");
  } finally {
    assert.ok(scratch.startsWith(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
