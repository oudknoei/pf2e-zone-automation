import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { actorLoreSkills, bestKnowledgeSkill, creatureKnowledgeDC, creatureType, knowledgeDegree, loreKnowledgeDCAdjustment } from "../scripts/recall-knowledge-rules.js";
import { executeAskQuestion, QUESTION_MESSAGE_FLAG } from "../scripts/recall-knowledge-worker.js";
import { compactCreatureData } from "../scripts/recall-knowledge-data.js";
import { openAskQuestion, registerQuestionChat } from "../scripts/recall-knowledge.js";
import { DEFAULT_KNOWLEDGE_PROMPT } from "../scripts/recall-knowledge-prompt.js";

const MODULE_ID = "pf2e-zone-automation";
let operationCounter = 0;

function statistic(label, modifier, lore = false) {
  return {
    label, lore, check: { mod: modifier },
    withRollOptions(options) {
      assert.ok(options.extraRollOptions.includes("action:recall-knowledge"));
      return { check: { mod: modifier + (options.target && label === "Arcana" ? 2 : 0) } };
    }
  };
}

function setup() {
  const gm = { id: "gm", isGM: true, active: true, name: "GM" };
  const secondGM = { id: "second-gm", isGM: true, active: false, name: "Other GM" };
  const player = { id: "player", isGM: false, active: true, name: "Player" };
  const users = [gm, secondGM, player];
  users.get = (id) => users.find((user) => user.id === id);
  users.activeGM = gm;
  const skills = {
    arcana: statistic("Arcana", 8), crafting: statistic("Crafting", 12),
    nature: statistic("Nature", 7), society: statistic("Society", 6),
    religion: statistic("Religion", 9), occultism: statistic("Occultism", 5),
    "dragon-lore": statistic("Dragons of the Inner Sea", 10, true),
    "sailing-lore": statistic("Sailing Lore", 1, true)
  };
  const source = {
    name: "Scholar", type: "character", isOwner: true,
    skills, system: { skills: Object.fromEntries(Object.entries(skills).map(([slug, skill]) => [slug, { lore: skill.lore }])) },
    getStatistic: (slug) => skills[slug],
    testUserPermission: (user, permission) => user === player && permission === "OWNER"
  };
  const creature = {
    name: "Clockwork Drake", type: "npc", level: 4, rarity: "uncommon",
    system: { traits: { value: ["construct", "dragon", "fire"], rarity: "uncommon" } },
    toObject(source = true) {
      return {
        name: this.name, type: this.type, system: {
          ...this.system, details: { level: { value: this.level }, publicNotes: "Brass scales" },
          ...(source ? {} : { attributes: { ac: { value: 22 }, hp: { value: 37, max: 65 } } })
        },
        items: [{ name: "Burning Breath", type: "action", system: { description: { value: "A fiery cone" } } },
          { name: "Ignition", type: "spell", system: { level: { value: 2 } } }]
      };
    }
  };
  const sourceToken = { documentName: "Token", uuid: "Scene.scene.Token.scholar", actor: source, name: "Scholar", parent: { id: "scene" } };
  const targetToken = { documentName: "Token", uuid: "Scene.scene.Token.drake", actor: creature, name: "Unknown Creature", parent: { id: "scene" }, hidden: false };
  const messages = [];
  const notifications = [];
  const rolls = [];
  const fixture = { gm, player, users, source, creature, sourceToken, targetToken, messages, notifications, rolls, natural: 10 };
  globalThis.CONFIG = { PF2E: { creatureTraits: {} } };
  globalThis.game = { user: gm, system: { id: "pf2e" }, users, messages: { contents: messages }, i18n: { localize: (key) => key },
    settings: { get: () => assert.fail("New questions must use the built-in prompt without reading world settings") } };
  globalThis.ui = { notifications: Object.fromEntries(["warn", "error", "info"].map((level) => [level, (text) => notifications.push({ level, text })])) };
  globalThis.fromUuid = async (uuid) => [sourceToken, targetToken].find((token) => token.uuid === uuid);
  globalThis.Roll = class {
    constructor(formula, data) { this.formula = formula; this.data = data; }
    async evaluate() {
      rolls.push(this);
      this.total = fixture.natural + this.data.modifier;
      this.dice = [{ results: [{ result: fixture.natural, active: true }] }];
      return this;
    }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor, token }) => ({ alias: actor.name, token: token.uuid }),
    async create(data) {
      const message = { ...data, id: `message-${messages.length + 1}` };
      messages.push(message);
      return message;
    }
  };
  return fixture;
}

