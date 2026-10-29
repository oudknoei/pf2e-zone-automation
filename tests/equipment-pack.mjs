import assert from "node:assert/strict";
import {
  cpSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  rmSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { compiledPackRecords } from "./compiled-pack-records.mjs";

const root = resolve(import.meta.dirname, "..");
const expected = new Map([
  ["pzaSpellRing0001", {
    bonus: 1,
    level: 2,
    price: 35,
    rune: "DKWuJb2rSgiotOG7"
  }],
  ["pzaSpellRing0002", {
    bonus: 2,
    level: 10,
    price: 935,
    rune: "pOoEiuEuITm4I2Il"
  }],
  ["pzaSpellRing0003", {
    bonus: 3,
    level: 16,
    price: 8935,
    rune: "rvItjGQaYT7Luwtm"
  }]
]);

test("equipment compendium ships three worn, non-invested spell potency rings with rune pricing and a bundled icon", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const pack = manifest.packs.find(({ name }) => name === "zone-equipment");

  assert.ok(pack, "The equipment compendium must be registered");
  assert.equal(pack.type, "Item");
  assert.equal(pack.system, "pf2e");
  assert.equal(pack.path, "packs/zone-equipment");

  const sourceDirectory = join(root, "packs", "src", pack.name);
  const sources = readdirSync(sourceDirectory).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(sourceDirectory, name), "utf8")));

  assert.equal(sources.length, expected.size);
  assert.equal(new Set(sources.map(({ _id }) => _id)).size, expected.size);

  for (const source of sources) {
    assert.match(source._id, /^[A-Za-z0-9]{16}$/);
    assert.equal(source._key, `!items!${source._id}`);
  }

  const scratchRoot = join(root, "test-results");

  mkdirSync(scratchRoot, { recursive: true });

  const scratch = mkdtempSync(join(scratchRoot, "pf2e-equipment-pack-"));

  try {
    const packCopy = join(scratch, "pack");

    cpSync(join(root, pack.path), packCopy, { recursive: true });

    const records = await compiledPackRecords(packCopy);

    assert.equal(records.length, expected.size);
    assert.equal(new Set(records.map(({ _id }) => _id)).size, expected.size);

    for (const item of records) {
      const tier = expected.get(item._id);

      assert.ok(tier, `Unexpected Item ${item._id}`);
      assert.equal(item.name, `Spell Potency Ring (+${tier.bonus})`);
      assert.equal(item.type, "equipment");
      assert.equal(item.folder, null);
      assert.equal(item.system.level.value, tier.level);
      assert.deepEqual(item.system.price.value, { gp: tier.price });
      assert.equal(item.system.usage.value, "worn");
      assert.ok(item.system.traits.value.includes("magical"));
      assert.ok(!item.system.traits.value.includes("invested"));
      assert.match(item.system.description.value, new RegExp(`Compendium\\.pf2e\\.equipment-srd\\.Item\\.${tier.rune}`));
      assert.equal(item.system.rules.length, 1);

      const [rule] = item.system.rules;

      assert.equal(rule.key, "FlatModifier");
      assert.equal(rule.selector, "spell-attack-roll", "Spell DCs, damage, weapons, and impulses must not receive this bonus");
      assert.equal(rule.type, "item", "Multiple rings must use normal item bonus stacking");
      assert.equal(rule.value, tier.bonus);
      assert.equal(rule.requiresEquipped, true);
      assert.equal(rule.requiresInvestment, false);
      assert.ok(!rule.force, "The ring must not force its bonus to stack");

      const source = sources.find(({ _id }) => _id === item._id);

      assert.deepEqual(item.system, source.system, "The compiled item must match its source");
      assert.equal(item.img, "modules/pf2e-zone-automation/assets/equipment/spell-potency-ring.png");
    }

    const icon = readFileSync(join(root, "assets", "equipment", "spell-potency-ring.png"));

    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20), "The inventory icon must be square");
    assert.ok(icon.readUInt32BE(16) >= 256);
  } finally {
    assert.ok(scratch.startsWith(`${scratchRoot}${sep}`));
    rmSync(scratch, { recursive: true, force: true });
  }
});
