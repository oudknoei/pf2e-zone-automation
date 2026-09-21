import assert from "node:assert/strict";
import { cpSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { extractPack } from "@foundryvtt/foundryvtt-cli";

const root = resolve(import.meta.dirname, "..");
const macroId = "pzaOpenBuilder01";
const macroImage = "modules/pf2e-zone-automation/assets/macros/pf2e-zone-builder.webp";

test("compiled Macro pack provides the Zone Builder hotbar macro", async () => {
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
    assert.equal(records.length, 1);

    const macro = records[0];
    assert.equal(macro._id, macroId);
    assert.equal(macro.name, "Open PF2e Zone Builder");
    assert.equal(macro.type, "script");
    assert.equal(macro.ownership.default, 2);
    assert.equal(macro.img, macroImage);
    assert.match(macro.command, /game\.modules\.get\("pf2e-zone-automation"\)/);
    assert.match(macro.command, /await zoneModule\.api\.openBuilder\(\)/);

    const image = readFileSync(join(root, "assets", "macros", "pf2e-zone-builder.webp"));
    assert.equal(image.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(image.subarray(8, 12).toString("ascii"), "WEBP");
  } finally {
    assert.ok(scratch.startsWith(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  }
});