function request(fixture, extra = {}) {
  return {
    operationId: `question-${String(++operationCounter).padStart(12, "0")}`,
    requesterUserId: fixture.player.id,
    sourceTokenUuid: fixture.sourceToken.uuid, targetTokenUuid: fixture.targetToken.uuid,
    question: "What is its weakest defense?", loreSlug: null, ...extra
  };
}

test("Lore list belongs to the source and preserves custom display names", () => {
  const f = setup();
  assert.deepEqual(actorLoreSkills(f.source).map(({ slug, label, modifier }) => ({ slug, label, modifier })), [
    { slug: "dragon-lore", label: "Dragons of the Inner Sea", modifier: 10 },
    { slug: "sailing-lore", label: "Sailing Lore", modifier: 1 }
  ]);
});

test("best identification skill combines every creature trait and contextual bonuses", () => {
  const f = setup();
  assert.equal(bestKnowledgeSkill(f.source, f.creature).slug, "crafting");
  f.creature.system.traits.value = ["dragon", "beast"];
  assert.deepEqual(bestKnowledgeSkill(f.source, f.creature), { slug: "arcana", label: "Arcana", modifier: 10, lore: false });
  f.creature.identificationDCs = { skills: ["religion"] };
  assert.equal(bestKnowledgeSkill(f.source, f.creature).slug, "religion", "Use PF2e's prepared identification skill list when available");
});

test("chosen Lore lowers its DC without changing its bonus and wins only when the check is better", () => {
  const f = setup();
  const best = bestKnowledgeSkill(f.source, f.creature, "dragon-lore");
  assert.equal(best.modifier, 10);
  assert.equal(best.dcAdjustment, -5);
  assert.equal(bestKnowledgeSkill(f.source, f.creature, "sailing-lore").slug, "crafting");
  f.source.skills["sailing-lore"].check.mod = 10;
  f.source.skills["sailing-lore"].withRollOptions = () => ({ check: { mod: 10 } });
  const unmatched = bestKnowledgeSkill(f.source, f.creature, "sailing-lore");
  assert.equal(unmatched.modifier, 10);
  assert.equal(unmatched.dcAdjustment, -3);
  f.source.skills["sailing-lore"].withRollOptions = () => ({ check: { mod: 9 } });
  assert.equal(bestKnowledgeSkill(f.source, f.creature, "sailing-lore").slug, "crafting", "The ordinary skill wins a tie");
  assert.throws(() => bestKnowledgeSkill(f.source, f.creature, "invented-lore"), /no longer belongs/);
});

test("trait matching handles slugs, display names, plurals and punctuation without matching word fragments", () => {
  const f = setup();
  for (const [traits, slug, label, expected] of [
    [["dragon"], "dragon-lore", "Scholarly Lore", -5],
    [["dragon"], "scholarly-lore", "Dragons Lore", -5],
    [["dragon"], "scholarly-lore", "Ancient DRAGON (Lore)", -5],
    [["elf"], "elves-lore", "Elves Lore", -5],
    [["dwarf"], "dwarves-lore", "Dwarves Lore", -5],
    [["sea-devil"], "sea-devils-lore", "Sea Devils Lore", -5],
    [["dragon"], "dragonfly-lore", "Dragonfly Lore", -3],
    [["dragon"], "sailing-lore", "Sailing Lore", -3],
    [["construct", "dragon", "fire"], "fire-lore", "Fire Lore", -5],
    [[], "dragon-lore", "Dragon Lore", -3]
  ]) {
    f.creature.system.traits.value = traits;
    assert.equal(loreKnowledgeDCAdjustment(f.creature, { slug, label }), expected, label);
  }
});

test("unmapped creature needs applicable Lore instead of inventing a skill", () => {
  const f = setup();
  f.creature.system.traits.value = ["fire"];
  assert.throws(() => bestKnowledgeSkill(f.source, f.creature), /No applicable/);
  assert.equal(bestKnowledgeSkill(f.source, f.creature, "dragon-lore").slug, "dragon-lore");
  assert.equal(creatureType(f.creature), "Unspecified creature type");
});

