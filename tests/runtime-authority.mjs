import assert from "node:assert/strict";
import test from "node:test";
import { zoneRuntimeEntrypoint } from "../scripts/runtime.js";

const gm = { id: "gm", isGM: true };
const otherGM = { id: "other-gm", isGM: true };
const hooks = new Map();
globalThis.Hooks = {
  on(name, callback) { hooks.set(name, callback); return name; },
  off(name) { hooks.delete(name); }
};
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.foundry = { utils: {
  getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object),
  setProperty(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    for (const key of keys) object = object[key] ??= {};
    object[last] = value;
  }
} };
globalThis._replace = (payload) => payload;
globalThis.ui = { notifications: { error: assert.fail, warn: assert.fail } };
globalThis.ChatMessage = { create: assert.fail, getSpeaker: () => ({}) };

function gate() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}

async function fixture(t) {
  globalThis.PF2EZoneRuntime?.teardownHooks();
  delete globalThis.PF2EZoneRuntime;
  const regions = new Map();
  const scene = { id: "scene", regions, tokens: [] };
  regions.contents = [];
  globalThis.game = {
    user: gm, users: { activeGM: gm }, time: { worldTime: 0 },
    actors: { contents: [] }, scenes: { contents: [], get: id => id === scene.id ? scene : null }
  };
  globalThis.fromUuid = async () => null;
  globalThis.ChatMessage.create = assert.fail;
  const runtime = await zoneRuntimeEntrypoint();
  clearTimeout(runtime.authorityRecoveryTimer);
  runtime.authorityRecoveryTimer = null;
  t.after(() => runtime.teardownHooks());
  let stored = {
    config: { name: "Test Zone", mode: "area", effects: [] },
    state: { activationProcessed: true, sourceActorUuid: "Actor.source" }
  };
  const writes = [];
  const region = {
    id: "zone", uuid: "Scene.scene.Region.zone", name: "Test Zone", parent: scene,
    getFlag: () => stored,
    async update(changes) {
      stored = structuredClone(changes["flags.world.pf2eZone"]);
      writes.push(stored);
    },
    async delete() { regions.delete(this.id); }
  };
  regions.set(region.id, region);
  regions.contents.push(region);
  game.scenes.contents.push(scene);
  stored = runtime.readPayload(region);
  return { runtime, region, scene, writes, get stored() { return stored; } };
}

function handoff() { game.users.activeGM = otherGM; }

test("queued Region turn events stop after handoff and the new GM can run fresh work", async t => {
  const f = await fixture(t);
  const blocked = gate();
  f.runtime.locks.set(f.region.uuid, blocked.promise);
  let triggers = 0;
  f.runtime.eligible = async () => true;
  f.runtime.processTriggerUnlocked = async (_region, payload) => {
    triggers++;
    payload.state.marker = "new GM";
  };
  const context = { region: f.region, event: { name: "tokenTurnEnd", data: { token: { uuid: "Token.target" } } } };
  const queued = f.runtime.handleRegionEvent(context);
  handoff();
  blocked.release();
  await queued;
  assert.equal(triggers, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.runtime.locks.size, 0);
  game.user = otherGM;
  await f.runtime.handleRegionEvent(context);
  assert.equal(triggers, 1);
  assert.equal(f.stored.state.marker, "new GM");
});

test("a handoff away and back still invalidates earlier queued transactions", async t => {
  const f = await fixture(t);
  const blocked = gate();
  f.runtime.locks.set(f.region.uuid, blocked.promise);
  const queued = f.runtime.withState(f.region, () => assert.fail("old generation must not run"));
  handoff();
  hooks.get("userConnected")();
  game.users.activeGM = gm;
  hooks.get("updateUser")();
  blocked.release();
  assert.equal(await queued, null);
  assert.equal(f.writes.length, 0);
});

test("handoff during an effect template lookup prevents Item creation and state commit", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  let creations = 0;
  const actor = { uuid: "Actor.target", items: new Map(), createEmbeddedDocuments: async () => { creations++; return [{ id: "effect" }]; } };
  globalThis.fromUuid = async () => {
    started.release();
    await blocked.promise;
    return { documentName: "Item", type: "effect", toObject: () => ({ system: {} }) };
  };
  const transaction = f.runtime.withState(f.region, payload =>
    f.runtime.addEffectItem(f.region, payload, { id: "block" }, { uuid: "Token.target", actor }, { uuid: "Item.template", removal: "zone-end" })
  );
  await started.promise;
  handoff();
  blocked.release();
  assert.equal(await transaction, null);
  assert.equal(creations, 0);
  assert.equal(f.writes.length, 0);
});

