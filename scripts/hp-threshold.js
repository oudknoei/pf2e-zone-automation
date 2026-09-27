/** Keeps an empty or malformed threshold visible to validation instead of silently replacing it. */
export function editableHpThreshold(value) {
  if (value == null) return "";
  const text = String(value).trim();
  if (!text) return "";
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? number : text;
}

/** Triggers only when an HP change crosses the configured boundary. */
export function crossedHpThreshold(previous, current, threshold) {
  return Number.isFinite(previous) && Number.isFinite(current)
    && Number.isSafeInteger(threshold) && threshold >= 0
    && previous > threshold && current <= threshold;
}

/** Ignores unavailable actor HP instead of turning it into zero. */
export function actorHitPoints(actor) {
  const raw = actor?.system?.attributes?.hp?.value;
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
