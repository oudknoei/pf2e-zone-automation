import assert from "node:assert/strict";
import test from "node:test";

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
  scenes: [],
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

  assert.deepEqual(events, ["update", "delete"]);
  assert.equal(regions.has(region.id), false);
  delete globalThis._replace;
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
