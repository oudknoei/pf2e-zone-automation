import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clearKnowledgeApiKey, hasKnowledgeApiKey, KNOWLEDGE_AI_TIMEOUT_MS, knowledgeLocalAIStatus,
  parseKnowledgeAIResponse, queueKnowledgeAnswer, reconcileKnowledgeAI, setKnowledgeApiKey } from "../scripts/recall-knowledge-ai.js";
import { DEFAULT_KNOWLEDGE_API_ENDPOINT, DEFAULT_KNOWLEDGE_MODEL, KNOWLEDGE_API_ENDPOINT_SETTING,
  KNOWLEDGE_MODEL_SETTING, normalizeKnowledgeEndpoint } from "../scripts/recall-knowledge-ai-config.js";
import { DEFAULT_KNOWLEDGE_PROMPT, KNOWLEDGE_PROMPT_SETTING } from "../scripts/recall-knowledge-prompt.js";
import { executeAskQuestion } from "../scripts/recall-knowledge-worker.js";
import { registerQuestionChat } from "../scripts/recall-knowledge.js";
import { openKnowledgeAIConnection, registerKnowledgeAISettings } from "../scripts/recall-knowledge-settings.js";
import { QUESTION_MODULE_ID as MODULE_ID, QUESTION_MESSAGE_FLAG as FLAG } from "../scripts/recall-knowledge-message.js";

const KEY = "fake-session-secret-do-not-persist";
let counter = 0;
function marker(message) { return message.flags[MODULE_ID][FLAG]; }
function response(answer = "You recall a warning about the drake's flame.") {
  return { id: "resp-test", status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: answer }] }] };
}
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("The expected async state did not arrive");
}
function setup() {
  clearKnowledgeApiKey();
  const gm = { id: "gm", isGM: true, active: true, name: "GM" };
  const secondGM = { id: "other-gm", isGM: true, active: true };
  const player = { id: "player", isGM: false, active: true, name: "Player" };
  const users = [gm, secondGM, player];
  users.get = (id) => users.find((user) => user.id === id);
  users.activeGM = gm;
  const values = new Map([[KNOWLEDGE_API_ENDPOINT_SETTING, DEFAULT_KNOWLEDGE_API_ENDPOINT],
    [KNOWLEDGE_MODEL_SETTING, DEFAULT_KNOWLEDGE_MODEL], [KNOWLEDGE_PROMPT_SETTING, DEFAULT_KNOWLEDGE_PROMPT]]);
  const f = { gm, secondGM, player, users, values, messages: [], requests: [], writes: [], notifications: [], rolls: 0, fetch: null };
  globalThis.game = { world: { id: `world-${++counter}` }, user: gm, users, system: { id: "pf2e" }, i18n: { localize: (key) => key },
    settings: { get: (_namespace, key) => values.get(key) },
    messages: { contents: f.messages, get: (id) => f.messages.find((message) => message.id === id) } };
  globalThis.ui = { notifications: Object.fromEntries(["warn", "error", "info"].map((level) => [level, (text) => f.notifications.push({ level, text })])) };
  globalThis.CONFIG = { PF2E: { creatureTraits: {} } };
  const source = { name: "Scholar", type: "character", skills: { arcana: { label: "Arcana", check: { mod: 10 } } },
    testUserPermission: (user) => user === player };
  const creature = { name: "Drake", type: "npc", level: 4, system: { traits: { value: ["dragon", "fire"] } },
    toObject() { return { name: this.name, type: this.type, system: this.system, items: [{ name: "Flame Breath", type: "action" }] }; } };
  const sourceToken = { documentName: "Token", uuid: "Scene.scene.Token.source", actor: source, parent: { id: "scene" } };
  const targetToken = { documentName: "Token", uuid: "Scene.scene.Token.target", actor: creature, parent: { id: "scene" } };
  globalThis.fromUuid = async (uuid) => [sourceToken, targetToken].find((token) => token.uuid === uuid);
  globalThis.Roll = class {
    constructor(_formula, data) { this.data = data; }
    async evaluate() { f.rolls++; this.total = 10 + this.data.modifier; this.dice = [{ results: [{ result: 10 }] }]; return this; }
  };
  globalThis.ChatMessage = {
    getSpeaker: () => ({ alias: "Scholar" }),
    async create(data) {
      const message = { ...data, id: `message-${f.messages.length + 1}`, async update(changes) {
        await f.beforeUpdate?.(message, changes);
        f.writes.push(structuredClone(changes));
        marker(message).ai = { ...marker(message).ai, ...structuredClone(changes[`flags.${MODULE_ID}.${FLAG}.ai`]) };
      } };
      f.messages.push(message);
      return message;
    }
  };
  globalThis.fetch = async (url, options) => {
    f.requests.push({ url, options });
    return f.fetch ? f.fetch(url, options) : { ok: true, json: async () => response() };
  };
  f.ask = async () => executeAskQuestion({ operationId: `ai-question-${String(++counter).padStart(12, "0")}`,
    requesterUserId: player.id, sourceTokenUuid: sourceToken.uuid, targetTokenUuid: targetToken.uuid,
    question: "How do I survive its flame?" });
  f.card = async () => { await f.ask(); return f.messages.at(-1); };
  return f;
}
test.afterEach(() => clearKnowledgeApiKey());

