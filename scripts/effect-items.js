/** Resolves only persistent PF2e Effect Items so zones never store temporary drag data. */
export async function inspectEffectItem(uuid, resolver = globalThis.fromUuid) {
  const value = String(uuid ?? "").trim();
  if (!value) return { error: "Effect Item UUID is required." };
  let document;
  try {
    document = await resolver(value);
  } catch {
    return { error: `Effect Item could not be found: ${value}` };
  }
  if (!document) return { error: `Effect Item could not be found: ${value}` };
  if (document.documentName !== "Item" || document.type !== "effect") {
    return { error: `This UUID is not a PF2e Effect Item: ${value}` };
  }
  return { uuid: value, name: document.name ?? "Effect Item", img: document.img ?? "" };
}

/** Selects the outcomes the runtime can apply for this block's save setting. */
export function activeOutcomeKeys(block) {
  return block.save?.enabled
    ? ["criticalSuccess", "success", "failure", "criticalFailure"]
    : ["noSave"];
}

/** Applies the same Effect Item checks to active payloads before a preset or Region is saved. */
export async function validateEffectItems(config, resolver = globalThis.fromUuid) {
  const errors = [];
  const issues = [];
  const resolved = new Map();
  for (const [index, block] of (config.effects ?? []).entries()) {
    for (const outcomeKey of activeOutcomeKeys(block)) {
      const outcome = block.outcomes?.[outcomeKey];
      for (const [effectIndex, effect] of (outcome?.effects ?? []).entries()) {
        const uuid = String(effect.uuid ?? "").trim();
        if (!uuid) continue;
        if (!resolved.has(uuid)) resolved.set(uuid, await inspectEffectItem(uuid, resolver));
        const result = resolved.get(uuid);
        if (!result.error) continue;
        const message = `${block.name || `Effect Block ${index + 1}`} ${outcomeKey} Effect Item ${effectIndex + 1}: ${result.error}`;
        errors.push(message);
        issues.push({ message, target: { scope: "block", index, field: "effect-uuid", outcomeKey, effectIndex } });
      }
    }
  }
  return { errors, issues };
}
