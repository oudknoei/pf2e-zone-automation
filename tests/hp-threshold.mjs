import assert from "node:assert/strict";
import test from "node:test";

const hooks = new Map();
globalThis.Hooks = {
  on(name, fn) { hooks.set(name, fn); return name; },
  off() {}
};
globalThis.document = { addEventListener() {}, removeEventListener() {} };
globalThis.foundry = { utils: { randomID: () => "hp-event" } };
globalThis._replace = (value) => value;
globalThis.game = {
  actors: { contents: [] },
  scenes: [],
  users: { activeGM: { id: "gm" } },
  user: { id: "gm", isGM: true },
  time: { worldTime: 0 },
  combat: { id: "combat", round: 1, turn: 0 },
  i18n: { localize: (key) => key }
};

const { editableHpThreshold, crossedHpThreshold, actorHitPoints } =
  await import("../scripts/hp-threshold.js");
const { defaultConfig, normalizeConfig, validateConfig, SCHEMA_VERSION } =
  await import("../scripts/zone-config.js");
const { zoneRuntimeEntrypoint } = await import("../scripts/runtime.js");
const runtime = await zoneRuntimeEntrypoint();
await new Promise((resolve) => setTimeout(resolve, 0));

function makeZone(tokens, blocks) {
  let stored = {
    config: { name: "HP zone", effects: blocks },
    state: { hpObserved: {}, repeat: {}, immunities: {} }
  };
  const scene = { regions: new Map() };
  const region = {
    id: "zone", uuid: "Scene.test.Region.zone", parent: scene,
    getFlag: () => stored,
    async update(changes) { stored = changes["flags.world.pf2eZone"]; }
  };
  scene.regions.set(region.id, region);
  game.scenes = [scene];
  runtime.tokensInside = () => tokens;
  return { region, stored: () => stored, setTokens(next) { tokens = next; } };
}

function hpBlock(id, threshold, repeat = "every") {
  return {
    id, name: id, triggers: { hpThreshold: true },
    hitPoints: { threshold }, repeat,
    chatAlert: { enabled: true, text: "{creature}: {previousHp} to {hp}" },
    save: { enabled: false }, immunity: { duration: "none", starts: [] }
  };
}

test("HP threshold values remain visible and invalid input is rejected", () => {
  assert.equal(SCHEMA_VERSION, 16);
  assert.equal(editableHpThreshold("0"), 0);
  assert.equal(editableHpThreshold("25"), 25);
  assert.equal(editableHpThreshold("2d4"), "2d4");
  assert.equal(editableHpThreshold(""), "");
  assert.equal(actorHitPoints({ system: { attributes: { hp: { value: 0 } } } }), 0);
  assert.equal(actorHitPoints({ system: { attributes: { hp: { value: null } } } }), null);
  assert.equal(crossedHpThreshold(21, 20, 20), true);
  assert.equal(crossedHpThreshold(20, 19, 20), false);
  assert.equal(crossedHpThreshold(10, 9, 10), false);
  assert.equal(runtime.formatChatAlert("{creature}: {previousHp} to {hp}, threshold {threshold}", { creature: "Troop", previousHp: 180, hp: 150, threshold: 159 }), "Troop: 180 to 150, threshold 159");

  const config = defaultConfig();
  config.name = "HP watch";
  config.targeting.includeSelf = true;
  config.effects[0].triggers.hpThreshold = true;
  config.effects[0].chatAlert.enabled = true;
  let normalized = normalizeConfig(config);
  assert.match(validateConfig(normalized, { sourceActor: { name: "Source" } }).errors.join(" "), /Hit Point threshold/);

  config.effects[0].hitPoints.threshold = "25";
  normalized = normalizeConfig(config);
  assert.equal(normalized.effects[0].hitPoints.threshold, 25);
  assert.deepEqual(validateConfig(normalized, { sourceActor: { name: "Source" } }).errors, []);

  config.effects[0].hitPoints.threshold = "2d4";
  normalized = normalizeConfig(config);
  assert.equal(normalized.effects[0].hitPoints.threshold, "2d4");
  assert.match(validateConfig(normalized, { sourceActor: { name: "Source" } }).errors.join(" "), /whole-number/);

  config.effects[0].hitPoints.threshold = 25;
  config.effects[0].triggers.enter = true;
  normalized = normalizeConfig(config);
  assert.match(validateConfig(normalized, { sourceActor: { name: "Source" } }).errors.join(" "), /own Effect Block/);
});

