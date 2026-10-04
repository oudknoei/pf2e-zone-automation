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
test("runtime resolves the same positive Actor DC that validation offers", () => {
  const actor = {
    classDC: { dc: { value: 27 } },
    getStatistic(slug) {
      if (slug === "spell-dc") return { dc: { value: null } };
      if (slug === "class-spell") return { dc: { value: 0 } };
      return null;
    }
  };
  const block = { save: { dc: { mode: "actorStatistic", statistic: "spell-dc" } } };
  assert.equal(runtime.resolveDC({}, block, actor), null);
  block.save.dc.statistic = "class-dc";
  assert.equal(runtime.resolveDC({}, block, actor), 27);
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

test("deleting an affected unlinked Token clears its synthetic Actor records before exit", async () => {
  await withFiniteZoneFixture(async ({ region }) => {
    const targetToken = {
      uuid: "Scene.scene.Token.deleted-target",
      actorLink: false
    };
    region.getFlag().state.applied = {
      exit: {
        actorUuid: "Scene.scene.Token.deleted-target.Actor.synthetic",
        tokenUuid: targetToken.uuid,
        itemId: "exit-effect",
        removal: "on-exit"
      },
      end: {
        actorUuid: "Scene.scene.Token.deleted-target.Actor.synthetic",
        tokenUuid: targetToken.uuid,
        itemId: "end-effect",
        removal: "zone-end"
      },
      duration: {
        actorUuid: "Scene.scene.Token.deleted-target.Actor.synthetic",
        tokenUuid: targetToken.uuid,
        itemId: "duration-effect",
        removal: "item-duration"
      }
    };

    await runtime.reconcileDeletedToken(targetToken);

    assert.deepEqual(region.getFlag().state.applied, {});
  });
});

test("on-exit cleanup follows shared Actor occupancy for either linked-Token order", async () => {
  const previousFromUuid = globalThis.fromUuid;
  const previousEligible = runtime.eligible;
  try {
    for (const entryOrder of [["first", "second"], ["second", "first"]]) {
      for (const exitOrder of [["first", "second"], ["second", "first"]]) {
        const label = `entry ${entryOrder.join("-")}, exit ${exitOrder.join("-")}`;
        const actor = { uuid: `Actor.shared-${entryOrder.join("-")}-${exitOrder.join("-")}`, items: new Map() };
        const tokens = {
          first: { uuid: `${actor.uuid}.Token.first`, actor, actorLink: true },
          second: { uuid: `${actor.uuid}.Token.second`, actor, actorLink: true }
        };
        const item = {
          id: "shared-effect",
          parent: actor,
          async delete() { actor.items.delete(this.id); }
        };
        actor.items.set(item.id, item);
        const payload = {
          state: {
            applied: {
              shared: {
                recordId: "shared",
                actorUuid: actor.uuid,
                tokenUuid: tokens[entryOrder[0]].uuid,
                itemId: item.id,
                removal: "on-exit"
              }
            }
          }
        };
        const documents = new Map([[actor.uuid, actor], ...Object.values(tokens).map((token) => [token.uuid, token])]);
        globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;
        runtime.eligible = async (_payload, token) => token.actor?.uuid === actor.uuid;

        const remaining = tokens[exitOrder[1]];
        await runtime.cleanupExitedItemsUnlocked({}, payload, [remaining]);
        assert.equal(actor.items.has(item.id), true, `${label}: first exit must retain the shared Item`);
        assert.ok(payload.state.applied.shared, `${label}: first exit must retain its cleanup record`);

        await runtime.cleanupExitedItemsUnlocked({}, payload, []);
        assert.equal(actor.items.has(item.id), false, `${label}: last exit must remove the shared Item`);
        assert.deepEqual(payload.state.applied, {}, `${label}: last exit must complete cleanup`);
      }
    }
  } finally {
    runtime.eligible = previousEligible;
    if (previousFromUuid === undefined) delete globalThis.fromUuid;
    else globalThis.fromUuid = previousFromUuid;
  }
});

test("a deleted target Actor is completed cleanup instead of blocking zone dismissal", async () => {
  await withFiniteZoneFixture(async ({ scene, region }) => {
    region.getFlag().state.applied = {
      deleted: {
        actorUuid: "Scene.scene.Token.deleted-target.Actor.synthetic",
        tokenUuid: "Scene.scene.Token.deleted-target",
        itemId: "owned-effect",
        removal: "zone-end"
      }
    };

    await runtime.endZone(region, "target deleted before dismissal");

    assert.equal(scene.regions.has(region.id), false);
    assert.deepEqual(region.getFlag().state.applied, {});
  });
});

test("Actor deletion reconciliation removes only records belonging to that Actor", async () => {
  await withFiniteZoneFixture(async ({ region }) => {
    const deletedActor = { uuid: "Actor.deleted-target" };
    region.getFlag().state.applied = {
      deleted: {
        actorUuid: deletedActor.uuid,
        tokenUuid: "Scene.scene.Token.deleted-target",
        itemId: "deleted-effect",
        removal: "zone-end"
      },
      retained: {
        actorUuid: "Actor.other-target",
        tokenUuid: "Scene.scene.Token.other-target",
        itemId: "retained-effect",
        removal: "zone-end"
      }
    };

    await runtime.reconcileDeletedActor(deletedActor);

    assert.deepEqual(Object.keys(region.getFlag().state.applied), ["retained"]);
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

test("target eligibility respects closed walls by default and allows the zone override", async () => {
  const previousConst = globalThis.CONST;
  const originalResolveSource = runtime.resolveSource;
  globalThis.CONST = {
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1 }
  };
  const wall = { c: [150, 0, 150, 100], move: 20, door: 1, ds: 0 };
  const scene = { walls: [wall] };
  const sourceActor = { uuid: "Actor.source", isOfType: () => true };
  const targetActor = {
    uuid: "Actor.target", isOfType: () => true,
    isEnemyOf: () => true, isAllyOf: () => false
  };
  const sourceToken = {
    uuid: "Token.source", actor: sourceActor, parent: scene,
    x: 0, y: 0, getSize: () => ({ width: 100, height: 100 })
  };
  const targetToken = {
    uuid: "Token.target", actor: targetActor, parent: scene,
    x: 200, y: 0, getSize: () => ({ width: 100, height: 100 })
  };
  const region = { parent: scene };
  const payload = {
    config: { mode: "emanation", targeting: { affects: "enemies", includeSelf: false } }
  };
  runtime.resolveSource = async () => ({ token: sourceToken, actor: sourceActor });
  try {
    assert.equal(await runtime.eligible(payload, targetToken, region), false, "missing legacy setting uses the new default");
    payload.config.targeting.lineOfEffect = "ignore";
    assert.equal(await runtime.eligible(payload, targetToken, region), true);
    payload.config.targeting.lineOfEffect = "respect";
    wall.ds = 1;
    assert.equal(await runtime.eligible(payload, targetToken, region), true, "an open door restores line of effect");
  } finally {
    runtime.resolveSource = originalResolveSource;
    if (previousConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = previousConst;
  }
});

test("runtime watches token and wall changes for effective-zone reconciliation", () => {
  const hooks = globalThis.PF2EZoneRuntimeHookRegistry?.hookIds?.map(([name]) => name) ?? [];
  assert.ok(hooks.includes("updateToken"));
  assert.ok(hooks.includes("createWall"));
  assert.ok(hooks.includes("updateWall"));
  assert.ok(hooks.includes("deleteWall"));
});

test("effective occupancy fires Entry once when line of effect is restored", async () => {
  const originalInside = runtime.tokensInside;
  const originalEligible = runtime.eligible;
  const originalTrigger = runtime.processTriggerUnlocked;
  const region = { uuid: "Scene.scene.Region.line-of-effect", parent: { tokens: [] } };
  const token = { uuid: "Scene.scene.Token.target", actor: { uuid: "Actor.target" } };
  const payload = {
    config: { effects: [] },
    state: { applied: {}, hpObserved: {} }
  };
  const entries = [];
  let clear = false;
  runtime.tokensInside = () => [token];
  runtime.eligible = async () => clear;
  runtime.processTriggerUnlocked = async (_region, _payload, target, trigger) => {
    if (trigger === "enter") entries.push(target.uuid);
  };
  runtime.effectiveOccupants.set(region.uuid, new Set());
  try {
    clear = true;
    await runtime.reconcileContinuousUnlocked(region, payload);
    await runtime.reconcileContinuousUnlocked(region, payload);
    assert.deepEqual(entries, [token.uuid], "ordinary movement with unchanged line of effect does not retrigger Entry");

    clear = false;
    await runtime.reconcileContinuousUnlocked(region, payload);
    clear = true;
    await runtime.reconcileContinuousUnlocked(region, payload);
    assert.deepEqual(entries, [token.uuid, token.uuid], "losing then restoring line of effect creates a new Entry");
  } finally {
    runtime.tokensInside = originalInside;
    runtime.eligible = originalEligible;
    runtime.processTriggerUnlocked = originalTrigger;
    runtime.effectiveOccupants.delete(region.uuid);
  }
});

/** Creates persisted Region state so duration checks exercise real locking and deletion. */
async function withFiniteZoneFixture(run) {
  const saved = {
    time: game.time,
    combat: game.combat,
    combats: game.combats,
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
    scene,
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
  game.combats = { contents: [combat] };
  game.scenes = { contents: [scene], get: (id) => id === scene.id ? scene : null };

  try {
    await run({
      scene, region, combat, sourceActor, sourceToken, sourceCombatant, otherCombatant,
      get stored() { return stored; }
    });
  } finally {
    game.time = saved.time;
    game.combat = saved.combat;
    game.combats = saved.combats;
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
    game.combat = { id: "next-fight", scene, round: 1, turn: 0, turns: [newSource], combatant: newSource };
    game.combats.contents.push(game.combat);
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

test("a legacy scheduled flag cannot prevent activation recovery", async () => {
  await withFiniteZoneFixture(async ({ region }) => {
    region.tokens = new Set();
    region.getFlag().state.activationFinalizeScheduled = true;
    try {
      await runtime.reconcileUnfinishedActivations();
      const state = region.getFlag().state;
      assert.equal(state.activationPending, true);
      assert.ok(Number.isFinite(state.activationFinalizeAt));
      assert.equal(Object.hasOwn(state, "activationFinalizeScheduled"), false);
      assert.ok(runtime.activationFinalizeTimers.has(region.uuid));
    } finally {
      const timer = runtime.activationFinalizeTimers.get(region.uuid);
      if (timer) clearTimeout(timer);
      runtime.activationFinalizeTimers.delete(region.uuid);
    }
  });
});

test("activation resumes from its saved deadline after a GM reload", async () => {
  await withFiniteZoneFixture(async ({ region, sourceToken }) => {
    region.tokens = new Set();
    const originalEligible = runtime.eligible;
    const originalTrigger = runtime.processTriggerUnlocked;
    let entries = 0;
    try {
      runtime.eligible = async () => true;
      runtime.processTriggerUnlocked = async (_region, _payload, _token, trigger) => {
        if (trigger === "enter") entries++;
      };

      await runtime.activateRegion(region);
      const state = region.getFlag().state;
      assert.equal(state.activationPending, true);
      assert.ok(state.activationFinalizeAt >= Date.now());
      assert.ok(runtime.activationFinalizeTimers.has(region.uuid));
      assert.equal(Object.hasOwn(state, "activationFinalizeScheduled"), false);

      // Simulate a browser refresh: its timer vanishes, while Region flags survive.
      clearTimeout(runtime.activationFinalizeTimers.get(region.uuid));
      runtime.activationFinalizeTimers.delete(region.uuid);
      state.activationFinalizeScheduled = true; // persisted by older module versions
      state.activationFinalizeAt = Date.now() - 1;
      state.initialOccupants.initial__Scene_scene_Token_source = true;

      const enter = { event: { name: "tokenEnter", data: { token: sourceToken, movement: {} } }, region };
      await runtime.handleRegionEvent(enter);
      assert.equal(entries, 0, "the original occupant is ignored until activation finalizes");

      await runtime.reconcileUnfinishedActivations();
      for (let attempt = 0; attempt < 25 && !region.getFlag().state.activationProcessed; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(region.getFlag().state.activationProcessed, true);
      assert.equal(region.getFlag().state.activationPending, false);
      assert.deepEqual(region.getFlag().state.initialOccupants, {});
      assert.equal(Object.hasOwn(region.getFlag().state, "activationFinalizeScheduled"), false);
      assert.equal(Object.hasOwn(region.getFlag().state, "activationFinalizeAt"), false);
      await runtime.handleRegionEvent(enter);
      assert.equal(entries, 1, "later re-entry must be processed normally");
    } finally {
      const timer = runtime.activationFinalizeTimers.get(region.uuid);
      if (timer) clearTimeout(timer);
      runtime.activationFinalizeTimers.delete(region.uuid);
      runtime.eligible = originalEligible;
      runtime.processTriggerUnlocked = originalTrigger;
    }
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

test("a zone ignores another Scene's combat clock while its own encounter advances", async () => {
  await withFiniteZoneFixture(async ({ scene, region, combat }) => {
    const otherScene = { id: "other" };
    const otherCombat = {
      id: "other-fight", scene: otherScene, round: 1, turn: 0,
      turns: [{ id: "other", token: { uuid: "Scene.other.Token.other", parent: otherScene } }]
    };
    game.combats.contents.push(otherCombat);
    game.combat = otherCombat;

    otherCombat.round = 20;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), true);
    assert.equal(region.getFlag().state.duration.combatId, combat.id);

    combat.round = 3;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), false, "the owning encounter ends the zone");
  });
});

test("a zone uses world time when only an unrelated Scene has an encounter", async () => {
  await withFiniteZoneFixture(async ({ scene, region }) => {
    const otherScene = { id: "other" };
    const otherCombat = {
      id: "other-fight", scene: otherScene, round: 20, turn: 0,
      turns: [{ id: "other", token: { uuid: "Scene.other.Token.other", parent: otherScene } }]
    };
    game.combats.contents = [otherCombat];
    game.combat = otherCombat;

    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), true);
    assert.equal(region.getFlag().state.duration.combatId, "fight");

    game.time.worldTime = 112;
    await runtime.checkSourceAndDuration(region);
    assert.equal(scene.regions.has(region.id), false);
  });
});

test("once-per-round limits follow the zone's encounter instead of another Scene", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken }) => {
    const otherScene = { id: "other" };
    const otherCombat = {
      id: "other-fight", scene: otherScene, round: 10, turn: 0,
      turns: [{ id: "other", token: { uuid: "Scene.other.Token.other", parent: otherScene } }]
    };
    game.combats.contents.push(otherCombat);
    game.combat = otherCombat;
    const payload = region.getFlag();
    payload.state.repeat = {};
    const block = { id: "alert", repeat: "once-per-round" };

    runtime.markRepeat(payload, sourceToken.uuid, block);
    assert.equal(payload.state.repeat[runtime.repeatKey(sourceToken.uuid, block.id)].round, "fight:1");
    otherCombat.round = 11;
    assert.equal(runtime.repeatBlocked(payload, sourceToken.uuid, block), true);
    combat.round = 2;
    assert.equal(runtime.repeatBlocked(payload, sourceToken.uuid, block), false);
  });
});

test("temporary immunity uses the zone's encounter and ignores another Scene", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken }) => {
    const otherScene = { id: "other" };
    const otherCombat = {
      id: "other-fight", scene: otherScene, round: 5, turn: 0,
      turns: [{ id: "other", token: { uuid: "Scene.other.Token.other", parent: otherScene } }]
    };
    game.combats.contents.push(otherCombat);
    game.combat = otherCombat;
    const payload = region.getFlag();
    payload.state.immunities = {};
    runtime.setImmunity(payload, sourceToken.uuid, { id: "fervor", immunity: { duration: "1-round" } });
    const record = Object.values(payload.state.immunities)[0];
    assert.equal(record.expiry.combatId, combat.id);

    const priorLog = console.info;
    console.info = () => {};
    try {
      otherCombat.round = 20;
      assert.equal(runtime.isImmune(payload, sourceToken.uuid, "fervor"), true);
      combat.round = 2;
      assert.equal(runtime.isImmune(payload, sourceToken.uuid, "fervor"), false);
    } finally {
      console.info = priorLog;
    }
  });
});

