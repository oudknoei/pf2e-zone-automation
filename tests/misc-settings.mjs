import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { installABPSpellAttacks, registerMiscSettings } from "../scripts/misc-settings.js";

const MODULE_ID = "pf2e-zone-automation";
const TARGET = "game.pf2e.variantRules.AutomaticBonusProgression.concatModifiers";
const hooks = new Map();
const registrations = new Map();
const settings = new Map();
const potencyByLevel = new Map([[0, 0], [1, 0], [2, 1], [9, 1], [10, 2], [15, 2], [16, 3], [20, 3]]);
let enabled;
let mode;
let potencyLevels;

beforeEach(() => {
  hooks.clear();
  registrations.clear();
  settings.clear();
  enabled = true;
  mode = "ABPRulesAsWritten";
  potencyLevels = [];
  globalThis.Hooks = { on: (name, handler) => hooks.set(name, handler) };
  globalThis.game = {
    system: { id: "pf2e" },
    settings: {
      register(namespace, key, config) { settings.set(`${namespace}.${key}`, config); },
      get(namespace, key) {
        assert.equal(namespace, MODULE_ID);
        assert.equal(key, "abpSpellAttacks");
        return enabled;
      }
    },
    pf2e: {
      Modifier: class {
        constructor(data) { Object.assign(this, data); }
      },
      variantRules: {
        AutomaticBonusProgression: {
          concatModifiers() {},
          isEnabled: (actor) => mode !== "noABP" && !actor.flags.pf2e.disableABP,
          getAttackPotency(level) {
            potencyLevels.push(level);
            assert.ok(potencyByLevel.has(level), "The extension must pass character level to native ABP");
            return potencyByLevel.get(level);
          }
        }
      }
    }
  };
  globalThis.libWrapper = {
    register(namespace, target, wrapper, type) {
      assert.equal(namespace, MODULE_ID);
      assert.equal(type, "WRAPPER");
      registrations.set(target, wrapper);
    }
  };
});

function character(level = 10) {
  return { type: "character", level, flags: { pf2e: {} }, synthetics: { modifiers: {} } };
}

function prepare(actor, ...args) {
  installABPSpellAttacks();
  const wrapper = registrations.get(TARGET);
  assert.equal(typeof wrapper, "function");
  let nativeCalls = 0;
  const nativeResult = {};
  const result = wrapper((...received) => {
    nativeCalls += 1;
    assert.deepEqual(received, [actor, ...args]);
    actor.synthetics.modifiers["strike-attack-roll"] = [() => ({ native: true })];
    return nativeResult;
  }, actor, ...args);
  assert.equal(nativeCalls, 1);
  assert.equal(result, nativeResult, "The wrapper must preserve the native return value");
  return actor.synthetics.modifiers;
}

test("ABP spell attacks is an opt-in world setting with a reload prompt", () => {
  registerMiscSettings();
  const config = settings.get(`${MODULE_ID}.abpSpellAttacks`);
  assert.equal(config.name, "Apply ABP attack potency to spell attacks");
  assert.equal(config.scope, "world");
  assert.equal(config.type, Boolean);
  assert.equal(config.default, false);
  assert.equal(config.config, true);
  assert.equal(config.requiresReload, true);
  assert.match(config.hint, /House rule/);
});

test("miscellaneous heading appears only above this setting and survives repeated renders", () => {
  registerMiscSettings();
  const { document } = new JSDOM(`<form>
    <div class="form-group"><input name="another-module.option"></div>
    <div class="form-group" id="abp"><input name="${MODULE_ID}.abpSpellAttacks"></div>
  </form>`).window;
  const render = hooks.get("renderSettingsConfig");
  render({}, document.body);
  render({}, document.body);
  assert.equal(document.querySelectorAll(".pza-misc-settings-heading").length, 1);
  assert.equal(document.querySelector("#abp").previousElementSibling.textContent, "Miscellaneous");
  document.querySelector("#abp").remove();
  document.querySelector("h3").remove();
  render({}, document.body);
  assert.equal(document.querySelectorAll("h3").length, 0);
});

test("spell attack potency follows native ABP at every progression boundary in either mode", () => {
  for (const variant of ["ABPRulesAsWritten", "ABPFundamentalPotency"]) {
    mode = variant;
    for (const [level, expected] of potencyByLevel) {
      const modifiers = prepare(character(level), "extra-argument");
      assert.equal(modifiers["spell-attack-roll"]?.length ?? 0, expected > 0 ? 1 : 0);
      assert.deepEqual(modifiers["strike-attack-roll"][0](), { native: true });
      assert.deepEqual(Object.keys(modifiers).sort(), expected > 0
        ? ["spell-attack-roll", "strike-attack-roll"] : ["strike-attack-roll"],
      "No DC, damage, general attack, or impulse selectors may be added");
      if (expected === 0) continue;
      const factory = modifiers["spell-attack-roll"][0];
      const bonus = factory();
      assert.deepEqual({ ...bonus }, {
        slug: "attack-potency", label: "PF2E.AutomaticBonusProgression.attackPotency",
        modifier: expected, type: "potency"
      });
      assert.notEqual(factory(), bonus, "Each statistic must get an independent modifier instance");
    }
  }
  assert.equal(potencyLevels.length, potencyByLevel.size * 2);
});

test("disabling the module option or ABP preserves native modifiers without a spell bonus", () => {
  enabled = false;
  assert.equal(prepare(character())["spell-attack-roll"], undefined);
  enabled = true;
  mode = "noABP";
  assert.equal(prepare(character())["spell-attack-roll"], undefined);
  assert.deepEqual(potencyLevels, []);
});

test("individual ABP opt-out and non-character actors receive no spell bonus", () => {
  const optedOut = character();
  optedOut.flags.pf2e.disableABP = true;
  assert.equal(prepare(optedOut)["spell-attack-roll"], undefined);
  for (const type of ["npc", "familiar", "hazard"]) {
    const actor = character();
    actor.type = type;
    assert.equal(prepare(actor)["spell-attack-roll"], undefined);
  }
  assert.deepEqual(potencyLevels, []);
});

test("existing spell attack modifiers are retained", () => {
  const actor = character();
  const existing = () => ({ slug: "existing-status-bonus", type: "status", modifier: 1 });
  actor.synthetics.modifiers["spell-attack-roll"] = [existing];
  const modifiers = prepare(actor);
  assert.equal(modifiers["spell-attack-roll"].length, 2);
  assert.equal(modifiers["spell-attack-roll"][0], existing);
});

test("fresh actor preparation removes the bonus when disabled and does not accumulate modifiers", () => {
  const actor = character();
  assert.equal(prepare(actor)["spell-attack-roll"].length, 1);
  actor.synthetics.modifiers = {};
  assert.equal(prepare(actor)["spell-attack-roll"].length, 1);
  enabled = false;
  actor.synthetics.modifiers = {};
  assert.equal(prepare(actor)["spell-attack-roll"], undefined);
});

test("installation skips other systems and rejects an incompatible PF2e interface", () => {
  game.system.id = "other";
  installABPSpellAttacks();
  assert.equal(registrations.size, 0);
  game.system.id = "pf2e";
  delete game.pf2e.variantRules.AutomaticBonusProgression.getAttackPotency;
  assert.throws(installABPSpellAttacks, /interface or libWrapper is unavailable/);
  assert.equal(registrations.size, 0);
});
