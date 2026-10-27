import { createRequire } from "node:module";

const dependencyRequire = createRequire(import.meta.resolve("@foundryvtt/foundryvtt-cli"));
const { ClassicLevel } = dependencyRequire("classic-level");

// The CLI's extractor starts an async iterator before awaiting the database open.
// Read the compiled top-level records directly, with explicit open/close lifetime.
export async function compiledPackRecords(path) {
  const database = new ClassicLevel(path, { keyEncoding: "utf8", valueEncoding: "json", createIfMissing: false });
  await database.open();
  try {
    return (await database.iterator().all())
      .filter(([key]) => /^![^.!]+![^!]+$/.test(key))
      .map(([, record]) => record);
  } finally { await database.close(); }
}
