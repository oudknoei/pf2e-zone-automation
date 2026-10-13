import assert from "node:assert/strict";
import test from "node:test";
import { handleWorkerRequest } from "../scripts/worker.js";

const gm = { id: "gm", name: "GM", active: true, isGM: true };
const actor = { uuid: "Actor.source", name: "Source" };
globalThis.fromUuid = async (uuid) => uuid === actor.uuid ? actor : null;
const baseConfig = {
  mode: "emanation", radius: 5, targeting: { affects: "enemies", includeSelf: false },
  visibility: "all", duration: { type: "unlimited", rounds: 1 },
  effects: [{ name: "Alert", triggers: { activation: true }, chatAlert: { enabled: true, text: "Alert" } }]
};
const record = (id, name) => ({
  id, name, createdBy: { userId: gm.id, name: gm.name }, revision: 1,
  config: { ...baseConfig, name }
});
const folder = {
  id: "folder", name: "PF2e Zone Automation", type: "JournalEntry",
  getFlag: () => false
};
let failNextIndexUpdate = false;
const page = {
  name: "Shared Zone Presets",
  getFlag: (_scope, key) => key === "pf2eZoneLibraryIndex",
  async update(changes) {
    if (failNextIndexUpdate) {
      failNextIndexUpdate = false;
      throw new Error("Simulated index page update failure");
    }
    this.html = changes["text.content"];
  }
};
const firstWriteStarted = Promise.withResolvers();
const releaseFirstWrite = Promise.withResolvers();
let updateCalls = 0;
let replacementCalls = 0;
let failNextUpdate = false;
const journal = {
  id: "library", folder: folder.id, pages: [page],
  flags: { world: { pf2eZoneLibrary: { schemaVersion: 1, zones: {
    first: record("first", "First old"),
    second: record("second", "Second old")
  } } } },
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
  async update(changes) {
    updateCalls++;
    const replacement = changes["flags.world.pf2eZoneLibrary"];
    assert.equal(replacement?.kind, "replacement", "the whole flag must be replaced in one update");
    replacementCalls++;
    if (updateCalls === 1) {
      firstWriteStarted.resolve();
      await releaseFirstWrite.promise;
    }
    if (failNextUpdate) {
      failNextUpdate = false;
      throw new Error("Simulated Journal write failure");
    }
    this.flags.world.pf2eZoneLibrary = structuredClone(replacement.value);
  },
  async unsetFlag() { assert.fail("Library writes must not unset the flag first"); },
  async setFlag() { assert.fail("Library writes must not set the flag in a second update"); }
};

globalThis._replace = (value) => ({ kind: "replacement", value });
globalThis.foundry = { utils: {} };
globalThis.CONST = { JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
globalThis.game = {
  system: { id: "pf2e" }, user: gm, users: new Map([[gm.id, gm]]),
  folders: [folder], journal: [journal]
};

function save(recordId, expectedRevision, name) {
  return handleWorkerRequest({
    protocol: 1, action: "library-save", requesterUserId: gm.id,
    recordId, expectedRevision, sourceActorUuid: actor.uuid, config: { ...baseConfig, name }
  });
}

test("concurrent preset saves preserve both changes and reject stale revisions", { timeout: 3000 }, async () => {
  const firstSave = save("first", 1, "First new");
  await firstWriteStarted.promise;
  const secondSave = save("second", 1, "Second new");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updateCalls, 1, "the second save waits for the first write to finish");

  releaseFirstWrite.resolve();
  const [first, second] = await Promise.all([firstSave, secondSave]);
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  const zones = journal.getFlag("world", "pf2eZoneLibrary").zones;
  assert.equal(zones.first.name, "First new");
  assert.equal(zones.second.name, "Second new");
  assert.equal(zones.first.revision, 2);
  assert.equal(zones.second.revision, 2);
  assert.equal(replacementCalls, 2);
  assert.match(page.html, /First new/);
  assert.match(page.html, /Second new/);

  const priorError = console.error;
  let stale;
  let missingRevision;
  try {
    console.error = () => {};
    stale = await save("first", 1, "Stale change");
    missingRevision = await save("first", null, "Unversioned change");
  } finally {
    console.error = priorError;
  }
  assert.equal(stale.ok, false);
  assert.match(stale.error, /changed since you opened it/);
  assert.equal(missingRevision.ok, false);
  assert.equal(zones.first.name, "First new");
  assert.equal(updateCalls, 2, "conflicts never reach persistence");

  let staleDelete;
  try {
    console.error = () => {};
    staleDelete = await handleWorkerRequest({
      protocol: 1, action: "library-delete", requesterUserId: gm.id,
      recordId: "first", expectedRevision: 1
    });
  } finally {
    console.error = priorError;
  }
  assert.equal(staleDelete.ok, false);
  assert.match(staleDelete.error, /changed since you opened the list/);
  assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones.first.name, "First new");

  const deleted = await handleWorkerRequest({
    protocol: 1, action: "library-delete", requesterUserId: gm.id,
    recordId: "first", expectedRevision: 2
  });
  assert.equal(deleted.ok, true, deleted.error);
  assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones.first, undefined);
  assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones.second.name, "Second new");
  assert.doesNotMatch(page.html, /First new/);
});