test("another Scene's combat update cannot start this zone's source or occupant turn", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken }) => {
    const otherScene = { id: "other" };
    const otherCombat = {
      id: "other-fight", scene: otherScene, round: 2, turn: 0,
      turns: [{ id: "other", token: { uuid: "Scene.other.Token.other", parent: otherScene } }]
    };
    game.combats.contents.push(otherCombat);
    game.combat = otherCombat;
    const payload = region.getFlag();
    payload.config.effects = [{ triggers: { sourceTurnStart: true, turnStart: true } }];
    payload.state.lastSourceTriggerTurnKey = null;

    const original = {
      source: runtime.processSourceTurnStartUnlocked,
      occupant: runtime.processTurnStartUnlocked,
      inside: runtime.tokensInside
    };
    let sourceStarts = 0;
    let occupantStarts = 0;
    runtime.processSourceTurnStartUnlocked = async () => { sourceStarts++; };
    runtime.processTurnStartUnlocked = async () => { occupantStarts++; };
    runtime.tokensInside = () => [sourceToken];
    try {
      await runtime.processSourceTurnStart(region, otherCombat);
      await runtime.processActiveTurnStart(region, otherCombat);
      assert.deepEqual([sourceStarts, occupantStarts], [0, 0]);

      await runtime.processSourceTurnStart(region, combat);
      await runtime.processActiveTurnStart(region, combat);
      assert.deepEqual([sourceStarts, occupantStarts], [1, 1]);
    } finally {
      runtime.processSourceTurnStartUnlocked = original.source;
      runtime.processTurnStartUnlocked = original.occupant;
      runtime.tokensInside = original.inside;
    }
  });
});

