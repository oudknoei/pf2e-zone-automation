import assert from "node:assert/strict";
import test from "node:test";

import { inspectEffectItem, validateEffectItems } from "../scripts/effect-items.js";

const effect = { documentName: "Item", type: "effect", name: "Ghonatine Stench", img: "stench.webp" };
const action = { documentName: "Item", type: "action", name: "Stench" };
const actor = { documentName: "Actor", name: "Ghonatine" };
const documents = new Map([
  ["Actor.ghonatine.Item.stench", effect],
  ["Compendium.pf2e.effects.Item.stench", effect],
  ["Actor.ghonatine.Item.action", action],
  ["Actor.ghonatine", actor]
]);
const resolver = async (uuid) => documents.get(uuid) ?? null;

test("Effect Items from Actor sheets and compendia resolve with name and image", async () => {
  for (const uuid of ["Actor.ghonatine.Item.stench", "Compendium.pf2e.effects.Item.stench"]) {
    assert.deepEqual(await inspectEffectItem(uuid, resolver), {
      uuid, name: "Ghonatine Stench", img: "stench.webp"
    });
  }
});

test("missing UUIDs, missing Items, and other document types are rejected", async () => {
  assert.match((await inspectEffectItem("", resolver)).error, /required/);
  assert.match((await inspectEffectItem("Item.gone", resolver)).error, /could not be found/);
  assert.match((await inspectEffectItem("Actor.ghonatine.Item.action", resolver)).error, /not a PF2e Effect Item/);
  assert.match((await inspectEffectItem("Actor.ghonatine", resolver)).error, /not a PF2e Effect Item/);
  assert.match((await inspectEffectItem("Item.error", async () => { throw Error("Unavailable"); })).error, /could not be found/);
});

test("effect validation points to the exact invalid result row", async () => {
  const config = { effects: [{ name: "Stench", outcomes: { noSave: { effects: [
    { uuid: "Actor.ghonatine.Item.stench" },
    { uuid: "Actor.ghonatine.Item.action" },
    { uuid: "Item.gone" }
  ] } } }] };
  const result = await validateEffectItems(config, resolver);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.issues.map((issue) => issue.target.effectIndex), [1, 2]);
  assert.ok(result.issues.every((issue) => issue.target.outcomeKey === "noSave"));
});
