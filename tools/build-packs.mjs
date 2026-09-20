import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../packs/src/zone-effects/", import.meta.url));
const destination = fileURLToPath(new URL("../packs/zone-effects/", import.meta.url));

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
if (resolve(destination) !== resolve(join(moduleRoot, "packs", "zone-effects"))) {
  throw new Error("Refusing to remove an unexpected pack path");
}
rmSync(destination, { recursive: true, force: true });
await compilePack(source, destination, { log: true, recursive: true });