test("acknowledgment precedes a delayed API call and only GMs receive the answer, with no reroll", async () => {
  const f = setup();
  let finish;
  f.fetch = () => new Promise((resolve) => { finish = resolve; });
  setKnowledgeApiKey(KEY);
  const result = await f.ask();
  assert.deepEqual(result, { action: "ask-question", messageId: "message-1" });
  assert.equal(f.requests.length, 0);
  await until(() => finish);
  assert.equal(f.messages[0].blind, true);
  assert.deepEqual(f.messages[0].whisper, ["gm", "other-gm"]);
  const { url, options } = f.requests[0];
  assert.equal(url, DEFAULT_KNOWLEDGE_API_ENDPOINT);
  assert.equal(options.credentials, "omit");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(options.body);
  assert.equal(body.model, DEFAULT_KNOWLEDGE_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 600);
  assert.equal(body.stream, false);
  assert.equal(body.background, false);
  assert.deepEqual(body.tools, []);
  assert.equal(body.instructions, DEFAULT_KNOWLEDGE_PROMPT);
  assert.match(body.input, /QUESTION: "How do I survive its flame\?"/);
  assert.match(body.input, /RESULT: Success/);
  assert.match(body.input, /Flame Breath/);
  finish({ ok: true, json: async () => response() });
  await until(() => marker(f.messages[0]).ai.status === "complete");
  assert.match(marker(f.messages[0]).ai.answer, /drake's flame/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.rolls, 1);
  assert.doesNotMatch(JSON.stringify([result, f.writes, f.messages, f.notifications]), new RegExp(KEY));
});

test("duplicate requests join one attempt and the queue issues only one network call at a time", async () => {
  const f = setup();
  const first = await f.card();
  const second = await f.card();
  const completions = [];
  f.fetch = () => new Promise((resolve) => completions.push(resolve));
  setKnowledgeApiKey(KEY);
  const start = queueKnowledgeAnswer(first.id);
  assert.equal(queueKnowledgeAnswer(first.id), start);
  await start;
  await queueKnowledgeAnswer(second.id);
  await until(() => completions.length === 1);
  assert.equal(marker(second).ai.status, "queued");
  completions[0]({ ok: true, json: async () => response("First answer") });
  await until(() => completions.length === 2);
  completions[1]({ ok: true, json: async () => response("Second answer") });
  await until(() => marker(second).ai.status === "complete");
  await queueKnowledgeAnswer(first.id);
  assert.equal(f.requests.length, 2);
});

test("entering a key does not submit a backlog, and saved instructions survive later world edits", async () => {
  const f = setup();
  const card = await f.card();
  assert.equal(marker(card).ai.status, "needs-key");
  assert.throws(() => queueKnowledgeAnswer(card.id), /Enter an API key/);
  setKnowledgeApiKey(KEY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  f.values.set(KNOWLEDGE_PROMPT_SETTING, "Different instructions now");
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.equal(JSON.parse(f.requests[0].options.body).instructions, DEFAULT_KNOWLEDGE_PROMPT);
});

test("HTTP, network and invalid answer errors are sanitized; manual retries retain the roll", async () => {
  for (const failure of [401, 403, 404, 429, 500, "network", "json", "empty", "refusal", "incomplete"]) {
    const f = setup();
    const card = await f.card();
    f.fetch = async () => {
      if (typeof failure === "number") return { ok: false, status: failure, json: async () => ({ error: { message: KEY } }) };
      if (failure === "network") throw new Error(KEY);
      if (failure === "json") return { ok: true, json: async () => { throw new Error(KEY); } };
      const data = response(failure === "empty" ? " " : "Unused partial answer");
      if (failure === "refusal") data.output[0].content = [{ type: "refusal", refusal: KEY }];
      if (failure === "incomplete") data.status = "incomplete";
      return { ok: true, json: async () => data };
    };
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "error");
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(JSON.stringify([marker(card), f.notifications]), new RegExp(KEY));
    assert.equal(marker(card).ai.answer, null);
    f.fetch = null;
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "complete");
    assert.equal(f.requests.length, 2);
    assert.equal(f.rolls, 1);
  }
});