test("a Summoner turn starts an inside Eidolon's zone effects even when the Summoner is outside", async () => {
  await withFiniteZoneFixture(async ({ scene, region, sourceActor }) => {
    sourceActor.id = "summoner";
    const eidolonActor = {
      id: "eidolon",
      uuid: "Actor.eidolon",
      getFlag: (scope, key) => scope === "pf2e-eidolon-helper" && key === "summoner"
        ? sourceActor.id
        : null
    };
    const eidolonToken = {
      uuid: "Scene.scene.Token.eidolon",
      actor: eidolonActor,
      parent: scene
    };
    const unrelatedToken = {
      uuid: "Scene.scene.Token.unrelated",
      actor: { id: "unrelated", uuid: "Actor.unrelated" },
      parent: scene
    };
    const previousActors = game.actors;
    const originalInside = runtime.tokensInside;
    const originalTurnStart = runtime.processTurnStartUnlocked;
    const processed = [];
    game.actors = {
      get: (id) => id === sourceActor.id ? sourceActor : null,
      contents: [sourceActor, eidolonActor]
    };
    region.getFlag().config.effects = [{ triggers: { turnStart: true } }];
    runtime.tokensInside = () => [eidolonToken, unrelatedToken];
    runtime.processTurnStartUnlocked = async (_region, _payload, token) => {
      processed.push(token.uuid);
    };

    try {
      await runtime.processActiveTurnStart(region);
      assert.deepEqual(processed, [eidolonToken.uuid]);
    } finally {
      game.actors = previousActors;
      runtime.tokensInside = originalInside;
      runtime.processTurnStartUnlocked = originalTurnStart;
    }
  });
});

