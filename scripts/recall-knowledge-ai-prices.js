// Manually verified text-token rates; runtime never fetches prices or reads credentials here.
// Update procedure: docs/ask-a-question-about.md#pricing-maintenance.
export const KNOWLEDGE_AI_PRICING = Object.freeze({
  asOf: "2026-10-13",
  currency: "USD",
  tokensPerUnit: 1_000_000,
  tierSource: "https://developers.openai.com/api/docs/pricing",
  // Priority is the older API name for Fast mode, with the same rate.
  tierMultipliers: Object.freeze({ default: 1, flex: 0.5, fast: 2, priority: 2 }),
  modelAliases: Object.freeze({ "gpt-4.1-mini-2025-04-14": "gpt-4.1-mini" }),
  models: Object.freeze({
    "gpt-6-luna": Object.freeze({
      source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
      input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50,
      supportedTiers: Object.freeze(["default", "flex", "fast", "priority"]),
      // The full request uses these multipliers only when input exceeds this threshold.
      longContext: Object.freeze({ inputTokensOver: 272000, inputMultiplier: 2, outputMultiplier: 1.5 })
    }),
    "gpt-4.1-mini": Object.freeze({
      source: "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
      input: 0.40, cached: 0.10, cacheWrite: null, output: 1.60,
      supportedTiers: Object.freeze(["default"]),
      longContext: null
    })
  })
});
