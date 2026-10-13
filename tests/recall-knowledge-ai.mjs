import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clearKnowledgeApiKey, hasKnowledgeApiKey, KNOWLEDGE_AI_TIMEOUT_MS, knowledgeLocalAIStatus,
  parseKnowledgeAIResponse, queueKnowledgeAnswer, reconcileKnowledgeAI, setKnowledgeApiKey } from "../scripts/recall-knowledge-ai.js";
import { DEFAULT_KNOWLEDGE_API_ENDPOINT, DEFAULT_KNOWLEDGE_MODEL, DEFAULT_KNOWLEDGE_REASONING, DEFAULT_KNOWLEDGE_OUTPUT,
  KNOWLEDGE_API_ENDPOINT_SETTING, KNOWLEDGE_MODEL_SETTING, KNOWLEDGE_REASONING_SETTING, KNOWLEDGE_OUTPUT_SETTING,
  KNOWLEDGE_REASONING_CHOICES, knowledgeAIProfile, normalizeKnowledgeEndpoint } from "../scripts/recall-knowledge-ai-config.js";
import { DEFAULT_KNOWLEDGE_PROMPT } from "../scripts/recall-knowledge-prompt.js";
import { executeAskQuestion } from "../scripts/recall-knowledge-worker.js";
import { registerQuestionChat } from "../scripts/recall-knowledge.js";
import { openKnowledgeAIConnection, registerKnowledgeAISettings } from "../scripts/recall-knowledge-settings.js";
import { QUESTION_MODULE_ID as MODULE_ID, QUESTION_MESSAGE_FLAG as FLAG, ANSWER_MESSAGE_FLAG,
  knowledgeAnswerMarker, plainKnowledgeAnswer, privateKnowledgeQuestion } from "../scripts/recall-knowledge-message.js";

const KEY = "fake-session-secret-do-not-persist";
let counter = 0;
const diagnostics = [];
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
    [KNOWLEDGE_MODEL_SETTING, DEFAULT_KNOWLEDGE_MODEL], [KNOWLEDGE_REASONING_SETTING, DEFAULT_KNOWLEDGE_REASONING],
    [KNOWLEDGE_OUTPUT_SETTING, DEFAULT_KNOWLEDGE_OUTPUT]]);
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
      assert.equal(data.author, game.user.id, "Chat creation must use Foundry's canonical author field");
      assert.equal(data.user, undefined);
      await f.beforeCreate?.(data);
      const message = { ...data, author: users.get(data.author), id: `message-${f.messages.length + 1}`, async update(changes) {
        await f.beforeUpdate?.(message, changes);
        f.writes.push(structuredClone(changes));
        marker(message).ai = { ...marker(message).ai, ...structuredClone(changes[`flags.${MODULE_ID}.${FLAG}.ai`]) };
      } };
      f.messages.push(message);
      await f.afterCreate?.(message);
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
  f.card = async () => { const result = await f.ask(); return game.messages.get(result.messageId); };
  return f;
}
test.beforeEach((t) => {
  diagnostics.length = 0;
  t.mock.method(console, "error", (...args) => diagnostics.push(structuredClone(args)));
});
test.afterEach(() => clearKnowledgeApiKey());

test("acknowledgment precedes a delayed API call and only GMs receive the answer, with no reroll", async () => {
  const f = setup();
  let finish;
  f.fetch = () => new Promise((resolve) => { finish = resolve; });
  setKnowledgeApiKey(KEY);
  const result = await f.ask();
  assert.deepEqual(result, { action: "ask-question", messageId: "message-1" });
  assert.equal(f.requests.length, 0);
  assert.equal(f.messages[0].user, undefined);
  assert.equal(f.messages[0].author, f.gm);
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
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 4000);
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
  assert.equal(f.messages.length, 2);
  const answer = f.messages[1];
  assert.deepEqual(answer.whisper, ["gm", "other-gm"]);
  assert.equal(answer.blind, false);
  assert.equal(answer.rolls, undefined);
  assert.equal(marker(f.messages[0]).ai.answerMessageId, answer.id);
  assert.match(knowledgeAnswerMarker(answer).text, /^Type: Dragon\nTraits: Dragon, Fire\n\n/);
  assert.doesNotMatch(JSON.stringify(answer), /Flame Breath|SKILL USED|ROLL:|RESULT:|CREATURE DATA|fingerprint|"prompt"|"instructions"|"input"|"responseId"|"model"/);
  assert.equal(answer.flags[MODULE_ID][FLAG], undefined);
  assert.equal(f.rolls, 1);
  assert.doesNotMatch(JSON.stringify([result, f.writes, f.messages, f.notifications]), new RegExp(KEY));
});