test("GM HP watcher fires on downward crossings and rearms after healing", async () => {
  const actor = { uuid: "Actor.target", name: "Target", system: { attributes: { hp: { value: 30 } } } };
  const token = { uuid: "Token.target", actor };
  const zone = makeZone([token], [hpBlock("first", 20), hpBlock("second", 10)]);
  const alerts = [];
  const prior = {
    eligible: runtime.eligible, isImmune: runtime.isImmune,
    postChatAlertOnce: runtime.postChatAlertOnce, applyOutcome: runtime.applyOutcome
  };
  try {
    runtime.eligible = async () => true;
    runtime.isImmune = () => false;
    runtime.postChatAlertOnce = async (_region, _payload, block, _token, _batch, context) => {
      alerts.push({ block: block.id, ...context });
    };
    runtime.applyOutcome = async () => false;
    assert.equal(typeof hooks.get("updateActor"), "function");
    await runtime.withState(zone.region, (state) => runtime.reconcileHpBaselinesUnlocked(zone.region, state));

    actor.system.attributes.hp.value = 9;
    await runtime.handleActorHitPointUpdate(actor);
    assert.deepEqual(alerts.map((alert) => alert.block), ["first", "second"]);
    assert.deepEqual(alerts.map((alert) => alert.hp), [9, 9]);
    assert.deepEqual(alerts.map((alert) => alert.previousHp), [30, 30]);

    actor.system.attributes.hp.value = 8;
    await runtime.handleActorHitPointUpdate(actor);
    assert.equal(alerts.length, 2, "remaining below does not retrigger");

    actor.system.attributes.hp.value = 30;
    await runtime.handleActorHitPointUpdate(actor);
    assert.equal(alerts.length, 2, "healing does not trigger");
    actor.system.attributes.hp.value = 20;
    await runtime.handleActorHitPointUpdate(actor);
    assert.deepEqual(alerts.map((alert) => alert.block), ["first", "second", "first"]);

    zone.setTokens([]);
    await runtime.withState(zone.region, (state) => runtime.reconcileHpBaselinesUnlocked(zone.region, state));
    actor.system.attributes.hp.value = 5;
    zone.setTokens([token]);
    await runtime.withState(zone.region, (state) => runtime.reconcileHpBaselinesUnlocked(zone.region, state));
    actor.system.attributes.hp.value = 4;
    await runtime.handleActorHitPointUpdate(actor);
    assert.equal(alerts.length, 3, "already below on re-entry does not trigger");

    zone.stored().state.hpObserved.hp__Token_target = 30;
    await runtime.withState(zone.region, (state) => runtime.reconcileHpBaselinesUnlocked(zone.region, state, { replace: true }));
    assert.equal(zone.stored().state.hpObserved.hp__Token_target, 4, "GM reconnect resets stale HP baselines");
  } finally {
    Object.assign(runtime, prior);
    game.scenes = [];
  }
});

test("linked troop segment HP updates produce one event for the troop", async () => {
  const actorA = { uuid: "Actor.a", system: { traits: { value: ["troop"] }, attributes: { hp: { value: 30 } } } };
  const actorB = { uuid: "Actor.b", system: { traits: { value: ["troop"] }, attributes: { hp: { value: 30 } } } };
  actorA.otherSegments = [actorB];
  actorB.otherSegments = [actorA];
  const tokenA = { uuid: "Token.a", actor: actorA };
  const tokenB = { uuid: "Token.b", actor: actorB };
  const zone = makeZone([tokenA, tokenB], [hpBlock("troop", 20)]);
  const processed = [];
  const prior = { eligible: runtime.eligible, processBlock: runtime.processBlock };
  try {
    runtime.eligible = async () => true;
    runtime.processBlock = async (_region, _payload, _block, token) => processed.push(token.uuid);
    await runtime.withState(zone.region, (state) => runtime.reconcileHpBaselinesUnlocked(zone.region, state));

    actorB.system.attributes.hp.value = 15;
    await runtime.handleActorHitPointUpdate(actorB);
    actorA.system.attributes.hp.value = 15;
    await runtime.handleActorHitPointUpdate(actorA);
    assert.deepEqual(processed, ["Token.a"]);
  } finally {
    Object.assign(runtime, prior);
    game.scenes = [];
  }
});
