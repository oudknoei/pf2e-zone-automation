/** Reads PF2e's Hero Point resource, respecting character maxima below three. */
export function heroPointState(actor) {
  const resource = actor.system?.resources?.heroPoints;
  return {
    value: Number(resource?.value ?? 0),
    max: Math.min(3, Math.max(0, Number(resource?.max ?? 3)))
  };
}

/** Computes bounded totals consistently for previews and authoritative changes. */
export function nextHeroPointTotal(actor, amount, mode) {
  const { value, max } = heroPointState(actor);
  const total = mode === "set" ? amount : value + (mode === "remove" ? -amount : amount);
  return Math.min(max, Math.max(0, total));
}

/** Preserves the additive API's signed integers while validating explicit Remove and Set operations. */
export function validateHeroPointChange(amount, mode) {
  if (!Number.isInteger(amount) || !["add", "remove", "set"].includes(mode)
      || (mode !== "add" && amount < 0)) {
    throw new Error("Enter a whole number of Hero Points and choose Add, Remove, or Set total.");
  }
}