test("Recall Knowledge DC includes level and rarity and prefers PF2e variant DCs", () => {
  const f = setup();
  for (const [rarity, dc] of [["common", 19], ["uncommon", 21], ["rare", 24], ["unique", 29]]) {
    f.creature.rarity = rarity;
    assert.equal(creatureKnowledgeDC(f.creature), dc);
  }
  f.creature.identificationDCs = { standard: { dc: 17 } };
  assert.equal(creatureKnowledgeDC(f.creature), 17);
  delete f.creature.identificationDCs;
  f.creature.rarity = "common";
  f.creature.level = -1;
  assert.equal(creatureKnowledgeDC(f.creature), 14);
  f.creature.level = 26;
  assert.throws(() => creatureKnowledgeDC(f.creature), /could not be determined/);
});

test("degrees handle both ten-point boundaries and natural die adjustments without exceeding bounds", () => {
  for (const [total, natural, expected] of [
    [30, 10, "Critical Success"], [20, 10, "Success"], [19, 10, "Failure"], [10, 10, "Critical Failure"],
    [11, 10, "Failure"], [30, 1, "Success"], [20, 1, "Failure"], [19, 1, "Critical Failure"],
    [5, 20, "Failure"], [19, 20, "Success"], [20, 20, "Critical Success"],
    [30, 20, "Critical Success"], [5, 1, "Critical Failure"]
  ]) assert.equal(knowledgeDegree(total, 20, natural), expected);
});

test("creature reference keeps factual data and conditional rules while removing bookkeeping without mutating documents", () => {
  const actor = setup().creature.toObject();
  Object.assign(actor, { img: "portrait.webp", folder: "folder-id", ownership: { default: 0 },
    prototypeToken: { texture: { src: "token.webp" } }, _stats: { createdTime: 123 }, flags: { notes: "A secret pact" } });
  actor.system._migration = { version: 1 };
  actor.system.details.privateNotes = "Only silver breaks the ward.";
  actor.system.attributes = { resistances: [{ type: "physical", value: 5, exceptions: ["silver"], typeLabels: { fire: "Fire" } }] };
  const rules = [{ key: "FlatModifier", value: 1, selector: "saving-throw", predicate: ["item:magical"],
    disabled: false, extra: null, options: {}, choice: "" }];
  actor.items[0].system.rules = rules;
  actor.items[0].system.description.gm = "The flame gutters in rain.";
  actor.items[0]._stats = { modifiedTime: 456 };
  const current = structuredClone(actor.system);
  current.saves = { reflex: { value: 18, breakdown: "Base +16, vs. magic +1", modifiers: [{
    label: "Magic ward", modifier: 1, type: "status", predicate: ["item:magical"],
    adjustments: [{ predicate: ["target:trait:dragon"], value: 2 }], enabled: false, ignored: true,
    domains: ["saving-throw"], hideIfDisabled: false, kind: "modifier", force: false, custom: false
  }] } };
  const before = structuredClone({ actor, current });
  const data = compactCreatureData(actor, current);
  assert.deepEqual({ actor, current }, before);
  for (const key of ["img", "folder", "ownership", "prototypeToken", "_stats"]) assert.equal(Object.hasOwn(data.actor, key), false);
  assert.doesNotMatch(JSON.stringify(data), /typeLabels|_migration|modifiedTime|domains|breakdown/);
  assert.equal(data.actor.system.details.privateNotes, "Only silver breaks the ward.");
  assert.deepEqual(data.actor.system.attributes.resistances, [{ type: "physical", value: 5, exceptions: ["silver"] }]);
  assert.deepEqual(data.actor.items[0].system.rules, rules);
  assert.equal(data.actor.items[0].system.description.gm, "The flame gutters in rain.");
  assert.equal(data.actor.items[1].system.level.value, 2);
  assert.equal(data.actor.flags.notes, "A secret pact");
  assert.deepEqual(data.currentSystem.saves.reflex.modifiers, [{ label: "Magic ward", modifier: 1,
    type: "status", predicate: ["item:magical"], adjustments: [{ predicate: ["target:trait:dragon"], value: 2 }],
    enabled: false, ignored: true }]);
});