test("a failed library write does not block the next save", async () => {
  failNextUpdate = true;
  const priorError = console.error;
  let failed;
  try {
    console.error = () => {};
    failed = await save("second", 2, "Will fail");
  } finally {
    console.error = priorError;
  }
  assert.equal(failed.ok, false);
  assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones.second.name, "Second new");

  const retry = await save("second", 2, "Recovered");
  assert.equal(retry.ok, true, retry.error);
  assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones.second.name, "Recovered");
});

test("an index failure reports the committed preset and a retry updates that same record", async () => {
  const priorWarn = console.warn;
  console.warn = () => {};
  try {
    failNextIndexUpdate = true;
    const saved = await save(null, null, "Index update delayed");
    assert.equal(saved.ok, true, saved.error);
    assert.match(saved.warnings[0], /was saved/);
    const recordId = saved.record.id;
    assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones[recordId].revision, 1);
    assert.doesNotMatch(page.html, /Index update delayed/);

    const recordCount = Object.keys(journal.getFlag("world", "pf2eZoneLibrary").zones).length;
    const retry = await save(recordId, saved.record.revision, "Index now current");
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.record.id, recordId);
    assert.equal(retry.record.revision, 2);
    assert.equal(Object.keys(journal.getFlag("world", "pf2eZoneLibrary").zones).length, recordCount);
    assert.match(page.html, /Index now current/);

    failNextIndexUpdate = true;
    const deleted = await handleWorkerRequest({
      protocol: 1, action: "library-delete", requesterUserId: gm.id,
      recordId, expectedRevision: retry.record.revision
    });
    assert.equal(deleted.ok, true, deleted.error);
    assert.match(deleted.warnings[0], /was saved/);
    assert.equal(journal.getFlag("world", "pf2eZoneLibrary").zones[recordId], undefined);
  } finally {
    failNextIndexUpdate = false;
    console.warn = priorWarn;
  }
});

test("a malformed preset cannot bypass builder validation through the GM worker", async () => {
  const before = updateCalls;
  const priorError = console.error;
  let result;
  try {
    console.error = () => {};
    result = await handleWorkerRequest({
      protocol: 1, action: "library-save", requesterUserId: gm.id,
      sourceActorUuid: actor.uuid, recordId: "second", expectedRevision: 3,
      config: { ...baseConfig, name: "Invalid", effects: [{ name: "No Trigger" }] }
    });
  } finally {
    console.error = priorError;
  }
  assert.equal(result.ok, false);
  assert.match(result.error, /select at least one trigger/);
  assert.equal(updateCalls, before);
});

let saveOperationCounter = 0;