test("the separate API timeout stops a request and requires explicit retry", async (t) => {
  const f = setup();
  const card = await f.card();
  f.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  setKnowledgeApiKey(KEY);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await queueKnowledgeAnswer(card.id);
  await until(() => f.requests.length === 1);
  t.mock.timers.tick(KNOWLEDGE_AI_TIMEOUT_MS);
  await until(() => marker(card).ai.status === "error");
  assert.match(marker(card).ai.error, /timed out.*another charge/);
  assert.equal(f.requests.length, 1);
  t.mock.timers.reset();
});

test("chat delivery retry saves a received answer without making another API request", async () => {
  const f = setup();
  const card = await f.card();
  let failDelivery = true;
  f.beforeUpdate = (_message, changes) => {
    if (failDelivery && changes[`flags.${MODULE_ID}.${FLAG}.ai`].status === "complete") throw new Error("Chat offline");
  };
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await until(() => knowledgeLocalAIStatus(card.id)?.status === "delivery-error");
  failDelivery = false;
  const retry = queueKnowledgeAnswer(card.id);
  assert.equal(queueKnowledgeAnswer(card.id), retry);
  await retry;
  assert.equal(marker(card).ai.status, "complete");
  assert.equal(f.requests.length, 1);
  assert.equal(f.rolls, 1);
});

test("clearing the key cancels queued work and discards a late network completion", async () => {
  const f = setup();
  const card = await f.card();
  const waiting = await f.card();
  let finish;
  f.fetch = () => new Promise((resolve) => { finish = resolve; });
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await queueKnowledgeAnswer(waiting.id);
  await until(() => finish);
  clearKnowledgeApiKey();
  assert.equal(hasKnowledgeApiKey(), false);
  assert.equal(f.requests[0].options.signal.aborted, true);
  finish({ ok: true, json: async () => response("This late answer must not appear") });
  await until(() => marker(card).ai.status === "interrupted" && marker(waiting).ai.status === "interrupted");
  assert.equal(f.requests.length, 1);
  assert.equal(marker(card).ai.answer, null);
});