test("handoff during cleanup target lookup leaves the owned Item for the next GM", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  let deletions = 0;
  const item = { id: "effect", delete: async () => { deletions++; } };
  const actor = { uuid: "Actor.target", items: new Map([[item.id, item]]) };
  item.parent = actor;
  f.stored.state.applied.record = { actorUuid: actor.uuid, itemId: item.id };
  f.runtime.resolveTarget = async () => { started.release(); await blocked.promise; return { actor }; };
  const transaction = f.runtime.withState(f.region, payload => f.runtime.deleteAppliedRecord(payload, "record"));
  await started.promise;
  handoff();
  blocked.release();
  await transaction;
  assert.equal(deletions, 0);
  assert.ok(f.stored.state.applied.record);
  assert.equal(f.writes.length, 0);
});

test("handoff after dispatching a commit suppresses its deferred actions", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  const update = f.region.update;
  f.region.update = async changes => { await update(changes); started.release(); await blocked.promise; };
  let actions = 0;
  const transaction = f.runtime.withState(f.region, payload => {
    payload.state.marker = "already dispatched";
    f.runtime.queueAfterCommit(payload, () => { actions++; });
  });
  await started.promise;
  handoff();
  blocked.release();
  assert.equal(await transaction, null);
  assert.equal(f.writes.length, 1, "a document operation already dispatched cannot be recalled");
  assert.equal(actions, 0);
});

test("handoff between deferred actions stops the remaining actions", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  let secondAction = 0;
  const transaction = f.runtime.withState(f.region, payload => {
    f.runtime.queueAfterCommit(payload, async () => { started.release(); await blocked.promise; });
    f.runtime.queueAfterCommit(payload, () => { secondAction++; });
  });
  await started.promise;
  handoff();
  blocked.release();
  await transaction;
  assert.equal(secondAction, 0);
});

test("a deferred save delivery retains the original lease across fresh payload reads", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  const token = { uuid: "Token.target", name: "Target", actor: { uuid: "Actor.target" } };
  const block = { id: "block", name: "Block", repeat: "every", save: { enabled: true, type: "will" } };
  f.stored.config.effects.push(block);
  let sourceCalls = 0;
  f.runtime.resolveSource = async () => {
    if (++sourceCalls === 2) { started.release(); await blocked.promise; }
    return { actor: { uuid: "Actor.source" } };
  };
  f.runtime.resolveDC = () => 20;
  f.runtime.hasPending = async () => false;
  f.runtime.isImmuneFor = () => false;
  globalThis.fromUuid = async () => token;
  const transaction = f.runtime.withState(f.region, payload => f.runtime.requestSave(f.region, payload, block, token, "enter", "batch"));
  await started.promise;
  handoff();
  blocked.release();
  await transaction;
  assert.equal(f.writes.length, 1, "delivery state must not be written after losing authority");
  const [pending] = Object.values(f.stored.state.pendingSaves);
  assert.equal(pending.delivery.status, "undelivered");
  game.user = otherGM;
  globalThis.ChatMessage.create = async () => ({ id: "recovered-card" });
  const result = await f.runtime.deliverPendingSave(f.region, pending.id, pending.identifier);
  assert.equal(result.status, "delivered");
  assert.equal(f.stored.state.pendingSaves[pending.id].delivery.messageId, "recovered-card");
});

test("queued shared immunity writes stop at handoff and release their queue", async t => {
  const f = await fixture(t);
  const blocked = gate();
  f.runtime.sharedImmunityWrite = blocked.promise;
  let writes = 0;
  game.settings = { get: () => ({}), set: async () => { writes++; } };
  const queued = f.runtime.mutateSharedImmunities(records => { records.grant = { group: "stench" }; });
  handoff();
  blocked.release();
  assert.equal(await queued, null);
  assert.equal(writes, 0);
  assert.equal(f.runtime.sharedImmunityWrite, null);
  assert.deepEqual(f.runtime.sharedImmunityCache, {});
});

test("source-triggered zone dismissal waiting on state work stops at handoff", async t => {
  const f = await fixture(t);
  const blocked = gate();
  f.stored.config.mode = "emanation";
  f.stored.state.sourceTokenUuid = "Token.source";
  f.runtime.locks.set(f.region.uuid, blocked.promise);
  const ending = f.runtime.reconcileDeletedToken({ uuid: "Token.source" });
  handoff();
  blocked.release();
  await ending;
  assert.equal(f.writes.length, 0);
  assert.ok(f.scene.regions.has(f.region.id));
  assert.equal(f.runtime.endingZones.size, 0);
  assert.equal(f.runtime.endZonePromises.size, 0);
});