test("prepared changes retain cleared fields, current values and altered strike damage through item references", () => {
  const actor = setup().creature.toObject();
  actor.system.attributes = { hp: { value: 65, max: 65 }, immunities: [{ type: "fire" }] };
  const weapon = { _id: "hammer", name: "Hammer", type: "melee", system: {
    bonus: { value: 19 }, damageRolls: { base: { damage: "1d6+6", damageType: "bludgeoning" } }
  } };
  actor.items.push(weapon);
  const current = structuredClone(actor.system);
  current.attributes.hp.value = 37;
  current.attributes.immunities = [];
  const alteredWeapon = structuredClone(weapon);
  alteredWeapon.system.damageRolls.fire = { damage: "1d6", damageType: "fire" };
  alteredWeapon.system.bonus.value = 0;
  const unrelated = { _id: "unrelated", name: "New strike", type: "melee", system: { bonus: { value: 10 } } };
  current.actions = [{ label: "Hammer", totalModifier: 19, item: alteredWeapon, weapon }, { item: unrelated }];
  const data = compactCreatureData(actor, current);
  assert.equal(data.currentSystem.details, undefined, "Unchanged notes should only appear once");
  assert.deepEqual(data.currentSystem.attributes, { hp: { value: 37 }, immunities: null });
  assert.deepEqual(data.currentSystem.actions[0].weapon, { itemReference: "hammer" });
  const { itemReference, currentData } = data.currentSystem.actions[0].item;
  assert.equal(itemReference, "hammer");
  assert.deepEqual(currentData, { system: { bonus: { value: 0 }, damageRolls: { fire: { damage: "1d6", damageType: "fire" } } } });
  assert.deepEqual(data.currentSystem.actions[1].item, unrelated, "Keep a full item when no source reference exists");
  assert.equal(compactCreatureData(actor, actor.system).currentSystem, undefined);
});