test("GM handoff and reload recovery interrupt old attempts without resending or rerolling", async () => {
  const f = setup();
  const card = await f.card();
  let finish;
  f.fetch = () => new Promise((resolve) => { finish = resolve; });
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await until(() => finish);
  game.users.activeGM = f.secondGM;
  await reconcileKnowledgeAI();
  assert.equal(f.requests[0].options.signal.aborted, true);
  game.user = f.secondGM;
  await reconcileKnowledgeAI();
  assert.equal(hasKnowledgeApiKey(), false);
  assert.equal(marker(card).ai.status, "interrupted");
  marker(card).ai = { ...marker(card).ai, attemptId: "new-gm-attempt", status: "queued", gmId: f.secondGM.id };
  finish({ ok: true, json: async () => response("Old GM's late answer") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(marker(card).ai.attemptId, "new-gm-attempt");
  assert.equal(marker(card).ai.answer, null);
  await reconcileKnowledgeAI();
  assert.equal(marker(card).ai.status, "interrupted");
  assert.equal(f.requests.length, 1);
  assert.equal(f.rolls, 1);
});

test("deleted cards, changed worlds and lost GM roles invalidate sessions and prevent API calls", async () => {
  for (const change of [() => { game.world.id = "different-world"; }, () => { game.user.isGM = false; }]) {
    const f = setup();
    const card = await f.card();
    setKnowledgeApiKey(KEY);
    change();
    assert.equal(hasKnowledgeApiKey(), false);
    assert.throws(() => queueKnowledgeAnswer(card.id));
    assert.equal(f.requests.length, 0);
  }
  const f = setup();
  const card = await f.card();
  setKnowledgeApiKey(KEY);
  f.messages.length = 0;
  assert.throws(() => queueKnowledgeAnswer(card.id), /private GM/);
  assert.equal(f.requests.length, 0);
});

test("custom endpoints receive Responses requests after key re-entry for the new destination", async () => {
  const f = setup();
  const card = await f.card();
  setKnowledgeApiKey(KEY);
  f.values.set(KNOWLEDGE_API_ENDPOINT_SETTING, "https://llm.example/v1/responses");
  assert.equal(hasKnowledgeApiKey(), false);
  assert.throws(() => queueKnowledgeAnswer(card.id), /Enter an API key/);
  setKnowledgeApiKey("custom-provider-key");
  f.values.set(KNOWLEDGE_MODEL_SETTING, "custom-model");
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.equal(f.requests[0].url, "https://llm.example/v1/responses");
  assert.equal(f.requests[0].options.headers.Authorization, "Bearer custom-provider-key");
  assert.equal(JSON.parse(f.requests[0].options.body).model, "custom-model");
  for (const invalid of ["javascript:alert(1)", "http://example.com/responses", "https://user:password@example.com/responses",
    "https://example.com/responses?api_key=secret", "https://example.com/responses#secret"]) assert.throws(() => normalizeKnowledgeEndpoint(invalid));
});

test("players, non-active GMs and public cards cannot submit AI work", async () => {
  const f = setup();
  const card = await f.card();
  setKnowledgeApiKey(KEY);
  game.user = f.player;
  assert.throws(() => setKnowledgeApiKey(KEY), /Only a GM/);
  assert.throws(() => queueKnowledgeAnswer(card.id), /active GM/);
  game.user = f.secondGM;
  assert.throws(() => queueKnowledgeAnswer(card.id), /active GM/);
  game.user = f.gm;
  card.whisper.push("player");
  assert.throws(() => queueKnowledgeAnswer(card.id), /private GM/);
  card.whisper.pop();
  card.blind = false;
  assert.throws(() => queueKnowledgeAnswer(card.id), /private GM/);
  assert.equal(f.requests.length, 0);
});

test("replayed player submissions and server-confirmed chat creation failures each generate only one answer", async () => {
  for (const lateCreateError of [false, true]) {
    const f = setup();
    if (lateCreateError) {
      const create = ChatMessage.create;
      ChatMessage.create = async (data) => { await create(data); throw new Error("Lost acknowledgment"); };
    }
    setKnowledgeApiKey(KEY);
    const request = { operationId: `duplicate-ai-${String(++counter).padStart(12, "0")}`, requesterUserId: f.player.id,
      sourceTokenUuid: "Scene.scene.Token.source", targetTokenUuid: "Scene.scene.Token.target", question: "What do I recall?" };
    const results = await Promise.all([executeAskQuestion(request), executeAskQuestion(request)]);
    assert.deepEqual(results[0], results[1]);
    await until(() => marker(f.messages[0]).ai.status === "complete");
    await executeAskQuestion(request);
    assert.equal(f.requests.length, 1);
    assert.equal(f.rolls, 1);
    assert.equal(f.messages.length, 1);
  }
});

test("a newer attempt or deleted card prevents an old request from delivering or blocking subsequent work", async () => {
  for (const deleted of [false, true]) {
    const f = setup();
    const card = await f.card();
    let finish;
    f.fetch = () => new Promise((resolve) => { finish = resolve; });
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => finish);
    if (deleted) f.messages.length = 0;
    else marker(card).ai = { ...marker(card).ai, attemptId: "newer-attempt", status: "complete", answer: "Newer answer" };
    await reconcileKnowledgeAI();
    assert.equal(f.requests[0].options.signal.aborted, true);
    finish({ ok: true, json: async () => response("Old answer") });
    await new Promise((resolve) => setImmediate(resolve));
    if (!deleted) assert.equal(marker(card).ai.answer, "Newer answer");
    f.fetch = null;
    const next = await f.card();
    await until(() => marker(next).ai.status === "complete");
    assert.equal(f.requests.length, 2);
  }
});

test("legacy private cards use their saved prompt and entering a new key cancels scheduled automatic submission", async () => {
  const f = setup();
  const card = await f.card();
  delete marker(card).instructions;
  delete marker(card).input;
  f.values.set(KNOWLEDGE_PROMPT_SETTING, "New world text");
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.equal(JSON.parse(f.requests[0].options.body).instructions, DEFAULT_KNOWLEDGE_PROMPT);
  const next = await f.card();
  setKnowledgeApiKey("new-session-key");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.requests.length, 1);
  assert.equal(marker(next).ai.status, "needs-key");
});