test("private cards accept live author documents and legacy source data without trusting a conflicting legacy author", async () => {
  const f = setup();
  const card = await f.card();
  assert.equal(privateKnowledgeQuestion(card), marker(card));
  card.author = f.gm.id;
  assert.equal(privateKnowledgeQuestion(card), marker(card));
  delete card.author;
  card.user = f.gm.id;
  assert.equal(privateKnowledgeQuestion(card), marker(card));
  card.user = f.gm;
  assert.equal(privateKnowledgeQuestion(card), marker(card));
  card.author = f.player;
  assert.equal(privateKnowledgeQuestion(card), null);
  card.author = null;
  assert.equal(privateKnowledgeQuestion(card), null);
  card.author = f.gm;
  card.whisper = [f.gm, f.secondGM];
  assert.equal(privateKnowledgeQuestion(card), marker(card));
  card.whisper.push(f.player);
  assert.equal(privateKnowledgeQuestion(card), null);
  card.whisper.pop();
  card.whisper.push(null);
  assert.equal(privateKnowledgeQuestion(card), null);
});

test("queue diagnostics preserve the underlying error while excluding credentials and saved prompt data", async () => {
  const f = setup();
  const card = await f.card();
  const prompt = marker(card).prompt;
  f.beforeUpdate = () => { throw new TypeError(`Chat write failed: ${KEY}; ${prompt}; ${JSON.stringify(prompt)}`); };
  setKnowledgeApiKey(KEY);
  await assert.rejects(queueKnowledgeAnswer(card.id), /could not be queued/);
  assert.equal(f.requests.length, 0);
  const [label, detail] = diagnostics[0];
  assert.equal(label, "PF2e Zone Recall Knowledge AI queue failed");
  assert.equal(detail.stage, "save-queued-state");
  assert.equal(detail.messageId, card.id);
  assert.equal(detail.authorId, f.gm.id);
  assert.equal(detail.privateQuestion, true);
  assert.equal(detail.error.name, "TypeError");
  assert.match(detail.error.message, /Chat write failed/);
  assert.match(detail.error.stack, /recall-knowledge-ai/);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(KEY));
  assert.doesNotMatch(JSON.stringify(diagnostics), /How do I survive|Flame Breath/);
  f.beforeUpdate = null;
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.equal(f.requests.length, 1);
  assert.equal(f.rolls, 1);

  const invalid = await f.card();
  invalid.author = f.player;
  assert.throws(() => queueKnowledgeAnswer(invalid.id), /private GM/);
  assert.equal(diagnostics.at(-1)[1].stage, "validate");
  assert.equal(diagnostics.at(-1)[1].authorIsGM, false);
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

test("queued attempts capture reasoning and allowance, while a manual retry reads the latest settings without rerolling", async () => {
  const f = setup();
  const first = await f.card();
  const waiting = await f.card();
  const completions = [];
  f.fetch = () => new Promise((resolve) => completions.push(resolve));
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(first.id);
  await until(() => completions.length === 1);
  f.values.set(KNOWLEDGE_REASONING_SETTING, "high");
  f.values.set(KNOWLEDGE_OUTPUT_SETTING, 8000);
  await queueKnowledgeAnswer(waiting.id);
  f.values.set(KNOWLEDGE_REASONING_SETTING, "none");
  f.values.set(KNOWLEDGE_OUTPUT_SETTING, 600);
  assert.equal(hasKnowledgeApiKey(), true);
  completions[0]({ ok: true, json: async () => response() });
  await until(() => completions.length === 2);
  const body = JSON.parse(f.requests[1].options.body);
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.equal(body.max_output_tokens, 8000);
  assert.equal(marker(waiting).ai.reasoningEffort, "high");
  assert.equal(marker(waiting).ai.maxOutputTokens, 8000);
  completions[1]({ ok: true, json: async () => ({ ...response(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) });
  await until(() => marker(waiting).ai.status === "error");
  assert.match(marker(waiting).ai.error, /output allowance.*Increase it/);
  f.fetch = null;
  await queueKnowledgeAnswer(waiting.id);
  await until(() => marker(waiting).ai.status === "complete");
  const retryBody = JSON.parse(f.requests[2].options.body);
  assert.deepEqual(retryBody.reasoning, { effort: "none" });
  assert.equal(retryBody.max_output_tokens, 600);
  assert.equal(f.requests.length, 3);
  assert.equal(f.rolls, 2);
});

test("supported reasoning choices reach the API and older GPT models omit unsupported reasoning parameters", async () => {
  for (const effort of Object.keys(KNOWLEDGE_REASONING_CHOICES)) {
    const f = setup();
    const card = await f.card();
    f.values.set(KNOWLEDGE_REASONING_SETTING, effort);
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "complete");
    assert.deepEqual(JSON.parse(f.requests[0].options.body).reasoning, { effort });
  }
  for (const model of ["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14", "gpt-4o-mini"]) {
    const f = setup();
    const card = await f.card();
    f.values.set(KNOWLEDGE_MODEL_SETTING, model);
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "complete");
    const body = JSON.parse(f.requests[0].options.body);
    assert.equal(Object.hasOwn(body, "reasoning"), false);
    assert.equal(body.model, model);
    assert.equal(body.max_output_tokens, 4000);
  }
});

test("profile defaults apply to unset options, and invalid effort or allowance is rejected before an API request", () => {
  const f = setup();
  f.values.clear();
  assert.deepEqual(knowledgeAIProfile(), { endpoint: DEFAULT_KNOWLEDGE_API_ENDPOINT, model: "gpt-6-luna",
    reasoningEffort: "low", maxOutputTokens: 4000 });
  for (const invalid of ["minimal", "extreme", "", ["low"], {}, 1]) {
    f.values.set(KNOWLEDGE_REASONING_SETTING, invalid);
    assert.throws(() => knowledgeAIProfile(), /reasoning effort/);
  }
  f.values.delete(KNOWLEDGE_REASONING_SETTING);
  for (const invalid of [0, 15, 128001, 4000.5, "4000", NaN, Infinity, ""]) {
    f.values.set(KNOWLEDGE_OUTPUT_SETTING, invalid);
    assert.throws(() => knowledgeAIProfile(), /output allowance/);
  }
  for (const valid of [16, 4000, 128000]) {
    f.values.set(KNOWLEDGE_OUTPUT_SETTING, valid);
    assert.equal(knowledgeAIProfile().maxOutputTokens, valid);
  }
  assert.equal(f.requests.length, 0);
});

test("entering a key does not submit a backlog, and older cards keep their saved customized instructions", async () => {
  const f = setup();
  const card = await f.card();
  const savedInstructions = "Older saved instructions: speak as a weary scholar.";
  marker(card).instructions = savedInstructions;
  marker(card).prompt = `${savedInstructions}\n\n${marker(card).input}`;
  assert.equal(marker(card).ai.status, "needs-key");
  assert.throws(() => queueKnowledgeAnswer(card.id), /Enter an API key/);
  setKnowledgeApiKey(KEY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.equal(JSON.parse(f.requests[0].options.body).instructions, savedInstructions);
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

test("quota and rate-limit codes identify the remedy without exposing provider diagnostics or retrying automatically", async () => {
  const cases = [
    ["credit_balance_exhausted", "insufficient_quota", /no prepaid credits.*Add credits/],
    ["organization_spend_limit_exceeded", "insufficient_quota", /organization's spending limit/],
    ["project_spend_limit_exceeded", "rate_limit_error", /project's spending limit/],
    ["organization_usage_limit_exceeded", "insufficient_quota", /organization's usage limit.*higher limit/],
    ["insufficient_quota", null, /quota is exhausted.*billing/],
    ["unknown-quota-code", "insufficient_quota", /quota is exhausted.*billing/],
    ["rate_limit_exceeded", "tokens", /temporary rate limit.*56 seconds/],
    ["slow_down", "rate_limit_error", /asked for fewer requests.*56 seconds/],
    [null, "rate_limit_error", /temporary rate limit.*56 seconds/]
  ];
  for (const [code, type, expected] of cases) {
    const f = setup();
    const card = await f.card();
    const originalPrompt = marker(card).prompt;
    let reads = 0;
    f.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ "Retry-After": "56" }), json: async () => {
      reads++;
      return { error: { code, type, message: `Untrusted provider diagnostic: ${KEY} ${originalPrompt}` } };
    } });
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "error");
    assert.match(marker(card).ai.error, expected);
    if (type === "insufficient_quota" || code === "project_spend_limit_exceeded") assert.doesNotMatch(marker(card).ai.error, /56 seconds/);
    assert.equal(reads, 1);
    assert.equal(marker(card).prompt, originalPrompt);
    assert.equal(marker(card).ai.answer, null);
    const persisted = JSON.stringify([f.writes, f.notifications, diagnostics]);
    assert.doesNotMatch(persisted, new RegExp(KEY));
    assert.doesNotMatch(persisted, /Untrusted provider diagnostic/);
    assert.doesNotMatch(JSON.stringify(marker(card).ai), /How do I survive/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
    f.fetch = null;
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "complete");
    assert.equal(f.requests.length, 2);
    assert.equal(f.rolls, 1);
  }
});

test("unrecognized and malformed HTTP 429 bodies retain a safe fallback", async () => {
  for (const data of [null, "invalid error", { error: null }, { error: { code: "toString" } },
    { error: { code: KEY, type: KEY, message: KEY } }, "bad-json"]) {
    const f = setup();
    const card = await f.card();
    f.fetch = async () => ({ ok: false, status: 429, json: async () => {
      if (data === "bad-json") throw new Error(KEY);
      return data;
    } });
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "error");
    assert.match(marker(card).ai.error, /without a recognized cause/);
    assert.doesNotMatch(JSON.stringify([f.writes, f.notifications, diagnostics]), new RegExp(KEY));
    assert.equal(f.requests.length, 1);
  }
});

test("rate-limit delay advice accepts only positive numeric values and never copies header text", async () => {
  for (const delay of ["56.2", " 56 ", "0", "-1", "1e3", "Infinity", KEY]) {
    const f = setup();
    const card = await f.card();
    f.fetch = async () => ({ ok: false, status: 429, headers: new Headers({ "Retry-After": delay }),
      json: async () => ({ error: { code: "rate_limit_exceeded" } }) });
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "error");
    assert.match(marker(card).ai.error, delay === "56.2" ? /57 seconds/ : delay === " 56 " ? /56 seconds/ : /Wait before retrying;/);
    assert.doesNotMatch(JSON.stringify([f.writes, f.notifications, diagnostics]), new RegExp(KEY));
    assert.equal(f.requests.length, 1);
  }
});

