const POSITIVE_INTEGER = /^[1-9]\d*$/;
const SAFE_DICE_FORMULA = /^[0-9dD+*\/()\s-]+$/;
const HAS_DIE_TERM = /(?:\d*)d\d+/i;

/** Keeps custom durations predictable by accepting only whole rounds or safe dice expressions. */
export function parseDurationRounds(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0
      ? { kind: "number", rounds: value }
      : { kind: "invalid" };
  }

  const text = String(value ?? "").trim();
  if (POSITIVE_INTEGER.test(text)) {
    const rounds = Number(text);
    return Number.isSafeInteger(rounds) && rounds > 0
      ? { kind: "number", rounds }
      : { kind: "invalid" };
  }

  if (SAFE_DICE_FORMULA.test(text) && HAS_DIE_TERM.test(text)) {
    return { kind: "formula", formula: text };
  }

  return { kind: "invalid" };
}

/** Preserves a valid duration for older presets while giving incomplete input a safe fallback. */
export function normalizeDurationRounds(value, fallback = 1) {
  const parsed = parseDurationRounds(value);
  if (parsed.kind === "number") return parsed.rounds;
  if (parsed.kind === "formula") return parsed.formula;

  const text = String(value ?? "").trim();
  return text || fallback;
}

/** Gives the builder one authoritative explanation for invalid duration input. */
export function durationRoundsError(value) {
  return parseDurationRounds(value).kind === "invalid"
    ? "Duration rounds must be a positive whole number or a dice formula such as 2d4."
    : null;
}

/** Rolls a formula once at zone creation so every client shares the same lifetime. */
export async function resolveDurationRounds(duration, { RollClass = globalThis.Roll } = {}) {
  switch (duration?.type) {
    case "1-round":
      return { rounds: 1, formula: null };
    case "custom-rounds": {
      const parsed = parseDurationRounds(duration.rounds);
      const error = durationRoundsError(duration.rounds);
      if (error) throw new Error(error);

      if (parsed.kind === "number") return { rounds: parsed.rounds, formula: null };
      if (typeof RollClass !== "function") {
        throw new Error("Foundry's Roll class is unavailable; duration formulas cannot be evaluated.");
      }

      let roll;
      try {
        roll = await new RollClass(parsed.formula).evaluate({ async: true });
      } catch (cause) {
        throw new Error(`Could not evaluate duration formula '${parsed.formula}'.`, { cause });
      }

      const rounds = Number(roll?.total);
      if (!Number.isSafeInteger(rounds) || rounds < 1) {
        throw new Error(`Duration formula '${parsed.formula}' must produce a positive whole number of rounds.`);
      }
      return { rounds, formula: parsed.formula };
    }
    case "1-minute":
      return { rounds: 10, formula: null };
    case "10-minutes":
      return { rounds: 100, formula: null };
    default:
      return null;
  }
}