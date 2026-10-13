export const KNOWLEDGE_API_ENDPOINT_SETTING = "recallKnowledgeApiEndpoint";
export const KNOWLEDGE_MODEL_SETTING = "recallKnowledgeModel";
export const KNOWLEDGE_REASONING_SETTING = "recallKnowledgeReasoningEffort";
export const KNOWLEDGE_OUTPUT_SETTING = "recallKnowledgeOutputAllowance";
export const DEFAULT_KNOWLEDGE_API_ENDPOINT = "https://api.openai.com/v1/responses";
export const DEFAULT_KNOWLEDGE_MODEL = "gpt-6-luna";
export const DEFAULT_KNOWLEDGE_REASONING = "low";
export const DEFAULT_KNOWLEDGE_OUTPUT = 4000;
export const MIN_KNOWLEDGE_OUTPUT = 16;
export const MAX_KNOWLEDGE_OUTPUT = 128000;
export const KNOWLEDGE_REASONING_CHOICES = Object.freeze({
  none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum"
});
const MODULE_ID = "pf2e-zone-automation";

/** Allows complete HTTPS Responses endpoints without credentials hidden in the URL. */
export function normalizeKnowledgeEndpoint(value) {
  let url;
  try { url = new URL(typeof value === "string" ? value.trim() : ""); } catch (_error) {
    throw new Error("Enter a complete HTTPS API endpoint.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS API endpoint without a username, password, query, or fragment.");
  }
  return url.href;
}

/** Rejects unsupported effort choices before a paid request can be submitted. */
export function normalizeKnowledgeReasoning(value) {
  if (typeof value !== "string" || !Object.hasOwn(KNOWLEDGE_REASONING_CHOICES, value)) {
    throw new Error("Choose a reasoning effort in the game settings.");
  }
  return value;
}

/** Requires a whole-token allowance within the default model's supported output range. */
export function normalizeKnowledgeOutput(value) {
  if (!Number.isInteger(value) || value < MIN_KNOWLEDGE_OUTPUT || value > MAX_KNOWLEDGE_OUTPUT) {
    throw new Error(`Enter an output allowance from ${MIN_KNOWLEDGE_OUTPUT} to ${MAX_KNOWLEDGE_OUTPUT} whole tokens.`);
  }
  return value;
}

/** Reads the non-secret connection profile without exposing any session credential. */
export function knowledgeAIProfile() {
  const endpoint = game.settings.get(MODULE_ID, KNOWLEDGE_API_ENDPOINT_SETTING) ?? DEFAULT_KNOWLEDGE_API_ENDPOINT;
  const model = game.settings.get(MODULE_ID, KNOWLEDGE_MODEL_SETTING) ?? DEFAULT_KNOWLEDGE_MODEL;
  if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("Enter a model in the game settings.");
  const reasoningEffort = game.settings.get(MODULE_ID, KNOWLEDGE_REASONING_SETTING) ?? DEFAULT_KNOWLEDGE_REASONING;
  const maxOutputTokens = game.settings.get(MODULE_ID, KNOWLEDGE_OUTPUT_SETTING) ?? DEFAULT_KNOWLEDGE_OUTPUT;
  return { endpoint: normalizeKnowledgeEndpoint(endpoint), model: model.trim(),
    reasoningEffort: normalizeKnowledgeReasoning(reasoningEffort), maxOutputTokens: normalizeKnowledgeOutput(maxOutputTokens) };
}