test("a secondary GM can still deliberately dismiss a zone", async t => {
  const f = await fixture(t);
  handoff();
  assert.equal(f.runtime.isAuthority(), false);
  await f.runtime.endZone(f.region, "manager");
  assert.equal(f.writes.length, 1);
  assert.equal(f.scene.regions.has(f.region.id), false);
});

test("handoff cancels old activation timers and permits the new GM to reschedule", async t => {
  const f = await fixture(t);
  f.runtime.scheduleActivationFinalization(f.region, Date.now() + 60000);
  assert.equal(f.runtime.activationFinalizeTimers.size, 1);
  handoff();
  hooks.get("updateUser")();
  assert.equal(f.runtime.activationFinalizeTimers.size, 0);
  game.user = otherGM;
  f.runtime.scheduleActivationFinalization(f.region, Date.now() + 60000);
  assert.equal(f.runtime.activationFinalizeTimers.size, 1);
});

test("retiring a runtime invalidates its already queued state work", async t => {
  const f = await fixture(t);
  const blocked = gate();
  f.runtime.locks.set(f.region.uuid, blocked.promise);
  const queued = f.runtime.withState(f.region, () => assert.fail("retired runtime must not run"));
  f.runtime.teardownHooks();
  blocked.release();
  assert.equal(await queued, null);
  assert.equal(f.writes.length, 0);
});

test("handoff during a damage roll prevents its chat card and Region commit", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  f.runtime.baseDamageRoll = async () => { started.release(); await blocked.promise; return { roll: { toJSON: () => ({}) } }; };
  f.runtime.resolveSource = async () => ({});
  const transaction = f.runtime.withState(f.region, payload => f.runtime.postDamage(
    f.region, payload, { damage: { enabled: true } }, { name: "Target" }, "failure", 1, "batch"
  ));
  await started.promise;
  handoff();
  blocked.release();
  assert.equal(await transaction, null);
  assert.equal(f.writes.length, 0);
});

test("save resolution retains its original lease while waiting on a shared immunity lock", async t => {
  const f = await fixture(t);
  const blocked = gate();
  f.runtime.sharedImmunityGroup = () => "group";
  f.runtime.sharedImmunityTarget = () => "Actor.target";
  f.runtime.sharedResolutionLocks.set("Actor.target::group", blocked.promise);
  f.runtime.resolvePendingSaveUnlocked = async () => assert.fail("old resolution must not run");
  const queued = f.runtime.resolvePendingSave(f.region, "pending", "identifier", "success", "Actor.target");
  handoff();
  f.runtime.isAuthority();
  game.users.activeGM = gm;
  blocked.release();
  assert.equal(await queued, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.runtime.sharedResolutionLocks.size, 0);
});

test("handoff inside an async shared-state mutator prevents persistence", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  game.settings = { get: () => ({}), set: assert.fail };
  const transaction = f.runtime.mutateSharedImmunities(async records => {
    started.release();
    await blocked.promise;
    records.grant = {};
  });
  await started.promise;
  handoff();
  blocked.release();
  assert.equal(await transaction, null);
  assert.deepEqual(f.runtime.sharedImmunityCache, {});
});

test("a new authority recovery pass can start while the old pass is finishing", async t => {
  const f = await fixture(t);
  const started = gate();
  const blocked = gate();
  let firstSteps = 0;
  let subsequentSteps = 0;
  f.runtime.reconcileAllLinkedConditions = async () => {
    if (++firstSteps === 1) { started.release(); await blocked.promise; }
  };
  const steps = ["reconcileOrphanedZoneItems", "reconcileSharedImmunities", "reconcileRuntimeHistory",
    "reconcileUnfinishedZoneEnds", "reconcileDisabledZones", "reconcileUnfinishedExitCleanup",
    "reconcileCompletedSaves", "reconcileUndeliveredSaveRequests", "checkAllDurations",
    "reconcileUnfinishedActivations", "reconcileAllHpBaselines"];
  for (const step of steps) f.runtime[step] = async () => { subsequentSteps++; };
  const oldRecovery = f.runtime.reconcileAuthorityState();
  await started.promise;
  handoff();
  game.user = otherGM;
  await f.runtime.reconcileAuthorityState();
  blocked.release();
  await oldRecovery;
  assert.equal(firstSteps, 2);
  assert.equal(subsequentSteps, steps.length, "only the new authority may continue its repair pass");
  assert.equal(f.runtime.authorityRecovery, null);
});
