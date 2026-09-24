/**
 * Anchor a finite zone to the source's next eligible turn so missed combat hooks
 * cannot add time to its duration.
 */
export function combatDurationDeadline(combat, sourceCombatant, rounds) {
  if (!combat?.id || !Number.isSafeInteger(rounds) || rounds < 1) return null;

  const round = Number(combat.round ?? 0);
  const turn = Number(combat.turn ?? -1);
  const sourceTurn = Array.isArray(combat.turns)
    ? combat.turns.findIndex((entry) => entry.id === sourceCombatant?.id)
    : -1;
  const sourceStillAhead = round > 0 && turn >= 0 && sourceTurn > turn;

  return {
    combatId: combat.id,
    combatExpiresAtRound: round + rounds - Number(sourceStillAhead),
    lastObservedRound: round
  };
}
