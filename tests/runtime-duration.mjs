import assert from "node:assert/strict";
import test from "node:test";
import { combatDurationDeadline } from "../scripts/duration-clock.js";

globalThis.Hooks = {
  on: () => 1,
  off: () => {}
};
globalThis.foundry = { utils: {} };
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {}
};
globalThis.game = {
  actors: { contents: [] },
  scenes: { contents: [] },
  users: { activeGM: null },
  user: { id: "gm", isGM: true }
};

const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();

test("runtime uses a formula duration's stored result without attempting a reroll", () => {
  const formulaConfig = { duration: { type: "custom-rounds", rounds: "2d4" } };

  assert.equal(runtime.durationRounds(formulaConfig, { duration: { rounds: 5, formula: "2d4" } }), 5);
  assert.equal(runtime.durationRounds(formulaConfig, { duration: {} }), null);
});
test("zone cleanup serializes accepted state work before deleting the Region", async () => {
  globalThis._replace = (payload) => payload;

  const events = [];
  const regions = new Map();
  const parent = { regions };
  let storedPayload = { state: { applied: {} } };
  const region = {
    id: "region-1",
    uuid: "Scene.scene-1.Region.region-1",
    parent,
    getFlag: () => storedPayload,
    async update(changes) {
      assert.equal(regions.get(this.id), this, "state work must finish before Region deletion");
      events.push("update");
      storedPayload = changes["flags.world.pf2eZone"];
    },
    async delete() {
      events.push("delete");
      regions.delete(this.id);
    }
  };
  regions.set(region.id, region);

  let releaseStateWork;
  const stateWorkReleased = new Promise((resolve) => { releaseStateWork = resolve; });
  let markStateWorkStarted;
  const stateWorkStarted = new Promise((resolve) => { markStateWorkStarted = resolve; });

  const acceptedStateWork = runtime.withState(region, async (payload) => {
    markStateWorkStarted();
    await stateWorkReleased;
    payload.state.marker = "saved-before-cleanup";
  });
  await stateWorkStarted;

  const ending = runtime.endZone(region, "test expiration");
  assert.equal(
    await runtime.withState(region, async () => assert.fail("ending zones must reject new state work")),
    null
  );

  releaseStateWork();
  await Promise.all([acceptedStateWork, ending]);

  assert.deepEqual(events, ["update", "update", "delete"]);
  assert.equal(storedPayload.state.deactivated, true);
  assert.equal(storedPayload.state.endRequested, true);
  assert.equal(regions.has(region.id), false);
  delete globalThis._replace;
});

test("failed Item cleanup retains records and retries after reconnect", async () => {
  await withFiniteZoneFixture(async ({ scene, region, sourceActor }) => {
    const priorUi = globalThis.ui;
    const priorConsoleError = console.error;
    const notices = [];
    globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
    console.error = () => {};
    try {
      let failFirst = true;
      const first = {
        id: "first", name: "First", parent: sourceActor,
        async delete() {
          if (failFirst) throw new Error("temporary Item deletion failure");
          sourceActor.items.delete(this.id);
        }
      };
      const second = {
        id: "second", name: "Second", parent: sourceActor,
        async delete() { sourceActor.items.delete(this.id); }
      };
      sourceActor.items = new Map([[first.id, first], [second.id, second]]);
      region.getFlag().state.applied = {
        first: { actorUuid: sourceActor.uuid, itemId: first.id, removal: "zone-end" },
        second: { actorUuid: sourceActor.uuid, itemId: second.id, removal: "zone-end" }
      };

      await assert.rejects(runtime.endZone(region, "manual"), /temporary Item deletion failure/);
      assert.equal(scene.regions.has(region.id), true, "failed dismissal keeps the Region for retry");
      assert.equal(region.getFlag().state.deactivated, true);
      assert.equal(region.getFlag().state.endRequested, true);
      assert.deepEqual(Object.keys(region.getFlag().state.applied), ["first"]);
      assert.deepEqual([...sourceActor.items.keys()], ["first"], "another Item still cleans up after the first failure");
      assert.equal(notices.length, 1, "dismissal failure is visible to the GM");

      failFirst = false;
      await runtime.reconcileUnfinishedZoneEnds();
      assert.equal(scene.regions.has(region.id), false);
      assert.equal(sourceActor.items.size, 0);
    } finally {
      console.error = priorConsoleError;
      if (priorUi === undefined) delete globalThis.ui;
      else globalThis.ui = priorUi;
    }
  });
});

