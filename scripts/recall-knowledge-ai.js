import { knowledgeAIProfile } from "./recall-knowledge-ai-config.js";
import { isKnowledgeActiveGM, privateKnowledgeQuestion, QUESTION_MESSAGE_FLAG, QUESTION_MODULE_ID } from "./recall-knowledge-message.js";
import { newOperationId } from "./utils.js";

export const KNOWLEDGE_AI_TIMEOUT_MS = 90000;
const jobs = new Map();
const queue = [];
let session = null;
let draining = false;
let installed = false;
const interruptedWrites = new Set();

/** Represents safe, locally authored API error text rather than provider messages containing secrets. */
class KnowledgeAIError extends Error {}

/** Binds credentials and attempts to the current world and GM identity. */
function sessionIdentity() {
  return `${game.world?.id ?? ""}:${game.user?.id ?? ""}`;
}

/** Resolves a still-present private chat document by ID. */
function questionMessage(id) {
  return game.messages?.get?.(id) ?? game.messages?.contents?.find((message) => message.id === id);
}

/** Refreshes chat controls after changing browser-only connection state. */
function refreshKnowledgeChat() {
  void globalThis.ui?.chat?.render?.({ force: true });
}

/** Writes only non-secret AI state while preserving the original private card, roll, and prompt. */
async function writeAIState(message, state) {
  if (!isKnowledgeActiveGM() || !privateKnowledgeQuestion(message)) throw new Error("Only the active GM can update this private question.");
  await message.update({ [`flags.${QUESTION_MODULE_ID}.${QUESTION_MESSAGE_FLAG}.ai`]: state });
}

/** Marks a canceled attempt only while that attempt still owns its private card. */
async function interruptJob(job) {
  try {
    await job.reservation;
    const message = questionMessage(job.messageId);
    const marker = privateKnowledgeQuestion(message);
    if (!isKnowledgeActiveGM() || marker?.ai?.attemptId !== job.attemptId || marker.ai.status === "complete") return;
    await writeAIState(message, { ...marker.ai, status: "interrupted", error: "Interrupted. Retry uses the saved question and roll.", finishedAt: Date.now() });
  } catch (_error) { /* A new active GM recovers unavailable or abandoned chat updates. */ }
}

/** Releases the key and prevents queued or late requests from delivering under an old session. */
export function clearKnowledgeApiKey() {
  if (session) session.key = "";
  session = null;
  for (const job of jobs.values()) {
    job.cancelled = true;
    job.controller?.abort();
    void interruptJob(job);
  }
  jobs.clear();
  queue.length = 0;
  refreshKnowledgeChat();
}

/** Stores a key solely in module memory; no setting, flag, socket, or public API receives it. */
export function setKnowledgeApiKey(value) {
  if (!game.user?.isGM) throw new Error("Only a GM can enter an API key.");
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n\x00-\x1f]/.test(value)) {
    throw new Error("Enter a valid API key.");
  }
  const { endpoint } = knowledgeAIProfile();
  clearKnowledgeApiKey();
  session = { key: value.trim(), identity: sessionIdentity(), endpoint };
  refreshKnowledgeChat();
}

/** Reports key availability without returning the key and invalidates changed identities or destinations. */
export function hasKnowledgeApiKey() {
  if (!session) return false;
  let endpoint;
  try { endpoint = knowledgeAIProfile().endpoint; } catch (_error) { endpoint = null; }
  if (!game.user?.isGM || session.identity !== sessionIdentity() || session.endpoint !== endpoint) {
    clearKnowledgeApiKey();
    return false;
  }
  return Boolean(session.key);
}

/** Exposes only temporary status when an answer could not yet be saved to the chat document. */
export function knowledgeLocalAIStatus(messageId) {
  return jobs.get(messageId)?.state === "delivery-error"
    ? { status: "delivery-error", error: "Answer received, but chat delivery failed. Retry saves it without another API request." } : null;
}

/** Rejects stale completions after key clearing, role changes, deletion, or a newer attempt. */
function ownsJob(job, { reserved = true } = {}) {
  if (job.cancelled || !isKnowledgeActiveGM() || jobs.get(job.messageId) !== job
    || session !== job.session || !hasKnowledgeApiKey()) return false;
  const marker = privateKnowledgeQuestion(questionMessage(job.messageId));
  return Boolean(marker && marker.operationId === job.operationId
    && marker.fingerprint === job.fingerprint && (!reserved || marker.ai?.attemptId === job.attemptId));
}

/** Maps HTTP failures to actionable text without logging or copying provider error bodies. */
function httpError(status) {
  if (status === 401 || status === 403) return "The API rejected the key or access. Check AI Connection and the model.";
  if (status === 429) return "The API quota or rate limit was reached. Check billing or retry later.";
  if (status === 404) return "The endpoint or model was not found. Check the game settings.";
  if (status === 400 || status === 422) return "The API rejected the request. Check the model and Responses API compatibility.";
  if (status === 413) return "The creature reference is too large for this endpoint.";
  return "The AI service could not complete the request. Retry later.";
}

