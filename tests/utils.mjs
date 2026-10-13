import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { cloneData, escapeHtml, isGMAuthoredMessage, localize, newDocumentId, newOperationId, randomId, readDocumentFlag, titleCase } from "../scripts/utils.js";

test("shared HTML escaping preserves names in text and attributes without creating markup", () => {
  const value = `<Hero & "friend" 'ally'>`;
  const document = new JSDOM(`<div data-name="${escapeHtml(value)}">${escapeHtml(value)}</div>`).window.document;
  const element = document.querySelector("div");
  assert.equal(element.textContent, value);
  assert.equal(element.dataset.name, value);
  assert.equal(element.children.length, 0);
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
});

test("shared cloning isolates nested configuration in native and compatibility paths", () => {
  const original = { effects: [{ name: "Stench", duration: { value: 2 } }] };
  const nativeClone = globalThis.structuredClone;
  try {
    for (const implementation of [nativeClone, undefined]) {
      globalThis.structuredClone = implementation;
      const copy = cloneData(original);
      assert.deepEqual(copy, original);
      copy.effects[0].duration.value = 9;
      assert.equal(original.effects[0].duration.value, 2);
    }
  } finally {
    globalThis.structuredClone = nativeClone;
  }
});

test("shared labels use translated text or caller fallbacks while leaving slugs intact", () => {
  globalThis.game = { i18n: { localize: (key) => key === "translated" ? "Translated" : key === "empty" ? "" : key } };
  assert.equal(localize("translated", "Fallback"), "Translated");
  assert.equal(localize("unknown", "Custom"), "Custom");
  assert.equal(localize("empty", "Custom"), "Custom");
  assert.equal(localize(null, "Custom"), "Custom");
  assert.equal(titleCase("mental-damage"), "Mental Damage");
  assert.equal(titleCase(null), "");
});

test("shared identifiers preserve native lengths and the existing UUID fallbacks", () => {
  const calls = [];
  globalThis.foundry = { utils: { randomID: (length) => { calls.push(length); return "A".repeat(length); } } };
  assert.equal(randomId(8).length, 8);
  assert.equal(randomId().length, 12);
  assert.equal(newOperationId().length, 20);
  assert.equal(newDocumentId().length, 16);
  assert.deepEqual(calls, [8, 12, 20, 16]);
  delete globalThis.foundry;
  assert.equal(randomId(8).length, 8);
  assert.equal(randomId().length, 12);
  assert.match(newOperationId(), /^[a-f0-9-]{36}$/);
  assert.match(newDocumentId(), /^[a-f0-9]{16}$/);
});

test("shared document flags support live documents, source data, and absent flags", () => {
  const marker = { operationId: "operation" };
  assert.equal(readDocumentFlag({ getFlag: () => marker }, "world", "flag"), marker);
  assert.equal(readDocumentFlag({ flags: { world: { flag: marker } } }, "world", "flag"), marker);
  assert.equal(readDocumentFlag({ getFlag: () => null, flags: { world: { flag: marker } } }, "world", "flag"), marker);
  assert.equal(readDocumentFlag(null, "world", "flag"), null);
  assert.equal(readDocumentFlag({}, "world", "flag"), null);
});

test("chat authorship uses world roles and canonical author precedence while preserving legacy cards", () => {
  const gm = { id: "gm", isGM: true, active: false };
  const player = { id: "player", isGM: false };
  globalThis.game = { users: { get: (id) => [gm, player].find((user) => user.id === id) } };
  for (const card of [{ author: gm }, { author: gm.id }, { user: gm }, { user: gm.id }]) {
    assert.equal(isGMAuthoredMessage(card), true);
  }
  for (const card of [null, {}, { author: player, user: gm }, { author: null, user: gm },
    { author: { id: player.id, isGM: true } }, { author: { id: "unknown", isGM: true } }]) {
    assert.equal(isGMAuthoredMessage(card), false);
  }
  player.isGM = true;
  assert.equal(isGMAuthoredMessage({ author: player.id }), true);
  gm.isGM = false;
  assert.equal(isGMAuthoredMessage({ user: gm.id }), false);
});