test("PF2e Toolbelt-linked turn bodies are processed once with their master", async () => {
  await withFiniteZoneFixture(async ({ scene, region, sourceActor, sourceToken }) => {
    const eidolonActor = { id: "eidolon", uuid: "Actor.eidolon" };
    const eidolonToken = {
      uuid: "Scene.scene.Token.eidolon",
      actor: eidolonActor,
      parent: scene
    };
    const duplicateSummonerToken = {
      uuid: "Scene.scene.Token.duplicate-summoner",
      actor: sourceActor,
      parent: scene
    };
    const previousModules = game.modules;
    const originalInside = runtime.tokensInside;
    const originalTurnStart = runtime.processTurnStartUnlocked;
    const processed = [];
    game.modules = {
      get: (id) => id === "pf2e-toolbelt" ? {
        api: { shareData: { getMasterInMemory: (actor) => actor === eidolonActor ? sourceActor : null } }
      } : null
    };
    region.getFlag().config.effects = [{ triggers: { turnStart: true } }];
    runtime.tokensInside = () => [sourceToken, duplicateSummonerToken, eidolonToken];
    runtime.processTurnStartUnlocked = async (_region, _payload, token) => {
      processed.push(token.uuid);
    };

    try {
      await runtime.processActiveTurnStart(region);
      assert.deepEqual(processed, [sourceToken.uuid, eidolonToken.uuid]);
    } finally {
      game.modules = previousModules;
      runtime.tokensInside = originalInside;
      runtime.processTurnStartUnlocked = originalTurnStart;
    }
  });
});

