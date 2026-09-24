import assert from "node:assert/strict";
import test from "node:test";
import { handleWorkerRequest } from "../scripts/worker.js";

const gm = { id: "gm", name: "GM", active: true, isGM: true };
const baseConfig = {
  mode: "emanation", radius: 5, targeting: { affects: "enemies", includeSelf: false },
  visibility: "all", duration: { type: "unlimited", rounds: 1 }, effects: []
};
const record = (id, name) => ({
  id, name, createdBy: { userId: gm.id, name: gm.name }, revision: 1,
  config: { ...baseConfig, name }
});
const folder = {
  id: "folder", name: "PF2e Zone Automation", type: "JournalEntry",
  getFlag: () => false
};
const page = {
  name: "Shared Zone Presets",
  getFlag: (_scope, key) => key === "pf2eZoneLibraryIndex",
  async update(changes) { this.html = changes["text.content"]; }
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
    recordId, expectedRevision, config: { ...baseConfig, name }
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