test("failed Region deletion rejects dismissal and remains retryable", async () => {
  await withFiniteZoneFixture(async ({ scene, region }) => {
    const priorUi = globalThis.ui;
    const priorConsoleError = console.error;
    globalThis.ui = { notifications: { error: () => {} } };
    console.error = () => {};
    try {
      const originalDelete = region.delete;
      let failDelete = true;
      region.delete = async function () {
        if (failDelete) throw new Error("temporary Region deletion failure");
        return originalDelete.call(this);
      };

      await assert.rejects(runtime.endZone(region, "manual"), /temporary Region deletion failure/);
      assert.equal(scene.regions.has(region.id), true);
      assert.equal(region.getFlag().state.endRequested, true);
      assert.equal(region.getFlag().state.deactivated, true);

      failDelete = false;
      await runtime.reconcileUnfinishedZoneEnds();
      assert.equal(scene.regions.has(region.id), false);
    } finally {
      console.error = priorConsoleError;
      if (priorUi === undefined) delete globalThis.ui;
      else globalThis.ui = priorUi;
    }
  });
});

test("simultaneous dismissal requests share a failed Region deletion", async () => {
  await withFiniteZoneFixture(async ({ scene, region }) => {
    const priorUi = globalThis.ui;
    const priorConsoleError = console.error;
    globalThis.ui = { notifications: { error: () => {} } };
    console.error = () => {};
    try {
      let signalStarted;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      let releaseDelete;
      const released = new Promise((resolve) => { releaseDelete = resolve; });
      region.delete = async () => {
        signalStarted();
        await released;
        throw new Error("simultaneous Region deletion failure");
      };
      const first = runtime.endZone(region, "first request");
      await started;
      const second = runtime.endZone(region, "second request");
      releaseDelete();
      const results = await Promise.allSettled([first, second]);
      assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
      assert.match(results[1].reason.message, /simultaneous Region deletion failure/);
      assert.equal(scene.regions.has(region.id), true);
    } finally {
      console.error = priorConsoleError;
      if (priorUi === undefined) delete globalThis.ui;
      else globalThis.ui = priorUi;
    }
  });
});

test("orphaned zone Items can be retried after an external Region deletion", async () => {
  await withFiniteZoneFixture(async ({ scene, region, sourceActor }) => {
    const priorUi = globalThis.ui;
    const priorConsoleError = console.error;
    const priorGetProperty = foundry.utils.getProperty;
    const priorActors = game.actors.contents;
    const notices = [];
    globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
    console.error = () => {};
    foundry.utils.getProperty = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
    try {
      let failDeletion = true;
      const item = {
        id: "orphaned", name: "Orphaned effect", parent: sourceActor,
        flags: { world: { pf2eZone: { zoneUuid: region.uuid, removal: "zone-end" } } },
        async delete() {
          if (failDeletion) throw new Error("temporary orphan cleanup failure");
          sourceActor.items.delete(this.id);
        }
      };
      sourceActor.items = new Map([[item.id, item]]);
      game.actors.contents = [sourceActor];
      scene.regions.delete(region.id);

      await runtime.reconcileOrphanedZoneItems();
      assert.equal(sourceActor.items.has(item.id), true);
      assert.equal(notices.length, 1);
      failDeletion = false;
      await runtime.reconcileOrphanedZoneItems();
      assert.equal(sourceActor.items.has(item.id), false);
    } finally {
      game.actors.contents = priorActors;
      foundry.utils.getProperty = priorGetProperty;
      console.error = priorConsoleError;
      if (priorUi === undefined) delete globalThis.ui;
      else globalThis.ui = priorUi;
    }
  });
});

test("a stale Item deletion error is harmless once the Item is gone", async () => {
  const actor = { uuid: "Actor.stale", items: new Map() };
  const item = {
    id: "stale", parent: actor,
    async delete() {
      actor.items.delete(this.id);
      throw new Error("undefined id [stale] does not exist in the EmbeddedCollection collection");
    }
  };
  actor.items.set(item.id, item);
  assert.equal(await runtime.deleteOwnedItem(item), true);
  assert.equal(actor.items.has(item.id), false);
});

