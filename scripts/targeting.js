const AFFECTS = new Set(["allies", "enemies", "both", "none"]);

/** Lets old saved values and the self-only value appear as independent choices in the builder. */
export function targetingChoices(targeting = {}) {
  return {
    allies: targeting?.affects === "allies" || targeting?.affects === "both",
    enemies: targeting?.affects === "enemies" || targeting?.affects === "both",
    self: Boolean(targeting?.includeSelf)
  };
}

/** Keeps checkbox edits in the existing affects and includeSelf fields used by saved zones. */
export function storedTargeting({ allies = false, enemies = false, self = false } = {}) {
  return {
    affects: allies && enemies ? "both" : allies ? "allies" : enemies ? "enemies" : "none",
    includeSelf: Boolean(self)
  };
}

/** Prevents a zone that cannot affect anyone from being saved or created. */
export function hasTargetSelection(targeting) {
  if (!AFFECTS.has(targeting?.affects)) return false;
  const choices = targetingChoices(targeting);
  return choices.allies || choices.enemies || choices.self;
}

/** Uses the same names in previews that users selected in the builder. */
export function targetLabels(targeting) {
  const choices = targetingChoices(targeting);
  return [
    choices.allies && "Allies",
    choices.enemies && "Enemies",
    choices.self && "Self (Source Actor)"
  ].filter(Boolean);
}