test("the separate API timeout covers the request and error body, and requires explicit retry", async (t) => {
  for (const stage of ["request", "error-body"]) {
    const f = setup();
    const card = await f.card();
    f.fetch = (_url, options) => {
      const stalled = () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return stage === "request" ? stalled() : { ok: false, status: 429, json: stalled };
    };
    setKnowledgeApiKey(KEY);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await queueKnowledgeAnswer(card.id);
    await until(() => f.requests.length === 1);
    t.mock.timers.tick(KNOWLEDGE_AI_TIMEOUT_MS);
    await until(() => marker(card).ai.status === "error");
    assert.match(marker(card).ai.error, /timed out.*another charge/);
    assert.equal(f.requests.length, 1);
    t.mock.timers.reset();
  }
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
  assert.equal(f.messages.length, 2, "The answer already posted even though updating the original card failed");
  failDelivery = false;
  const retry = queueKnowledgeAnswer(card.id);
  assert.equal(queueKnowledgeAnswer(card.id), retry);
  await retry;
  assert.equal(marker(card).ai.status, "complete");
  assert.equal(f.requests.length, 1);
  assert.equal(f.rolls, 1);
  assert.equal(f.messages.length, 2, "Retry must reuse the separately posted answer");
});

test("answer creation failures and lost acknowledgments retry delivery without another API call or duplicate message", async () => {
  for (const lostAcknowledgment of [false, true]) {
    const f = setup();
    const card = await f.card();
    let failDelivery = true;
    f.beforeCreate = (data) => {
      if (failDelivery && !lostAcknowledgment && data.flags?.[MODULE_ID]?.[ANSWER_MESSAGE_FLAG]) throw new Error("Chat offline");
    };
    f.afterCreate = (message) => {
      if (failDelivery && lostAcknowledgment && knowledgeAnswerMarker(message)) throw new Error("Acknowledgment lost");
    };
    setKnowledgeApiKey(KEY);
    await queueKnowledgeAnswer(card.id);
    await until(() => knowledgeLocalAIStatus(card.id)?.status === "delivery-error");
    assert.equal(f.messages.length, lostAcknowledgment ? 2 : 1);
    failDelivery = false;
    await queueKnowledgeAnswer(card.id);
    await until(() => marker(card).ai.status === "complete");
    assert.equal(f.messages.length, 2);
    assert.equal(f.requests.length, 1);
    assert.equal(f.rolls, 1);
  }
});

