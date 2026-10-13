import { DEFAULT_KNOWLEDGE_API_ENDPOINT } from "./recall-knowledge-ai-config.js";

const PRICING_DATE = "2026-10-12";
// Published USD rates per million tokens; estimates cannot establish an account's actual debit.
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.openai.com/api/docs/models/gpt-4.1-mini
const MODEL_PRICES = Object.freeze({
  "gpt-6-luna": { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50, longContext: true },
  "gpt-4.1-mini": { input: 0.40, cached: 0.10, cacheWrite: null, output: 1.60 }
});
const TIER_MULTIPLIERS = Object.freeze({ default: 1, flex: 0.5, fast: 2, priority: 2 });

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
  const suppliedModel = returnedModel === "gpt-4.1-mini-2025-04-14" ? "gpt-4.1-mini" : returnedModel;
  const model = typeof suppliedModel === "string" && Object.hasOwn(MODEL_PRICES, suppliedModel) ? suppliedModel : null;
  const suppliedTier = data?.service_tier ?? "default";
  const serviceTier = typeof suppliedTier === "string" && Object.hasOwn(TIER_MULTIPLIERS, suppliedTier) ? suppliedTier : null;
  const status = ["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(data?.status) ? data.status : null;
  const usage = usageCounts(data);
  const summary = { model, serviceTier, status, usage, currency: "USD", pricingAsOf: PRICING_DATE,
    estimatedInputCostUSD: null, estimatedOutputCostUSD: null, estimatedCostUSD: null,
    note: "Usage was not returned or was invalid; the charge is unknown, not necessarily zero." };
  if (!usage) return summary;
  if (profile.endpoint !== DEFAULT_KNOWLEDGE_API_ENDPOINT) {
    summary.note = "Custom endpoint pricing is unknown; token usage is reported without a cost estimate.";
    return summary;
  }
  if (!model || !serviceTier || (model === "gpt-4.1-mini" && serviceTier !== "default")) {
    summary.note = "Pricing for this model or processing tier is unknown; no cost estimate is available.";
    return summary;
  }
  const prices = MODEL_PRICES[model];
  if (usage.cacheWriteInputTokens && prices.cacheWrite === null) {
    summary.note = "Cache-write pricing for this model is unknown; no cost estimate is available.";
    return summary;
  }
  const longContext = prices.longContext && usage.inputTokens > 272000;
  const tierMultiplier = TIER_MULTIPLIERS[serviceTier];
  const ordinaryInput = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  summary.estimatedInputCostUSD = (ordinaryInput * prices.input + usage.cachedInputTokens * prices.cached
    + usage.cacheWriteInputTokens * (prices.cacheWrite ?? 0)) * (longContext ? 2 : 1) * tierMultiplier / 1_000_000;
  // output_tokens already includes reasoning_tokens: charge them once, not twice.
  summary.estimatedOutputCostUSD = usage.outputTokens * prices.output * (longContext ? 1.5 : 1) * tierMultiplier / 1_000_000;
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