test("private GM prompt exports live strike documents without traversing their circular actor references", async () => {
  const f = setup();
  const actor = f.creature.toObject();
  const exportedItem = { _id: "hammer", name: "Hammer", type: "melee", system: {
    damageRolls: { base: { damage: "1d6+6", damageType: "bludgeoning" } }
  } };
  actor.items.push(exportedItem);
  const currentSystem = structuredClone(actor.system);
  currentSystem.attributes = { hp: { value: 37, max: 65 }, ac: { value: 22 } };
  const runtimeActor = { system: currentSystem, items: [] };
  let exports = 0;
  const liveItem = {
    _source: exportedItem, parent: runtimeActor,
    toJSON() { exports += 1; return this._source; }
  };
  runtimeActor.items.push(liveItem);
  currentSystem.actions = [{ label: "Hammer", totalModifier: 19, item: liveItem, weapon: liveItem }];
  f.creature.toObject = (source = true) => source ? actor : { system: currentSystem };
  assert.deepEqual(await executeAskQuestion(request(f)), { action: "ask-question", messageId: "message-1" });
  assert.equal(f.rolls.length, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(exports, 2, "Both strike references must use the document's JSON export");
  const prompt = f.messages[0].flags[MODULE_ID][QUESTION_MESSAGE_FLAG].prompt;
  const data = JSON.parse(prompt.slice(prompt.indexOf("\n{") + 1));
  assert.deepEqual(data.currentSystem.actions[0].item, { itemReference: "hammer" });
  assert.deepEqual(data.currentSystem.actions[0].weapon, { itemReference: "hammer" });
  assert.deepEqual(data.actor.items.find((item) => item._id === "hammer").system.damageRolls,
    exportedItem.system.damageRolls);
  assert.deepEqual(data.currentSystem.attributes.hp, { value: 37, max: 65 });
  assert.doesNotMatch(prompt, /"_source"|"parent"/);
  assert.equal(liveItem.parent, runtimeActor);
  assert.equal(runtimeActor.system.actions[0].item, liveItem);
});

test("circular runtime references are omitted while shared sibling modifiers and rule data remain complete", () => {
  const actor = setup().creature.toObject();
  const modifier = { label: "Magic ward", modifier: 1, type: "status", predicate: ["item:magical"], enabled: true };
  const current = structuredClone(actor.system);
  current.saves = {
    fortitude: { value: 21, modifiers: [modifier] }, reflex: { value: 18, modifiers: [modifier] }
  };
  current.parent = current;
  const circularArray = [];
  circularArray.push(circularArray, { label: "Magic ward", value: 1 });
  current.runtimeNotes = circularArray;
  const rules = [{ key: "FlatModifier", value: 0, predicate: [], ignored: false, options: {}, source: null }];
  actor.items[0].system.rules = rules;
  const data = compactCreatureData(actor, current);
  assert.deepEqual(data.currentSystem.saves.fortitude.modifiers, [modifier]);
  assert.deepEqual(data.currentSystem.saves.reflex.modifiers, [modifier], "A shared object is not a circular reference");
  assert.equal(Object.hasOwn(data.currentSystem, "parent"), false);
  assert.deepEqual(data.currentSystem.runtimeNotes, [null, { label: "Magic ward", value: 1 }]);
  assert.deepEqual(data.actor.items[0].system.rules, rules);
  assert.doesNotThrow(() => JSON.stringify(data));
  assert.equal(current.parent, current);
  assert.equal(current.saves.reflex.modifiers[0], modifier);
});

test("private GM prompt includes creature facts but response contains no secret result", async () => {
  const f = setup();
  const response = await executeAskQuestion(request(f, { loreSlug: "dragon-lore", question: 'Is <script>alert("hi")</script> its weakest defense?' }));
  assert.deepEqual(response, { action: "ask-question", messageId: "message-1" });
  assert.equal(f.rolls.length, 1);
  const card = f.messages[0];
  assert.equal(card.author, f.gm.id, "The player must not be the author of the secret chat");
  assert.deepEqual(card.whisper, ["gm", "second-gm"]);
  assert.equal(card.blind, true);
  assert.match(card.content, /Type:<\/strong> Construct, Dragon/);
  assert.match(card.content, /Traits:<\/strong> Construct, Dragon, Fire/);
  const dom = new JSDOM(card.content);
  assert.equal(dom.window.document.querySelector("script"), null);
  const prompt = dom.window.document.querySelector("[data-pza-knowledge-prompt]").textContent;
  assert.match(prompt, /QUESTION: "Is <script>/);
  assert.match(prompt, /RESULT: Success/);
  assert.match(prompt, /SKILL USED: Dragons of the Inner Sea \(Lore DC -5: creature trait match\)/);
  assert.match(prompt, /ROLL: d20 10 \+ modifier 10 = 20; DC 16/);
  assert.equal(f.rolls[0].data.modifier, 10);
  assert.doesNotMatch(prompt, /\+5 applicable Lore|modifier 15/);
  assert.match(prompt, /Burning Breath/);
  assert.match(prompt, /Ignition/);
  assert.match(prompt, /"max": 65/);
  assert.match(prompt, /materially FALSE/);
  assert.match(prompt, /Never falsify or omit that opening/);
  dom.window.close();
});

test("new questions use the built-in instructions while existing cards keep their saved prompts", async () => {
  const f = setup();
  await executeAskQuestion(request(f));
  const saved = f.messages[0].flags[MODULE_ID][QUESTION_MESSAGE_FLAG];
  const original = saved.prompt;
  assert.equal(saved.instructions, DEFAULT_KNOWLEDGE_PROMPT);
  assert.ok(original.startsWith(`${DEFAULT_KNOWLEDGE_PROMPT}\n\nPLAYER:`));
  assert.match(original, /QUESTION: "What is its weakest defense\?"/);
  assert.match(original, /RESULT: Success/);
  assert.match(original, /CREATURE TYPE \(ALWAYS REVEAL\): Construct, Dragon/);
  assert.match(original, /CREATURE TRAITS \(ALWAYS REVEAL\): Construct, Dragon, Fire/);
  assert.match(original, /"name": "Burning Breath"/);
  saved.instructions = "Older customized instructions.";
  saved.prompt = `${saved.instructions}\n\n${saved.input}`;
  const olderPrompt = saved.prompt;
  await executeAskQuestion(request(f));
  assert.ok(f.messages[1].flags[MODULE_ID][QUESTION_MESSAGE_FLAG].prompt.startsWith(DEFAULT_KNOWLEDGE_PROMPT));
  assert.equal(saved.prompt, olderPrompt);
});

test("nonmatching Lore uses its normal bonus against DC minus three in chat and the copied prompt", async () => {
  const f = setup();
  f.source.skills["sailing-lore"] = statistic("Sailing Lore", 10, true);
  await executeAskQuestion(request(f, { loreSlug: "sailing-lore" }));
  assert.equal(f.rolls[0].data.modifier, 10);
  assert.match(f.messages[0].content, /Sailing Lore \(Lore DC -3\).*20 vs. DC 18/);
  const prompt = f.messages[0].flags[MODULE_ID][QUESTION_MESSAGE_FLAG].prompt;
  assert.match(prompt, /ROLL: d20 10 \+ modifier 10 = 20; DC 18/);
  assert.match(prompt, /RESULT: Success/);
});

test("a better ordinary skill keeps the full creature DC even when Lore is selected", async () => {
  const f = setup();
  await executeAskQuestion(request(f, { loreSlug: "sailing-lore" }));
  assert.equal(f.rolls[0].data.modifier, 12);
  const prompt = f.messages[0].flags[MODULE_ID][QUESTION_MESSAGE_FLAG].prompt;
  assert.match(prompt, /SKILL USED: Crafting\n/);
  assert.match(prompt, /ROLL: d20 10 \+ modifier 12 = 22; DC 21/);
});

test("every result reports truthful type and traits and records the degree for the LLM", async () => {
  for (const [natural, expected] of [[1, "Critical Failure"], [5, "Failure"], [10, "Success"], [20, "Critical Success"]]) {
    const f = setup();
    f.natural = natural;
    await executeAskQuestion(request(f));
    assert.match(f.messages[0].content, new RegExp(`RESULT: ${expected}`));
    assert.match(f.messages[0].content, /Type:<\/strong> Construct, Dragon/);
    assert.match(f.messages[0].content, /Traits:<\/strong> Construct, Dragon, Fire/);
  }
});

test("duplicate requests share one roll and one message, and changed replays are rejected", async () => {
  const f = setup();
  const payload = request(f);
  const responses = await Promise.all([executeAskQuestion(payload), executeAskQuestion(payload)]);
  assert.deepEqual(responses[0], responses[1]);
  assert.equal(f.rolls.length, 1);
  assert.equal(f.messages.length, 1);
  assert.deepEqual(await executeAskQuestion(payload), responses[0]);
  await assert.rejects(executeAskQuestion({ ...payload, question: "Different question" }), /reused with different details/);
});

test("retry after chat creation failure uses the already-rolled result", async () => {
  const f = setup();
  const payload = request(f);
  const create = ChatMessage.create;
  ChatMessage.create = async () => { throw new Error("Chat temporarily unavailable"); };
  await assert.rejects(executeAskQuestion(payload), (error) => error.retryable === true);
  ChatMessage.create = create;
  await executeAskQuestion(payload);
  assert.equal(f.rolls.length, 1);
  assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].flags[MODULE_ID][QUESTION_MESSAGE_FLAG].prompt.startsWith(DEFAULT_KNOWLEDGE_PROMPT));
});