test("reload recovery recognizes an answer already posted and keeps a public answer public", async () => {
  const f = setup();
  const card = await f.card();
  let failStatus = true;
  f.beforeUpdate = (_message, changes) => {
    if (failStatus && changes[`flags.${MODULE_ID}.${FLAG}.ai`].status === "complete") throw new Error("Chat offline");
  };
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await until(() => knowledgeLocalAIStatus(card.id)?.status === "delivery-error");
  const answer = f.messages[1];
  answer.whisper = [];
  clearKnowledgeApiKey();
  await until(() => marker(card).ai.status === "interrupted");
  failStatus = false;
  await queueKnowledgeAnswer(card.id);
  assert.equal(marker(card).ai.status, "complete");
  assert.equal(marker(card).ai.answerMessageId, answer.id);
  assert.deepEqual(answer.whisper, []);
  assert.equal(f.messages.length, 2);
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
      ChatMessage.create = async (data) => {
        const message = await create(data);
        if (data.flags?.[MODULE_ID]?.[FLAG]) throw new Error("Lost question acknowledgment");
        return message;
      };
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
    assert.equal(f.messages.length, 2);
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

test("plain answers remove Markdown and HTML presentation while preserving prose and game notation", () => {
  const formatted = "### A remembered lesson\n\n**Fire** is *dangerous*; __cold__ brings _relief_.\n\n"
    + "- Use `cold iron`.\n1. Avoid ~~flame~~ smoke.\n> A [scholar](https://example.invalid) warned you.\n\n"
    + "```text\nA +5 bonus, a -3 DC, 2d6 damage, and cold_iron remain unchanged.\n```\n\n"
    + "<b>Beware.</b>\n\n| Defense | Clue |\n| --- | --- |\n| Reflex | Slow |";
  const plain = plainKnowledgeAnswer(formatted);
  assert.match(plain, /^A remembered lesson/);
  assert.match(plain, /Fire is dangerous; cold brings relief\./);
  assert.match(plain, /Use cold iron\./);
  assert.match(plain, /Avoid flame smoke\./);
  assert.match(plain, /A scholar warned you\./);
  assert.match(plain, /A \+5 bonus, a -3 DC, 2d6 damage, and cold_iron remain unchanged\./);
  assert.match(plain, /Beware\./);
  assert.match(plain, /Defense; Clue/);
  assert.match(plain, /Reflex; Slow/);
  assert.doesNotMatch(plain, /[*`#|<>]|https:|---/);
});

test("the model receives plain-text instructions and leftover Markdown is removed before posting", async () => {
  const f = setup();
  const card = await f.card();
  f.fetch = async () => ({ ok: true, json: async () => response("**Keep your distance.** Its `flame` is *deadly*.") });
  setKnowledgeApiKey(KEY);
  await queueKnowledgeAnswer(card.id);
  await until(() => marker(card).ai.status === "complete");
  assert.match(JSON.parse(f.requests[0].options.body).instructions, /plain text prose.*Do not use Markdown or HTML/);
  assert.equal(marker(card).ai.answer, "Keep your distance. Its flame is deadly.");
  assert.equal(knowledgeAnswerMarker(f.messages[1]).text, "Type: Dragon\nTraits: Dragon, Fire\n\nKeep your distance. Its flame is deadly.");
});

test("without a session key the question displays only its non-API content, and completed answers stay separate", async () => {
  const f = setup();
  const card = await f.card();
  let render;
  globalThis.Hooks = { on: (_name, callback) => { render = callback; return 1; }, off: () => {} };
  const unregister = registerQuestionChat();
  const dom = new JSDOM(card.content);
  const html = dom.window.document;
  try {
    render(card, html);
    assert.equal(html.querySelector("[data-pza-knowledge-ai]"), null);
    assert.ok(html.querySelector("[data-pza-copy-knowledge]"));
    assert.ok(html.querySelector("[data-pza-knowledge-prompt]"));
    assert.match(html.body.textContent, /Success.*vs\. DC/);
    assert.doesNotMatch(html.body.textContent, /AI Connection|Get answer|Enter an API key|Ready to get an answer/);
    setKnowledgeApiKey(KEY);
    render(card, html);
    assert.match(html.querySelector("[data-pza-knowledge-ai]").textContent, /Ready to get an answer.*AI Connection.*Get answer/);
    marker(card).ai = { status: "complete", answerMessageId: "separate-answer", answer: "A separately posted recollection." };
    render(card, html);
    assert.equal(html.querySelector("[data-pza-knowledge-ai]").textContent, "Answer posted separately.");
    assert.doesNotMatch(html.body.textContent, /A separately posted recollection|Copy answer/);
    clearKnowledgeApiKey();
    render(card, html);
    assert.equal(html.querySelector("[data-pza-knowledge-ai]"), null);
    assert.ok(html.querySelector("[data-pza-copy-knowledge]"));
    assert.equal(f.requests.length, 0);
    game.user = f.player;
    render(card, html);
    assert.equal(html.querySelector("button"), null);
  } finally { unregister(); dom.window.close(); }
});

test("separate answer rendering stays literal when made public; copying includes truthful type/traits without GM mechanics", async () => {
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
  const answerMessage = f.messages[1];
  const dom = new JSDOM(answerMessage.content);
  const html = dom.window.document;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { copied = text; } } } });
  try {
    assert.doesNotMatch(card.content, /alert\(1\)|\[\[1d20\]\]/);
    render(answerMessage, html);
    const answer = html.querySelector("[data-pza-knowledge-answer]");
    assert.equal(html.querySelectorAll("script,a,.inline-roll").length, 0);
    assert.match(answer.textContent, /alert\(1\).*\[\[1d20\]\].*@UUID/);
    html.querySelector("button").click();
    await until(() => copied && !html.querySelector("button").disabled);
    assert.match(copied, /^Type: Dragon\nTraits: Dragon, Fire\n\n/);
    navigator.clipboard.writeText = async () => { throw new Error("Denied"); };
    html.querySelector("button").click();
    await until(() => dom.window.getSelection().toString() === copied);
    game.user = f.player;
    answerMessage.whisper = [];
    html.querySelector("[data-pza-knowledge-answer]").innerHTML = '<a class="inline-roll">Enriched roll</a>';
    render(answerMessage, html);
    assert.equal(answer.textContent, copied);
    assert.equal(html.querySelectorAll("a,.inline-roll").length, 0);
    assert.equal(html.querySelector("button"), null);
    assert.doesNotMatch(html.body.textContent, /vs\. DC|Success|Flame Breath|How do I survive|LLM prompt/);
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
  class TestField { constructor(options) { this.options = options; } }
  globalThis.foundry = { data: { fields: { StringField: TestField, NumberField: TestField } }, applications: { api: { DialogV2: class {
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
    assert.equal(registered.size, 4);
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