test("raw parsing collects assistant text and rejects empty or incomplete responses", () => {
  const data = response("First");
  data.output.unshift({ type: "reasoning", summary: [] });
  data.output[1].content.push({ type: "output_text", text: "Second" });
  assert.equal(parseKnowledgeAIResponse(data).answer, "First\n\nSecond");
  for (const invalid of [null, {}, { status: "completed", output: [] }, { status: "incomplete", output: [] }]) assert.throws(() => parseKnowledgeAIResponse(invalid));
});

test("answer rendering is literal; copying includes truthful type/traits and players get no controls", async () => {
  const f = setup();
  const card = await f.card();
  f.fetch = async () => ({ ok: true, json: async () => response(`<script>alert(1)</script> [[1d20]] @UUID[Actor.secret] ${KEY}`) });
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.doesNotMatch(marker(card).ai.answer, new RegExp(KEY));
  let render;
  globalThis.Hooks = { on: (_name, callback) => { render = callback; return 1; }, off: () => {} };
  const unregister = registerQuestionChat();
  const dom = new JSDOM(card.content);
  const html = dom.window.document;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { copied = text; } } } });
  try {
    assert.doesNotMatch(card.content, /alert\(1\)|\[\[1d20\]\]/);
    render(card, html);
    const section = html.querySelector("[data-pza-knowledge-ai]");
    assert.equal(section.querySelectorAll("script,a,.inline-roll").length, 0);
    assert.match(section.querySelector("pre").textContent, /<script>.*\[\[1d20\]\].*@UUID/);
    section.querySelector("button").click();
    await until(() => copied && !section.querySelector("button").disabled);
    assert.match(copied, /^Type: Dragon\nTraits: Dragon, Fire\n\n/);
    navigator.clipboard.writeText = async () => { throw new Error("Denied"); };
    section.querySelector("button").click();
    await until(() => dom.window.getSelection().toString() === copied);
    game.user = f.player;
    render(card, html);
    assert.equal(section.textContent, "");
    assert.equal(html.querySelector("button"), null);
  } finally {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
    unregister();
    dom.window.close();
  }
});

test("key entry begins blank, stays out of settings, and clears after session use", async () => {
  const f = setup();
  const registered = new Map();
  const menus = new Map();
  game.settings.register = (_namespace, key, value) => registered.set(key, value);
  game.settings.registerMenu = (_namespace, key, value) => menus.set(key, value);
  const dom = new JSDOM("<!doctype html>");
  globalThis.document = dom.window.document;
  globalThis.foundry = { data: { fields: { StringField: class { constructor(options) { this.options = options; } } } }, applications: { api: { DialogV2: class {
    constructor(options) { this.options = options; this.listeners = new Map(); }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    async render() { this.rendered = true; this.element = document.createElement("form"); this.element.innerHTML = this.options.content.innerHTML; }
    async close() { this.listeners.get("close")?.(); this.rendered = false; }
    bringToFront() {}
  } } } };
  registerKnowledgeAISettings();
  try {
    setKnowledgeApiKey(KEY);
    const dialog = await openKnowledgeAIConnection();
    const input = dialog.element.querySelector("input");
    assert.equal(input.type, "text");
    assert.equal(input.value, "");
    assert.match(dialog.element.textContent, /Key entered for this session/);
    input.value = "replacement-secret";
    dialog.options.buttons.find((button) => button.action === "use").callback(null, { form: dialog.element });
    assert.equal(input.value, "");
    assert.equal(hasKnowledgeApiKey(), true);
    assert.equal(registered.size, 2);
    assert.doesNotMatch(JSON.stringify([...registered.values()]), /replacement-secret|fake-session-secret/);
    dialog.options.buttons.find((button) => button.action === "clear").callback(null, { form: dialog.element });
    assert.equal(hasKnowledgeApiKey(), false);
    assert.match(dialog.element.textContent, /No key entered/);
    assert.equal(menus.get("recallKnowledgeAIConnection").restricted, true);
    input.value = "unsubmitted-key";
    await dialog.close();
    assert.equal(input.value, "");
    game.user = f.player;
    await assert.rejects(openKnowledgeAIConnection(), /Only a GM/);
    assert.throws(() => new (menus.get("recallKnowledgeAIConnection").type)(), /Only a GM/);
  } finally { dom.window.close(); }
});