function saveFixture() {
  const priorConsole = { error: console.error, warn: console.warn };
  const prior = Object.fromEntries(["game", "fromUuid", "foundry", "_replace", "CONFIG", "CONST"].map((key) => [key, globalThis[key]]));
  const user = { id: "save-player", name: "Player", active: true, isGM: false };
  const gmUser = { id: "save-gm", name: "GM", active: true, isGM: true };
  const source = { uuid: "Actor.save-source", name: "Source", testUserPermission: () => true };
  const f = { user, gm: gmUser, source, writes: 0, indexWrites: 0 };
  const index = { name: "Shared Zone Presets", getFlag: () => true, async update() {
    f.indexWrites++;
    if (f.failIndex) throw new Error("Index failed");
  } };
  const library = {
    id: "save-library", folder: folder.id, pages: [index],
    flags: { world: { pf2eZoneLibrary: { schemaVersion: 1, zones: {
      existing: { ...record("existing", "Existing"), createdBy: { userId: user.id, name: user.name } }
    } } } },
    getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
    async update(changes) {
      f.writes++;
      const replacement = changes["flags.world.pf2eZoneLibrary"];
      assert.equal(replacement.kind, "replacement");
      await f.beforeWrite?.(replacement.value);
      if (f.cancelWrite) return null;
      this.flags.world.pf2eZoneLibrary = structuredClone(replacement.value);
      await f.afterWrite?.();
      return this;
    }
  };
  f.library = library;
  f.data = () => library.getFlag("world", "pf2eZoneLibrary");
  f.request = {
    protocol: 1, action: "library-save", requesterUserId: user.id,
    operationId: `preset-retry-${++saveOperationCounter}`, sourceActorUuid: source.uuid,
    recordId: null, expectedRevision: null, config: { ...structuredClone(baseConfig), name: "Saved once" }
  };
  globalThis.game = { system: { id: "pf2e" }, user: gmUser, users: new Map([[user.id, user], [gmUser.id, gmUser]]),
    folders: [folder], journal: [library] };
  game.users.activeGM = gmUser;
  globalThis.fromUuid = async (uuid) => uuid === source.uuid ? source : null;
  globalThis.foundry = { utils: {} };
  globalThis._replace = (value) => ({ kind: "replacement", value });
  globalThis.CONFIG = { PF2E: { conditionTypes: {}, damageTypes: {} } };
  globalThis.CONST = { JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
  f.run = async (request = f.request, worker = handleWorkerRequest) => {
    const previousError = console.error;
    const previousWarn = console.warn;
    console.error = console.warn = () => {};
    try { return await worker(request); }
    finally { console.error = previousError; console.warn = previousWarn; }
  };
  f.fresh = async (suffix = "reload") => (await import(`../scripts/worker.js?${suffix}=${f.request.operationId}`)).handleWorkerRequest;
  f.restore = () => {
    console.error = priorConsole.error;
    console.warn = priorConsole.warn;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  };
  return f;
}

for (const overwrite of [false, true]) {
  test(`duplicate ${overwrite ? "overwrite" : "Save As"} operations join one atomic preset and receipt update`, async () => {
    const f = saveFixture();
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    if (overwrite) Object.assign(f.request, { recordId: "existing", expectedRevision: 1 });
    f.beforeWrite = async (data) => {
      const receipt = data.saveOperations[`${f.user.id}:${f.request.operationId}`];
      assert.equal(data.zones[receipt.record.id].revision, overwrite ? 2 : 1);
      assert.equal(receipt.record.config.name, "Saved once");
      started.resolve();
      await gate.promise;
    };
    try {
      const first = f.run();
      await started.promise;
      const second = f.run(structuredClone(f.request));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.writes, 1);
      gate.resolve();
      const results = await Promise.all([first, second]);
      assert.equal(results[0].ok, true, results[0].error);
      assert.deepEqual(results[1], results[0]);
      assert.equal(results[0].record.revision, overwrite ? 2 : 1);
      assert.equal(f.writes, 1);
      assert.equal(Object.keys(f.data().saveOperations).length, 1);
    } finally { gate.resolve(); f.restore(); }
  });

  test(`a committed ${overwrite ? "overwrite" : "Save As"} with a lost acknowledgment recovers its original revision after refresh`, async () => {
    const f = saveFixture();
    if (overwrite) Object.assign(f.request, { recordId: "existing", expectedRevision: 1 });
    f.afterWrite = () => { throw new Error("Lost acknowledgment after commit"); };
    try {
      const original = await f.run();
      assert.equal(original.ok, true, original.error);
      assert.equal(original.record.revision, overwrite ? 2 : 1);
      const fresh = await f.fresh();
      assert.deepEqual(await f.run(f.request, fresh), original);
      assert.equal(f.writes, 1);
      assert.equal(Object.keys(f.data().zones).length, overwrite ? 1 : 2);
    } finally { f.restore(); }
  });
}