test("failed on-exit cleanup retries at startup without replaying continuous effects", async () => {
  await withFiniteZoneFixture(async ({ region, sourceActor, sourceToken }) => {
    let failDeletion = true;
    const item = {
      id: "exited", parent: sourceActor,
      async delete() {
        if (failDeletion) throw new Error("temporary exit cleanup failure");
        sourceActor.items.delete(this.id);
      }
    };
    sourceActor.items = new Map([[item.id, item]]);
    region.getFlag().state.applied = {
      exited: {
        actorUuid: sourceActor.uuid, tokenUuid: sourceToken.uuid,
        itemId: item.id, removal: "on-exit"
      }
    };

    await assert.rejects(
      runtime.withState(region, (payload) => runtime.cleanupExitedItemsUnlocked(region, payload)),
      /temporary exit cleanup failure/
    );
    assert.equal(sourceActor.items.has(item.id), true);
    assert.ok(region.getFlag().state.applied.exited);

    failDeletion = false;
    const previousContinuous = runtime.processContinuousUnlocked;
    runtime.processContinuousUnlocked = () => assert.fail("startup retry must not replay continuous effects");
    try {
      await runtime.reconcileUnfinishedExitCleanup();
    } finally {
      runtime.processContinuousUnlocked = previousContinuous;
    }
    assert.equal(sourceActor.items.has(item.id), false);
    assert.deepEqual(region.getFlag().state.applied, {});
  });
});

test("self-only and legacy both targeting remain compatible", async () => {
  const sourceActor = { uuid: "Actor.source", isOfType: () => true };
  const sourceToken = { uuid: "Token.source", actor: sourceActor };
  const actor = (name, ally, enemy) => ({
    uuid: `Actor.${name}`,
    isOfType: () => true,
    isAllyOf: () => ally,
    isEnemyOf: () => enemy
  });
  const ally = { uuid: "Token.ally", actor: actor("ally", true, false) };
  const enemy = { uuid: "Token.enemy", actor: actor("enemy", false, true) };
  const neutral = { uuid: "Token.neutral", actor: actor("neutral", false, false) };
  const originalResolveSource = runtime.resolveSource;
  runtime.resolveSource = async () => ({ token: sourceToken, actor: sourceActor });
  try {
    const selfOnly = { config: { targeting: { affects: "none", includeSelf: true } } };
    assert.equal(await runtime.eligible(selfOnly, sourceToken), true);
    assert.equal(await runtime.eligible(selfOnly, ally), false);
    assert.equal(await runtime.eligible(selfOnly, enemy), false);

    const both = { config: { targeting: { affects: "both", includeSelf: false } } };
    assert.equal(await runtime.eligible(both, sourceToken), false);
    assert.equal(await runtime.eligible(both, ally), true);
    assert.equal(await runtime.eligible(both, enemy), true);
    assert.equal(await runtime.eligible(both, neutral), true);
  } finally {
    runtime.resolveSource = originalResolveSource;
  }
});

