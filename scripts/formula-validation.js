/** Checks the exact PF2e damage or healing expression that the runtime will roll. */
export function pf2eFormulaError(formula, type, { DamageRollClass = globalThis.CONFIG?.Dice?.rolls?.find((cls) => cls?.name === "DamageRoll") } = {}) {
  const text = String(formula ?? "").trim();
  if (!text) return "Enter a formula.";
  if (typeof DamageRollClass?.validate !== "function") return "PF2e's DamageRoll validator is unavailable.";

  try {
    return DamageRollClass.validate(`{(${text})[${type}]}`)
      ? null
      : "PF2e does not recognize this formula.";
  } catch {
    return "PF2e does not recognize this formula.";
  }
}