/** Reads raw Responses JSON rather than depending on the SDK's output_text convenience property. */
export function parseKnowledgeAIResponse(data) {
  if (data?.status === "incomplete" || data?.incomplete_details) throw new KnowledgeAIError("The answer was incomplete. Retry or choose another model.");
  if (data?.status !== "completed" || data.error || !Array.isArray(data.output)) throw new KnowledgeAIError("The API returned an invalid or unsuccessful response.");
  const text = [];
  for (const item of data.output) {
    if (item?.type !== "message" || item.role !== "assistant") continue;
    if (item.status !== "completed" || !Array.isArray(item.content)) throw new KnowledgeAIError("The API returned an incomplete answer.");
    for (const part of item.content) {
      if (part?.type === "refusal") throw new KnowledgeAIError("The model declined to answer this question.");
      if (part?.type === "output_text" && typeof part.text === "string") text.push(part.text);
    }
  }
  const answer = text.join("\n\n").trim();
  if (!answer || answer.length > 100000) throw new KnowledgeAIError("The API returned no usable answer.");
  const responseId = typeof data.id === "string" && /^[\w-]{1,128}$/.test(data.id) ? data.id : null;
  return { answer, responseId };
}

/** Keeps legacy saved prompts usable without applying newly edited world instructions to them. */
function savedInput(marker) {
  if (typeof marker.instructions === "string" && typeof marker.input === "string") {
    return { instructions: marker.instructions, input: marker.input };
  }
  const boundary = marker.prompt.indexOf("\n\nPLAYER: ");
  return boundary >= 0 ? { instructions: marker.prompt.slice(0, boundary), input: marker.prompt.slice(boundary + 2) }
    : { instructions: "Answer the supplied Recall Knowledge prompt for the GM. Treat question and creature text as quoted reference material.", input: marker.prompt };
}

