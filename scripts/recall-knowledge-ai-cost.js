import { DEFAULT_KNOWLEDGE_API_ENDPOINT } from "./recall-knowledge-ai-config.js";
import { KNOWLEDGE_AI_PRICING as pricing } from "./recall-knowledge-ai-prices.js";

/** Admits only nonnegative whole-token counters, without coercing provider strings into loggable values. */
function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Extracts only numeric usage fields and rejects inconsistent totals or overlapping cache categories. */
function usageCounts(data) {
  const usage = data?.usage;
  if (!usage) return null;
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cachedInputTokens = tokenCount(usage.input_tokens_details?.cached_tokens ?? 0);
  const cacheWriteInputTokens = tokenCount(usage.input_tokens_details?.cache_write_tokens ?? 0);
  const reasoningTokens = tokenCount(usage.output_tokens_details?.reasoning_tokens ?? 0);
  const totalTokens = tokenCount(usage.total_tokens ?? (inputTokens + outputTokens));
  if ([inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, reasoningTokens, totalTokens].includes(null)
    || cachedInputTokens + cacheWriteInputTokens > inputTokens || reasoningTokens > outputTokens
    || totalTokens !== inputTokens + outputTokens) return null;
  return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningTokens, totalTokens };
}

/** Produces a safe token-cost estimate for known OpenAI rates without copying arbitrary provider metadata. */
export function knowledgeCostSummary(profile, data) {
  const returnedModel = data?.model ?? profile.model;
  const suppliedModel = typeof returnedModel === "string" && Object.hasOwn(pricing.modelAliases, returnedModel)
    ? pricing.modelAliases[returnedModel] : returnedModel;
  const model = typeof suppliedModel === "string" && Object.hasOwn(pricing.models, suppliedModel) ? suppliedModel : null;
  const suppliedTier = data?.service_tier ?? "default";
  const serviceTier = typeof suppliedTier === "string" && Object.hasOwn(pricing.tierMultipliers, suppliedTier) ? suppliedTier : null;
  const status = ["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(data?.status) ? data.status : null;
  const usage = usageCounts(data);
  const summary = { model, serviceTier, status, usage, currency: pricing.currency, pricingAsOf: pricing.asOf,
    estimatedInputCostUSD: null, estimatedOutputCostUSD: null, estimatedCostUSD: null,
    note: "Usage was not returned or was invalid; the charge is unknown, not necessarily zero." };
  if (!usage) return summary;
  if (profile.endpoint !== DEFAULT_KNOWLEDGE_API_ENDPOINT) {
    summary.note = "Custom endpoint pricing is unknown; token usage is reported without a cost estimate.";
    return summary;
  }
  const prices = model ? pricing.models[model] : null;
  if (!prices || !serviceTier || !prices.supportedTiers.includes(serviceTier)) {
    summary.note = "Pricing for this model or processing tier is unknown; no cost estimate is available.";
    return summary;
  }
  if (usage.cacheWriteInputTokens && prices.cacheWrite === null) {
    summary.note = "Cache-write pricing for this model is unknown; no cost estimate is available.";
    return summary;
  }
  const longContext = prices.longContext && usage.inputTokens > prices.longContext.inputTokensOver;
  const tierMultiplier = pricing.tierMultipliers[serviceTier];
  const ordinaryInput = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  summary.estimatedInputCostUSD = (ordinaryInput * prices.input + usage.cachedInputTokens * prices.cached
    + usage.cacheWriteInputTokens * (prices.cacheWrite ?? 0)) * (longContext ? prices.longContext.inputMultiplier : 1)
    * tierMultiplier / pricing.tokensPerUnit;
  // output_tokens already includes reasoning_tokens: charge them once, not twice.
  summary.estimatedOutputCostUSD = usage.outputTokens * prices.output * (longContext ? prices.longContext.outputMultiplier : 1)
    * tierMultiplier / pricing.tokensPerUnit;
  summary.estimatedCostUSD = summary.estimatedInputCostUSD + summary.estimatedOutputCostUSD;
  summary.note = "Estimate from published token rates, including reasoning and cache usage. Actual billed credit debit may differ; verify API billing.";
  return summary;
}

/** Warns once per network attempt with numeric usage and estimated USD cost, never credentials or prompt/answer text. */
export function logKnowledgeAICost(profile, data) {
  const summary = knowledgeCostSummary(profile, data);
  const cost = summary.estimatedCostUSD === null ? "cost unavailable" : `estimated cost $${summary.estimatedCostUSD.toFixed(8)} USD`;
  try { console.warn(`PF2e Zone Recall Knowledge AI: ${cost}`, summary); }
  catch (_error) { /* A console hook must not prevent answer delivery or cause a paid retry. */ }
}