test("a server-confirmed message is recovered when creation throws after posting", async () => {
  const f = setup();
  const create = ChatMessage.create;
  ChatMessage.create = async (data) => { await create(data); throw new Error("Late acknowledgement failure"); };
  assert.deepEqual(await executeAskQuestion(request(f)), { action: "ask-question", messageId: "message-1" });
  assert.equal(f.rolls.length, 1);
  assert.equal(f.messages.length, 1);
});

test("GM authorization rejects unowned actors, hidden targets, other Scenes and invalid Lore before rolling", async () => {
  for (const [change, expected] of [
    [(f) => { f.source.testUserPermission = () => false; }, /must own/],
    [(f) => { f.targetToken.hidden = true; }, /hidden/],
    [(f) => { f.targetToken.parent.id = "other-scene"; }, /same Scene/],
    [(f) => { f.player.active = false; }, /no longer active/],
    [(f) => { game.user = f.player; }, /resolved by a GM/],
    [(f) => { f.creature.type = "hazard"; }, /creature Actor/]
  ]) {
    const f = setup();
    change(f);
    await assert.rejects(executeAskQuestion(request(f)), expected);
    assert.equal(f.rolls.length, 0);
    assert.equal(f.messages.length, 0);
  }
  const f = setup();
  await assert.rejects(executeAskQuestion(request(f, { loreSlug: "invented-lore" })), /no longer belongs/);
  await assert.rejects(executeAskQuestion(request(f, { question: " " })), /Enter a question/);
  await assert.rejects(executeAskQuestion(request(f, { question: "x".repeat(2001) })), /2,000/);
  assert.equal(f.rolls.length, 0);
});