for (const cancelled of [false, true]) {
  test(`an ${cancelled ? "uncommitted cancellation" : "unconfirmed write failure"} preserves retry identity without claiming success`, async () => {
    const f = saveFixture();
    if (cancelled) f.cancelWrite = true;
    else f.beforeWrite = () => { throw new Error("No confirmed commit"); };
    try {
      const failed = await f.run();
      assert.equal(failed.ok, false);
      assert.equal(failed.retryable, true);
      assert.equal(failed.errorCode, "PF2E_ZONE_PRESET_SAVE_UNCERTAIN");
      assert.equal(Object.keys(f.data().zones).length, 1);
      f.cancelWrite = false;
      f.beforeWrite = null;
      const retry = await f.run();
      assert.equal(retry.ok, true, retry.error);
      assert.equal(retry.record.revision, 1);
      assert.equal(f.writes, 2);
      assert.equal(Object.keys(f.data().zones).length, 2);
    } finally { f.restore(); }
  });
}

for (const [name, change] of [
  ["record identity", (request) => { request.recordId = "existing"; }],
  ["expected revision", (request) => { request.expectedRevision = 2; }],
  ["source Actor", (request) => { request.sourceActorUuid = "Actor.other"; }],
  ["configuration", (request) => { request.config.name = "Changed replay"; }]
]) {
  test(`saved preset operations reject changed ${name} in cached and refreshed workers`, async () => {
    const f = saveFixture();
    try {
      assert.equal((await f.run()).ok, true);
      const changed = structuredClone(f.request);
      change(changed);
      for (const worker of [handleWorkerRequest, await f.fresh()]) {
        const rejected = await f.run(changed, worker);
        assert.equal(rejected.ok, false);
        assert.match(rejected.error, /reused with different save details/);
        assert.equal(rejected.retryable, undefined);
      }
      assert.equal(f.writes, 1);
    } finally { f.restore(); }
  });
}

test("late save retries return the historical result after a newer overwrite, deletion, and cache expiry", async () => {
  const f = saveFixture();
  const priorNow = Date.now;
  try {
    const original = await f.run();
    assert.equal(original.ok, true, original.error);
    const updated = await f.run({ ...f.request, operationId: `${f.request.operationId}-newer`,
      recordId: original.record.id, expectedRevision: 1, config: { ...f.request.config, name: "Newer revision" } });
    assert.equal(updated.ok, true, updated.error);
    const fresh = await f.fresh();
    assert.deepEqual(await f.run(f.request, fresh), original);
    assert.equal(f.data().zones[original.record.id].revision, 2);
    assert.equal(f.data().zones[original.record.id].name, "Newer revision");
    const deleted = await f.run({ protocol: 1, action: "library-delete", requesterUserId: f.user.id,
      recordId: updated.record.id, expectedRevision: 2 });
    assert.equal(deleted.ok, true, deleted.error);
    assert.equal(f.data().zones[original.record.id], undefined);
    Date.now = () => priorNow() + 11 * 60 * 1000;
    assert.deepEqual(await f.run(), original);
    assert.deepEqual(await f.run(f.request, await f.fresh("deleted")), original);
    assert.equal(f.data().zones[original.record.id], undefined);
    assert.equal(f.writes, 3);
    assert.equal(Object.keys(f.data().saveOperations).length, 2);
  } finally { Date.now = priorNow; f.restore(); }
});

test("operation recovery does not revalidate changed Actor ownership or deleted effect references", async () => {
  const f = saveFixture();
  try {
    const original = await f.run();
    assert.equal(original.ok, true, original.error);
    f.source.testUserPermission = () => false;
    globalThis.fromUuid = () => assert.fail("A completed save needs no new Actor or Item validation");
    assert.deepEqual(await f.run(f.request, await f.fresh()), original);
    assert.equal(f.writes, 1);
  } finally { f.restore(); }
});