test("entering combat keeps only the unused world-time immunity duration", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken }) => {
    game.combat = null;
    game.combats.contents = [];
    const payload = region.getFlag();
    payload.state.immunities = {};
    runtime.setImmunity(payload, sourceToken.uuid, {
      id: "stench", immunity: { duration: "1-minute" }
    });
    const expiry = Object.values(payload.state.immunities)[0].expiry;
    assert.equal(expiry.combatId, null);
    assert.equal(expiry.worldExpires, 160);

    game.time.worldTime = 154;
    game.combat = combat;
    game.combats.contents.push(combat);
    runtime.syncImmunityCombatClock(payload);
    assert.equal(expiry.combatId, combat.id);
    assert.equal(expiry.rounds, 1);
    assert.equal(expiry.remainingRounds, 1);

    combat.round = 2;
    assert.equal(runtime.isImmune(payload, sourceToken.uuid, "stench"), false);
  });
});

test("changing encounters carries prior combat progress even after a missed update hook", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken, sourceActor }) => {
    const payload = region.getFlag();
    payload.state.immunities = {};
    runtime.setImmunity(payload, sourceToken.uuid, {
      id: "stench", immunity: { duration: "1-minute" }
    });
    const expiry = Object.values(payload.state.immunities)[0].expiry;
    delete expiry.remainingRounds; // A legacy record has no progress field.
    combat.round = 6;

    const nextSource = { id: "next-source", actor: sourceActor, token: sourceToken };
    const nextCombat = {
      id: "next-fight", scene: region.parent, round: 1, turn: 0,
      turns: [nextSource], combatant: nextSource
    };
    game.combats.contents.push(nextCombat);
    game.combat = nextCombat;
    runtime.syncImmunityCombatClock(payload);
    assert.equal(expiry.combatId, nextCombat.id);
    assert.equal(expiry.rounds, 5);
    assert.equal(expiry.remainingRounds, 5);
    assert.equal(expiry.worldExpires, 130);

    nextCombat.round = 5;
    assert.equal(runtime.isImmune(payload, sourceToken.uuid, "stench"), true);
    nextCombat.round = 6;
    assert.equal(runtime.isImmune(payload, sourceToken.uuid, "stench"), false);
  });
});

