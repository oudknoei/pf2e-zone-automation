import assert from "node:assert/strict";
import test from "node:test";
import { oncePerOperation } from "../scripts/request-cache.js";

const options = { key: "player:operation", fingerprint: "details", ttlMs: 100, reuseError: "Details changed." };

test("request cache reserves synchronously and joins concurrent and completed retries", async () => {
  const cache = new Map();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = oncePerOperation(cache, options, async () => { calls++; await gate; return { created: "zone" }; });
  assert.equal(cache.has(options.key), true);
  const second = oncePerOperation(cache, options, () => { throw new Error("Must not run"); });
  assert.equal(second, first);
  release();
  assert.deepEqual(await first, { created: "zone" });
  assert.equal(calls, 1);
  assert.equal(oncePerOperation(cache, options, () => null), first);
});

test("request cache rejects reuse with different details without disturbing the original request", async () => {
  const cache = new Map();
  const first = oncePerOperation(cache, options, () => "original");
  assert.throws(() => oncePerOperation(cache, { ...options, fingerprint: "changed" }, () => "changed"), /Details changed/);
  assert.equal(await first, "original");
  assert.equal(oncePerOperation(cache, options, () => "changed"), first);
});

test("request cache releases failed requests so an intentional retry can succeed", async () => {
  const cache = new Map();
  await assert.rejects(oncePerOperation(cache, options, () => { throw new Error("Save failed"); }), /Save failed/);
  assert.equal(cache.has(options.key), false);
  assert.equal(await oncePerOperation(cache, options, () => "retry"), "retry");
});

test("request cache expires completed results and keeps pending operations reserved", async () => {
  const nativeNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const cache = new Map();
    const first = oncePerOperation(cache, options, () => "first");
    await first;
    now += options.ttlMs;
    assert.equal(oncePerOperation(cache, options, () => "unused"), first);
    now++;
    assert.equal(await oncePerOperation(cache, options, () => "new"), "new");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = oncePerOperation(cache, { ...options, key: "pending" }, () => gate);
    now += 1000;
    assert.equal(oncePerOperation(cache, { ...options, key: "pending" }, () => "unused"), pending);
    release("finished");
    assert.equal(await pending, "finished");
  } finally { Date.now = nativeNow; }
});

test("request cache isolates users and action caches", async () => {
  const creation = new Map();
  const taunt = new Map();
  assert.equal(await oncePerOperation(creation, options, () => "zone"), "zone");
  assert.equal(await oncePerOperation(creation, { ...options, key: "other:operation" }, () => "other zone"), "other zone");
  assert.equal(await oncePerOperation(taunt, options, () => "taunt"), "taunt");
});
