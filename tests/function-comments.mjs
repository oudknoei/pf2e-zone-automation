import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set(["if", "for", "while", "switch", "catch", "else", "try"]);

function namedDeclarations(source) {
  const lines = source.split(/\r?\n/);
  const declarations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const functionMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    const methodMatch = line.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^\n]*\)\s*\{\s*$/);
    const arrowMatch = line.match(/^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()\n]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    const name = functionMatch?.[1] ?? methodMatch?.[1] ?? arrowMatch?.[1] ?? null;
    if (name && !ignored.has(name)) declarations.push({ index, name });
  }

  return { lines, declarations };
}

test("every named JavaScript function has a purpose comment", () => {
  const scripts = resolve(root, "scripts");
  const missing = [];

  for (const file of readdirSync(scripts).filter((name) => name.endsWith(".js"))) {
    const { lines, declarations } = namedDeclarations(readFileSync(resolve(scripts, file), "utf8"));
    for (const declaration of declarations) {
      let previous = declaration.index - 1;
      while (previous >= 0 && lines[previous].trim() === "") previous -= 1;
      if (previous < 0 || !lines[previous].trim().endsWith("*/")) {
        missing.push(`${file}:${declaration.index + 1} ${declaration.name}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});