test("leaving combat shortens the world deadline before a later encounter", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken, sourceActor }) => {
    const payload = region.getFlag();
    payload.state.immunities = {};
    runtime.setImmunity(payload, sourceToken.uuid, {
      id: "stench", immunity: { duration: "1-minute" }
    });
    const expiry = Object.values(payload.state.immunities)[0].expiry;
    combat.round = 5;
    runtime.syncImmunityCombatClock(payload);
    assert.equal(expiry.remainingRounds, 6);

    game.combat = null;
    game.combats.contents = [];
    runtime.syncImmunityCombatClock(payload);
    assert.equal(expiry.combatId, null);
    assert.equal(expiry.worldExpires, 136);

    game.time.worldTime = 112;
    const nextSource = { id: "next-source", actor: sourceActor, token: sourceToken };
    const nextCombat = {
      id: "next-fight", scene: region.parent, round: 1, turn: 0,
      turns: [nextSource], combatant: nextSource
    };
    game.combats.contents.push(nextCombat);
    game.combat = nextCombat;
    runtime.syncImmunityCombatClock(payload);
    assert.equal(expiry.combatId, nextCombat.id);
    assert.equal(expiry.rounds, 4);

    nextCombat.round = 5;
    assert.equal(runtime.isImmune(payload, sourceToken.uuid, "stench"), false);
  });
});

