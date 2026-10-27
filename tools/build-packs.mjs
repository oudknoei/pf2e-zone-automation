import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
const macroSource = join(moduleRoot, "packs", "src", "zone-macros");
const macroIds = new Set();
const macroNames = new Set();
for (const file of readdirSync(macroSource, { recursive: true }).filter((name) => name.endsWith(".json"))) {
  const macro = JSON.parse(readFileSync(join(macroSource, file), "utf8"));
  if (!/^[A-Za-z0-9]{16}$/.test(macro._id) || macro._key !== `!macros!${macro._id}`) {
    throw new Error(`${file}: macros require a stable 16-character Foundry ID and matching database key`);
  }
  if (macroIds.has(macro._id) || macroNames.has(macro.name)) {
    throw new Error(`${file}: duplicate macro ID or name`);
  }
  macroIds.add(macro._id);
  macroNames.add(macro.name);
}

for (const packName of ["zone-effects", "zone-macros", "zone-equipment"]) {
  const source = fileURLToPath(new URL(`../packs/src/${packName}/`, import.meta.url));
  const destination = fileURLToPath(new URL(`../packs/${packName}/`, import.meta.url));
  if (resolve(destination) !== resolve(join(moduleRoot, "packs", packName))) {
    throw new Error("Refusing to remove an unexpected pack path");
  }
  rmSync(destination, { recursive: true, force: true });
  await compilePack(source, destination, { log: true, recursive: true });
}