/** Creates persisted Region state so duration checks exercise real locking and deletion. */
async function withFiniteZoneFixture(run) {
  const saved = {
    time: game.time,
    combat: game.combat,
    scenes: game.scenes,
    fromUuid: globalThis.fromUuid,
    replace: globalThis._replace
  };
  const regions = new Map();
  regions[Symbol.iterator] = function* () { yield* this.values(); };
  const scene = { id: "scene", regions, tokens: [] };
  const sourceActor = { uuid: "Actor.source" };
  const sourceToken = { uuid: "Scene.scene.Token.source", actor: sourceActor, parent: scene };
  const sourceCombatant = { id: "source", actor: sourceActor, token: sourceToken };
  const otherCombatant = { id: "other", actor: { uuid: "Actor.other" }, token: { uuid: "Token.other" } };
  const combat = {
    id: "fight",
    round: 1,
    turn: 0,
    turns: [sourceCombatant, otherCombatant],
    combatant: sourceCombatant
  };
  sourceActor.combatant = sourceCombatant;
  const rounds = 2;
  let stored = {
    config: { name: "Timed area", mode: "area", duration: { type: "custom-rounds", rounds }, effects: [] },
    state: {
      sourceActorUuid: sourceActor.uuid,
      sourceTokenUuid: sourceToken.uuid,
      createdWorldTime: 100,
      duration: {
        rounds,
        worldExpires: 112,
        sourceCombatantId: sourceCombatant.id,
        sourceTurnsElapsed: 0,
        lastSourceTurnKey: "fight:1:0:source",
        ...combatDurationDeadline(combat, sourceCombatant, rounds)
      }
    }
  };
  const region = {
    id: "zone",
    uuid: "Scene.scene.Region.zone",
    name: "Timed area",
    parent: scene,
    behaviors: [{ name: "PF2e Zone Runtime", disabled: false }],
    getFlag: () => stored,
    async update(changes) { stored = changes["flags.world.pf2eZone"]; },
    async delete() { scene.regions.delete(this.id); }
  };
  scene.regions.set(region.id, region);
  const documents = new Map([[sourceActor.uuid, sourceActor], [sourceToken.uuid, sourceToken]]);
  globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;
  globalThis._replace = (payload) => payload;
  game.time = { worldTime: 100 };
  game.combat = combat;
  game.scenes = { contents: [scene], get: (id) => id === scene.id ? scene : null };

  try {
    await run({
      scene, region, combat, sourceActor, sourceToken, sourceCombatant, otherCombatant,
      get stored() { return stored; }
    });
  } finally {
    game.time = saved.time;
    game.combat = saved.combat;
    game.scenes = saved.scenes;
    if (saved.fromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = saved.fromUuid;
    if (saved.replace === undefined) delete globalThis._replace;
    else globalThis._replace = saved.replace;
  }
}

test("a missed source turn cannot extend a finite zone after a round jump", async () => {
  await withFiniteZoneFixture(async ({ scene, region, combat, otherCombatant }) => {
    combat.round = 2;
    combat.turn = 1;
    combat.combatant = otherCombatant;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), true);

    combat.round = 6;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), false);
  });
});

test("a removed source combatant falls back to world time or the combat deadline", async () => {
  for (const clock of ["world", "combat"]) {
    await withFiniteZoneFixture(async ({ scene, region, combat, sourceActor, otherCombatant }) => {
      combat.turns = [otherCombatant];
      combat.combatant = otherCombatant;
      sourceActor.combatant = null;
      if (clock === "world") game.time.worldTime = 112;
      else combat.round = 3;

      await runtime.checkSourceAndDuration(region);
      assert.equal(scene.regions.has(region.id), false, `${clock} time must expire the zone`);
    });
  }
});

test("a new encounter preserves observed remaining rounds instead of restarting duration", async () => {
  await withFiniteZoneFixture(async ({ scene, region, combat, sourceActor, sourceToken, otherCombatant }) => {
    combat.round = 2;
    combat.turn = 1;
    combat.combatant = otherCombatant;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), true);

    const newSource = { id: "new-source", actor: sourceActor, token: sourceToken };
    game.combat = { id: "next-fight", round: 1, turn: 0, turns: [newSource], combatant: newSource };
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), true);
    assert.equal(region.getFlag().state.duration.combatExpiresAtRound, 2);

    game.combat.round = 2;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), false);
  });
});

test("an older zone recovers its deadline from the last recorded source turn", async () => {
  await withFiniteZoneFixture(async ({ scene, region, combat }) => {
    delete region.getFlag().state.duration.combatExpiresAtRound;
    delete region.getFlag().state.duration.lastObservedRound;
    combat.round = 6;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), false);
  });
});

