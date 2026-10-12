export const KNOWLEDGE_API_ENDPOINT_SETTING = "recallKnowledgeApiEndpoint";
export const KNOWLEDGE_MODEL_SETTING = "recallKnowledgeModel";
export const DEFAULT_KNOWLEDGE_API_ENDPOINT = "https://api.openai.com/v1/responses";
export const DEFAULT_KNOWLEDGE_MODEL = "gpt-4.1-mini";
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

/** Reads the non-secret connection profile without exposing any session credential. */
export function knowledgeAIProfile() {
  const endpoint = game.settings.get(MODULE_ID, KNOWLEDGE_API_ENDPOINT_SETTING) ?? DEFAULT_KNOWLEDGE_API_ENDPOINT;
  const model = game.settings.get(MODULE_ID, KNOWLEDGE_MODEL_SETTING) ?? DEFAULT_KNOWLEDGE_MODEL;
  if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("Enter a model in the game settings.");
  return { endpoint: normalizeKnowledgeEndpoint(endpoint), model: model.trim() };
}
