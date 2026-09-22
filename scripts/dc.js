/** Keeps DC selection compatible with the statistic shapes PF2e exposes across actor types. */
export function statisticDc(statistic) {
  const value = statistic?.dc?.value ?? statistic?.dc ?? null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

/**
 * Return the best usable class or spell DC for an Actor.
 *
 * PF2e exposes `class-spell` as a convenience statistic. During actor data
 * preparation it can temporarily be its fallback value of 0, even when the
 * separately prepared spell statistic already has a valid DC. Build this
 * choice from the prepared class and spell statistics instead.
 */
export function highestClassOrSpellDc(actor) {
  const values = [];
  /** Keeps only usable prepared statistics in the comparison so incomplete actor data cannot lower a DC. */
  const add = (statistic) => {
    const dc = statisticDc(statistic);
    if (dc !== null) values.push(dc);
  };

  try {
    add(actor?.classDC);
    for (const statistic of Object.values(actor?.classDCs ?? {})) add(statistic);
    add(actor?.getStatistic?.("spell-dc"));

    const entries = actor?.spellcasting?.contents
      ?? (Array.isArray(actor?.spellcasting) ? actor.spellcasting : []);
    for (const entry of entries) add(entry?.statistic);
  } catch (_error) {
    // Actor types expose different subsets of class and spell statistics.
  }

  if (values.length) return Math.max(...values);

  // Keep the system convenience statistic as a fallback for actor types that
  // do not expose one of the collections above.
  try {
    return statisticDc(actor?.getStatistic?.("class-spell"));
  } catch (_error) {
    return null;
  }
}