test("disabling a behavior persists deactivation, removes owned effects, and silences global events", async () => {
  await withFiniteZoneFixture(async ({ scene, region, sourceActor, sourceToken }) => {
    const item = {
      id: "owned",
      parent: sourceActor,
      async delete() { sourceActor.items.delete(this.id); }
    };
    sourceActor.items = new Map([[item.id, item]]);
    region.getFlag().config.effects = [{ id: "spell", triggers: { spellCast: true, turnStart: true } }];
    region.getFlag().state.applied = {
      owned: { actorUuid: sourceActor.uuid, itemId: item.id, removal: "zone-end" }
    };
    region.getFlag().state.pendingSaves = { pending: { id: "pending" } };
    region.behaviors[0].disabled = true;

    const originalInstall = runtime.installHooks;
    const originalTraitInfo = runtime.traitUseInfoFromMessage;
    const originalTurnStart = runtime.processTurnStartUnlocked;
    const originalProcessBlock = runtime.processBlock;
    const originalTokensInside = runtime.tokensInside;
    let traitReads = 0;
    let turns = 0;
    let spellTriggers = 0;
    runtime.installHooks = () => {};
    runtime.traitUseInfoFromMessage = async () => { traitReads++; return { token: sourceToken, traits: new Set(), isSpellCast: true }; };
    runtime.processTurnStartUnlocked = async () => { turns++; };
    runtime.processBlock = async () => { spellTriggers++; };
    runtime.tokensInside = () => [sourceToken];

    try {
      // The physical behavior state protects older zones even before their flag is migrated.
      await runtime.handleTraitUseMessage({ id: "cast-before-event" });
      assert.equal(traitReads, 0);

      await runtime.handleRegionEvent({ event: { name: "behaviorDeactivated" }, region });
      assert.equal(region.getFlag().state.deactivated, true);
      assert.deepEqual(region.getFlag().state.pendingSaves, {});
      assert.equal(sourceActor.items.size, 0);
      assert.deepEqual(region.getFlag().state.applied, {});

      await runtime.handleTraitUseMessage({ id: "cast-after-event" });
      await runtime.processActiveTurnStart(region);
      await runtime.handleRegionEvent({ event: { name: "tokenEnter", data: { token: sourceToken } }, region });
      assert.equal(traitReads, 0);
      assert.equal(turns, 0);
      assert.equal(spellTriggers, 0);
      assert.equal(scene.regions.has(region.id), true);

      region.behaviors[0].disabled = false;
      region.getFlag().state.activationProcessed = true;
      await runtime.handleRegionEvent({ event: { name: "behaviorActivated" }, region });
      assert.equal(region.getFlag().state.deactivated, false);
      await runtime.handleTraitUseMessage({ id: "cast-after-reactivation" });
      assert.equal(traitReads, 1);
      assert.equal(spellTriggers, 1);
    } finally {
      runtime.installHooks = originalInstall;
      runtime.traitUseInfoFromMessage = originalTraitInfo;
      runtime.processTurnStartUnlocked = originalTurnStart;
      runtime.processBlock = originalProcessBlock;
      runtime.tokensInside = originalTokensInside;
    }
  });
});

test("a source turn later in the round remains the finite-zone expiration point", async () => {
  await withFiniteZoneFixture(async ({ scene, region, combat, sourceCombatant, otherCombatant }) => {
    combat.turns = [otherCombatant, sourceCombatant];
    combat.turn = 0;
    combat.combatant = otherCombatant;
    Object.assign(region.getFlag().state.duration, combatDurationDeadline(combat, sourceCombatant, 2));
    assert.equal(region.getFlag().state.duration.combatExpiresAtRound, 2);

    combat.round = 2;
    game.time.worldTime = 112;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), true, "the source has not reached their turn yet");

    combat.turn = 1;
    combat.combatant = sourceCombatant;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), false);
  });
});

test("startup reconciliation cleans a previously disabled behavior with a stale active flag", async () => {
  await withFiniteZoneFixture(async ({ region, sourceActor }) => {
    const item = {
      id: "old-owned",
      parent: sourceActor,
      async delete() { sourceActor.items.delete(this.id); }
    };
    sourceActor.items = new Map([[item.id, item]]);
    region.getFlag().state.applied = {
      owned: { actorUuid: sourceActor.uuid, itemId: item.id, removal: "zone-end" }
    };
    delete region.getFlag().state.deactivated;
    region.behaviors[0].disabled = true;

    await runtime.reconcileDisabledZones();
    assert.equal(region.getFlag().state.deactivated, true);
    assert.equal(sourceActor.items.size, 0);
  });
});

test("reactivating an overdue zone ends it before maintained effects return", async () => {
  await withFiniteZoneFixture(async ({ scene, region, combat }) => {
    region.getFlag().state.deactivated = true;
    combat.round = 3;
    const originalReconcile = runtime.reconcileContinuousUnlocked;
    let reconciles = 0;
    runtime.reconcileContinuousUnlocked = async () => { reconciles++; };
    try {
      await runtime.activateRegion(region);
      assert.equal(scene.regions.has(region.id), false);
      assert.equal(reconciles, 0);
    } finally {
      runtime.reconcileContinuousUnlocked = originalReconcile;
    }
  });
});