test("ordinary rejected saves remain distinct from unconfirmed writes", async () => {
  const f = saveFixture();
  try {
    f.source.testUserPermission = () => false;
    const unauthorized = await f.run();
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.retryable, undefined);
    assert.match(unauthorized.error, /does not own/);
    f.source.testUserPermission = () => true;
    const conflict = await f.run({ ...f.request, recordId: "existing", expectedRevision: 99 });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.retryable, undefined);
    assert.match(conflict.error, /changed since you opened/);
    assert.equal(f.writes, 0);
    assert.equal((await f.run()).ok, true, "Rejected reservations must be released");
  } finally { f.restore(); }
});

for (const missing of [false, true]) {
  test(`${missing ? "missing" : "incomplete"} preset receipts fail safely rather than creating another copy`, async () => {
    const f = saveFixture();
    try {
      const original = await f.run();
      assert.equal(original.ok, true, original.error);
      const key = `${f.user.id}:${f.request.operationId}`;
      if (missing) delete f.data().saveOperations[key];
      else delete f.data().saveOperations[key].fingerprint;
      const retry = await f.run(f.request, await f.fresh());
      assert.equal(retry.ok, false);
      assert.match(retry.error, /cannot be verified.*Review the saved zones/);
      assert.equal(f.writes, 1);
      assert.equal(Object.keys(f.data().zones).length, 2);
    } finally { f.restore(); }
  });
}

test("queued preset saves freeze their request before another save finishes", async () => {
  const f = saveFixture();
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  f.beforeWrite = async () => { if (f.writes === 1) { started.resolve(); await gate.promise; } };
  try {
    const first = f.run();
    await started.promise;
    const request = { ...structuredClone(f.request), operationId: `${f.request.operationId}-second`, config: { ...f.request.config, name: "Queued original" } };
    const frozen = structuredClone(request);
    const second = f.run(request);
    request.config.name = "Changed during queue";
    gate.resolve();
    assert.equal((await first).ok, true);
    const result = await second;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.record.name, "Queued original");
    assert.deepEqual(await f.run(frozen, await f.fresh()), result);
    assert.equal(f.writes, 2);
  } finally { gate.resolve(); f.restore(); }
});

test("independent workers use the same Save As identity when an older write is still unconfirmed", async () => {
  const f = saveFixture();
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  f.beforeWrite = async () => { if (f.writes === 1) { started.resolve(); await gate.promise; } };
  try {
    const first = f.run(f.request, await f.fresh("old-tab"));
    await started.promise;
    const second = await f.run(f.request, await f.fresh("new-tab"));
    assert.equal(second.ok, true, second.error);
    gate.resolve();
    const original = await first;
    assert.equal(original.ok, true, original.error);
    assert.equal(original.record.id, second.record.id);
    assert.equal(Object.keys(f.data().zones).length, 2);
    assert.equal(Object.keys(f.data().saveOperations).length, 1);
    assert.equal(f.data().zones[original.record.id].revision, 1);
  } finally { gate.resolve(); f.restore(); }
});

test("an index failure reports a committed save and preserves its completion through the next library mutation", async () => {
  const f = saveFixture();
  f.failIndex = true;
  try {
    const original = await f.run();
    assert.equal(original.ok, true, original.error);
    assert.match(original.warnings[0], /was saved/);
    f.failIndex = false;
    assert.equal((await f.run({ ...f.request, operationId: `${f.request.operationId}-second` })).ok, true);
    const retry = await f.run(f.request, await f.fresh());
    assert.equal(retry.ok, true, retry.error);
    assert.deepEqual(retry.record, original.record);
    assert.equal(f.writes, 2);
  } finally { f.restore(); }
});

test("preset operation identities are isolated by requester and survive a GM handoff", async () => {
  const f = saveFixture();
  try {
    const original = await f.run();
    const other = await f.run({ ...f.request, requesterUserId: f.gm.id });
    assert.equal(original.ok, true, original.error);
    assert.equal(other.ok, true, other.error);
    assert.notEqual(original.record.id, other.record.id);
    game.user = { ...f.gm, id: "new-gm" };
    game.users.set(game.user.id, game.user);
    game.users.activeGM = game.user;
    assert.deepEqual(await f.run(f.request, await f.fresh()), original);
    assert.equal(f.writes, 2);
  } finally { f.restore(); }
});
