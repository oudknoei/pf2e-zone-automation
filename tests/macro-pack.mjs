import assert from "node:assert/strict";
import { cpSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { compiledPackRecords } from "./compiled-pack-records.mjs";

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
  ],
  [
    "pzaHeroPoints001",
    {
      name: "Set Hero Points",
      image: "modules/pf2e-zone-automation/assets/macros/SetHeroPoints.webp",
      api: "promptSetHeroPoints"
    }
  ],
  ["pzaSessionNote01", { name: "Session Notes", image: "icons/svg/book.svg", api: "openSessionNotes", ownership: 0 }],
  ["pzaQuickNote0001", { name: "Quick Note", image: "icons/svg/scroll.svg", api: "openQuickNote", ownership: 0 }]
]);

test("compiled Macro pack provides the module hotbar macros", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const pack = manifest.packs.find(({ name }) => name === "zone-macros");
  assert.equal(pack.type, "Macro");

  const scratchRoot = join(root, "test-results");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "pf2e-zone-macro-pack-"));
  try {
    const packCopy = join(scratch, "pack");
    cpSync(join(root, pack.path), packCopy, { recursive: true });
    const records = await compiledPackRecords(packCopy);
    assert.equal(records.length, expectedMacros.size);
    assert.equal(new Set(records.map((macro) => macro.name)).size, records.length, "Macro names must be unique");
    assert.equal(records.filter((macro) => macro.name === "Set Hero Points").length, 1);

    for (const macro of records) {
      const expected = expectedMacros.get(macro._id);
      assert.ok(expected, `Unexpected macro ${macro._id}`);
      assert.match(macro._id, /^[A-Za-z0-9]{16}$/, "Foundry document IDs must have 16 characters");
      assert.equal(macro.name, expected.name);
      assert.equal(macro.type, "script");
      assert.equal(macro.ownership.default, expected.ownership ?? 2);
      assert.equal(macro.img, expected.image);
      assert.match(macro.command, /game\.modules\.get\("pf2e-zone-automation"\)/);
      assert.match(macro.command, new RegExp(`await zoneModule\\.api\\.${expected.api}\\(\\)`));
    }

    for (const { image } of expectedMacros.values()) {
      if (!image.startsWith("modules/pf2e-zone-automation/")) continue;
      const imagePath = image.replace("modules/pf2e-zone-automation/", "");
      const imageData = readFileSync(join(root, imagePath));
      assert.equal(imageData.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(imageData.subarray(8, 12).toString("ascii"), "WEBP");
    }
  } finally {
    assert.ok(scratch.startsWith(`${scratchRoot}${sep}`));
    rmSync(scratch, { recursive: true, force: true });
  }
});