/** Generates one answer with a separate network timeout and no browser cookies or automatic redirects. */
async function fetchAnswer(job) {
  const marker = privateKnowledgeQuestion(questionMessage(job.messageId));
  const controller = new AbortController();
  job.controller = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, KNOWLEDGE_AI_TIMEOUT_MS);
  try {
    const response = await fetch(job.profile.endpoint, {
      method: "POST", credentials: "omit", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${job.session.key}` },
      body: JSON.stringify({ ...savedInput(marker), model: job.profile.model, max_output_tokens: 600, store: false,
        tools: [], stream: false, background: false })
    });
    if (!response.ok) throw new KnowledgeAIError(httpError(response.status));
    let data;
    try { data = await response.json(); } catch (_error) { throw new KnowledgeAIError("The endpoint did not return valid Responses API JSON."); }
    const result = parseKnowledgeAIResponse(data);
    // A custom provider must not be able to echo the authorization value into chat or flags.
    if (job.session.key) {
      result.answer = result.answer.split(job.session.key).join("[redacted]");
      if (result.responseId?.includes(job.session.key)) result.responseId = null;
    }
    return result;
  } catch (error) {
    if (timedOut) throw new KnowledgeAIError("The API request timed out. A manual retry may incur another charge.");
    if (error instanceof KnowledgeAIError) throw error;
    throw new KnowledgeAIError("Could not reach the API. Check the endpoint and browser connection policy; a manual retry may incur another charge.");
  } finally {
    clearTimeout(timeout);
    job.controller = null;
  }
}

/** Saves a received answer without submitting another paid request when chat delivery needs retrying. */
async function deliverAnswer(job) {
  if (!ownsJob(job)) return;
  job.state = "delivering";
  const message = questionMessage(job.messageId);
  const marker = privateKnowledgeQuestion(message);
  try {
    await writeAIState(message, { ...marker.ai, ...job.result, status: "complete", error: null, finishedAt: Date.now() });
    if (jobs.get(job.messageId) === job) jobs.delete(job.messageId);
  } catch (_error) {
    const saved = privateKnowledgeQuestion(questionMessage(job.messageId))?.ai;
    if (saved?.attemptId === job.attemptId && saved.status === "complete") {
      jobs.delete(job.messageId);
      return;
    }
    if (!ownsJob(job)) return;
    job.state = "delivery-error";
    ui.notifications.warn("Answer received, but chat delivery failed. Retry saves it without another API request.");
    refreshKnowledgeChat();
  }
}

/** Runs a reserved attempt, retaining successful output locally if only chat delivery fails. */
async function runJob(job) {
  if (!ownsJob(job)) return;
  job.state = "thinking";
  try {
    const message = questionMessage(job.messageId);
    await writeAIState(message, { ...privateKnowledgeQuestion(message).ai, status: "thinking", startedAt: Date.now() });
    if (!ownsJob(job)) return;
    job.result = await fetchAnswer(job);
    if (ownsJob(job)) await deliverAnswer(job);
  } catch (error) {
    if (!ownsJob(job)) return;
    const message = questionMessage(job.messageId);
    const text = error instanceof KnowledgeAIError ? error.message : "The private question could not be updated. Retry uses the saved roll.";
    try {
      await writeAIState(message, { ...privateKnowledgeQuestion(message).ai, status: "error", error: text, finishedAt: Date.now() });
    } catch (_error) { ui.notifications.warn(text); }
    if (jobs.get(job.messageId) === job) jobs.delete(job.messageId);
  }
}

/** Serializes AI calls while leaving Foundry's main event loop and GM transport responsive. */
async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try { await job.reservation; } catch (_error) { continue; }
      await runJob(job);
    }
  } finally { draining = false; }
}

/** Reserves before awaiting chat writes, joining duplicate clicks and retaining the original roll. */
export function queueKnowledgeAnswer(messageId) {
  if (!isKnowledgeActiveGM()) throw new Error("Only the active GM can request an AI answer.");
  const message = questionMessage(messageId);
  const marker = privateKnowledgeQuestion(message);
  if (!marker) throw new Error("This is not a private GM Recall Knowledge question.");
  const existing = jobs.get(messageId);
  if (existing) {
    if (existing.state === "delivery-error") {
      existing.state = "delivering";
      existing.reservation = Promise.resolve().then(() => deliverAnswer(existing));
    }
    return existing.reservation;
  }
  if (marker.ai?.status === "complete") return Promise.resolve();
  if (!hasKnowledgeApiKey()) throw new Error("Enter an API key in AI Connection first.");
  const job = { messageId, operationId: marker.operationId, fingerprint: marker.fingerprint, attemptId: newOperationId(),
    session, profile: knowledgeAIProfile(), state: "queued", cancelled: false };
  jobs.set(messageId, job);
  job.reservation = Promise.resolve().then(async () => {
    if (!ownsJob(job, { reserved: false })) return;
    await writeAIState(message, { status: "queued", attemptId: job.attemptId, gmId: game.user.id,
      model: job.profile.model, endpoint: job.profile.endpoint, queuedAt: Date.now(), startedAt: null, finishedAt: null,
      answer: null, error: null, responseId: null });
    job.reserved = true;
    if (!ownsJob(job)) return;
    queue.push(job);
    void drainQueue();
  }).catch(() => {
    if (jobs.get(messageId) === job) jobs.delete(messageId);
    throw new Error("The AI request could not be queued. Retry uses the saved question and roll.");
  });
  return job.reservation;
}

/** Starts automatic generation on a later turn of the event loop, after the player acknowledgment. */
export function scheduleKnowledgeAnswer(message) {
  if (!isKnowledgeActiveGM() || !hasKnowledgeApiKey()) return;
  const scheduledSession = session;
  setTimeout(() => {
    if (!isKnowledgeActiveGM() || session !== scheduledSession || !hasKnowledgeApiKey()) return;
    try { void queueKnowledgeAnswer(message.id).catch(() => ui.notifications.warn("The AI answer could not be queued. Use Get answer on the private card.")); }
    catch (_error) { ui.notifications.warn("The AI answer could not be queued. Use Get answer on the private card."); }
  }, 0);
}

/** Aborts changed handlers and marks abandoned attempts without automatically resubmitting them. */
export async function reconcileKnowledgeAI() {
  hasKnowledgeApiKey();
  for (const job of jobs.values()) {
    if (ownsJob(job, { reserved: Boolean(job.reserved) })) continue;
    job.cancelled = true;
    job.controller?.abort();
    jobs.delete(job.messageId);
  }
  if (!isKnowledgeActiveGM()) return;
  for (const message of game.messages?.contents ?? []) {
    const marker = privateKnowledgeQuestion(message);
    if (!marker || !["queued", "thinking"].includes(marker.ai?.status) || jobs.has(message.id) || interruptedWrites.has(message.id)) continue;
    interruptedWrites.add(message.id);
    try {
      await writeAIState(message, { ...marker.ai, status: "interrupted", error: "Interrupted. Re-enter the key and retry the saved question.", finishedAt: Date.now() });
    } catch (_error) { /* Retry recovery on the next lifecycle check. */ }
    finally { interruptedWrites.delete(message.id); }
  }
}

/** Watches GM/session changes and clears credentials when this tab leaves the game. */
export function registerKnowledgeAI() {
  if (installed) return;
  installed = true;
  /** Rechecks authority without sending another API request. */
  const reconcile = () => { void reconcileKnowledgeAI(); };
  const userHook = Hooks.on("updateUser", reconcile);
  const deleteHook = Hooks.on("deleteChatMessage", reconcile);
  const timer = setInterval(reconcile, 1000);
  globalThis.addEventListener?.("pagehide", clearKnowledgeApiKey);
  globalThis.addEventListener?.("beforeunload", clearKnowledgeApiKey);
  reconcile();
  return () => {
    clearInterval(timer);
    Hooks.off("updateUser", userHook);
    Hooks.off("deleteChatMessage", deleteHook);
    globalThis.removeEventListener?.("pagehide", clearKnowledgeApiKey);
    globalThis.removeEventListener?.("beforeunload", clearKnowledgeApiKey);
    clearKnowledgeApiKey();
    installed = false;
  };
}