test("macro requires target and controlled token before opening a dialog", async () => {
  const f = setup();
  game.user = f.player;
  game.user.targets = new Set();
  globalThis.canvas = { tokens: { controlled: [] } };
  assert.equal(await openAskQuestion(), null);
  assert.match(f.notifications.at(-1).text, /Target exactly one/);
  game.user.targets.add({ actor: f.creature });
  assert.equal(await openAskQuestion(), null);
  assert.match(f.notifications.at(-1).text, /Select exactly one/);
});

test("dialog captures Lore from the selected token and Cancel closes without a roll", async () => {
  const f = setup();
  const dom = new JSDOM("<!doctype html>");
  globalThis.document = dom.window.document;
  globalThis.foundry = { applications: { api: { DialogV2: class {
    constructor(options) { this.options = options; this.listeners = new Map(); }
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    async render() { this.rendered = true; }
    async close() { this.rendered = false; this.listeners.get("close")?.(); }
    bringToFront() {}
  } } } };
  game.user = f.player;
  game.user.targets = new Set([{ actor: f.creature, document: f.targetToken, name: "Unknown Creature" }]);
  globalThis.canvas = { tokens: { controlled: [{ actor: f.source, document: f.sourceToken, name: "Scholar" }] } };
  const dialog = await openAskQuestion();
  assert.equal(dialog.options.window.title, "Ask a question about ...");
  const options = [...dialog.options.content.querySelectorAll("option")];
  assert.deepEqual(options.map((option) => option.value), ["", "dragon-lore", "sailing-lore"]);
  assert.match(options[1].textContent, /Dragons of the Inner Sea \(\+10\)/);
  assert.equal(dialog.options.content.querySelector(".hint").textContent, "Choose a Lore only if it applies to your question");
  assert.doesNotMatch(dialog.options.content.textContent, /Clockwork Drake/, "Show the visible token name, not the secret Actor identity");
  await dialog.options.buttons.find((button) => button.action === "cancel").callback();
  assert.equal(dialog.rendered, false);
  assert.equal(f.rolls.length, 0);
  dom.window.close();
});

test("GM Copy button copies the entire prompt after chat renders and provides a manual fallback", async () => {
  const f = setup();
  await executeAskQuestion(request(f));
  let hook;
  globalThis.Hooks = { on: (_name, listener) => { hook = listener; return 1; }, off: () => {} };
  const unregister = registerQuestionChat();
  const card = f.messages[0];
  const dom = new JSDOM(card.content);
  const html = dom.window.document;
  const button = html.querySelector("button[data-pza-copy-knowledge]");
  const savedPrompt = card.flags[MODULE_ID][QUESTION_MESSAGE_FLAG].prompt;
  html.querySelector("pre").textContent = "Text changed by Foundry enrichment";
  const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { copied = text; } } } });
  try {
    hook(card, html);
    assert.equal(html.querySelector("pre").textContent, savedPrompt);
    hook(card, html);
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(copied, html.querySelector("pre").textContent);
    assert.equal(f.notifications.filter(({ text }) => text === "Prompt copied.").length, 1);
    navigator.clipboard.writeText = async () => { throw new Error("Clipboard permission denied"); };
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(html.querySelector("details").open, true);
    assert.equal(dom.window.getSelection().toString(), copied);
    game.user = f.player;
    hook(card, html);
    assert.equal(html.querySelector("button"), null);
  } finally {
    if (nativeNavigator) Object.defineProperty(globalThis, "navigator", nativeNavigator);
    else delete globalThis.navigator;
    unregister();
    dom.window.close();
  }
});