test("immunity keeps its original turn as the expiration point", async () => {
  await withFiniteZoneFixture(async ({ region, combat, sourceToken, otherCombatant }) => {
    const payload = region.getFlag();
    payload.state.immunities = {};
    combat.turn = 1;
    combat.combatant = otherCombatant;
    runtime.setImmunity(payload, sourceToken.uuid, {
      id: "stench", immunity: { duration: "1-round" }
    });

    combat.round = 2;
    combat.turn = 0;
    assert.equal(runtime.isImmune(payload, sourceToken.uuid, "stench"), true);
    combat.turn = 1;
    assert.equal(runtime.isImmune(payload, sourceToken.uuid, "stench"), false);
  });
});

test("active-GM recovery coalesces hook bursts and continues after an individual repair fails", async () => {
  const stepNames = [
    "reconcileAllLinkedConditions",
    "reconcileOrphanedZoneItems",
    "reconcileUnfinishedZoneEnds",
    "reconcileDisabledZones",
    "reconcileUnfinishedExitCleanup",
    "reconcileCompletedSaves",
    "reconcileUndeliveredSaveRequests",
    "checkAllDurations",
    "reconcileUnfinishedActivations",
    "reconcileAllHpBaselines"
  ];
  const originals = new Map(stepNames.map((name) => [name, runtime[name]]));
  const previousUser = game.user;
  const previousUsers = game.users;
  const previousError = console.error;
  const calls = [];
  const errors = [];
  let markStarted;
  let releaseFirstStep;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const firstStepReleased = new Promise((resolve) => { releaseFirstStep = resolve; });
  const authority = { id: "handoff-gm", isGM: true };

  for (const name of stepNames) {
    runtime[name] = async () => {
      calls.push(name);
      if (name === stepNames[0]) {
        markStarted();
        await firstStepReleased;
      }
      if (name === "reconcileUnfinishedZoneEnds") throw new Error("injected recovery failure");
    };
  }
  game.user = authority;
  game.users = { activeGM: authority };
  console.error = (...args) => errors.push(args);

  try {
    runtime.scheduleAuthorityRecovery("test handoff");
    runtime.scheduleAuthorityRecovery("duplicate hook");
    await started;
    const joined = runtime.reconcileAuthorityState("in-flight hook");
    releaseFirstStep();
    await joined;

    assert.deepEqual(calls, stepNames, "every repair runs exactly once and in startup order");
    assert.equal(errors.length, 1, "one failed repair does not prevent later repairs");
    assert.match(String(errors[0][0]), /test handoff unfinished zone ends failed/);
    assert.equal(runtime.authorityRecovery, null);
    assert.equal(runtime.authorityRecoveryTimer, null);
  } finally {
    releaseFirstStep();
    for (const [name, original] of originals) runtime[name] = original;
    game.user = previousUser;
    game.users = previousUsers;
    console.error = previousError;
  }
});
