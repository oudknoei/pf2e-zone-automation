/** Uses shared world time so duration decisions remain consistent across connected clients. */
export const nowWorld = () => Number(game.time?.worldTime ?? 0);

/** Builds safe flag keys from document identifiers that may contain punctuation. */
export const stateKey = (...parts) => parts
  .map((part) => String(part ?? "").replace(/[^A-Za-z0-9_-]/g, "_"))
  .join("__");

/** Produces an order-independent signature for JSON-compatible persisted flag data. */
export const dataSignature = (value) => JSON.stringify(value, (_key, nested) => {
  if (!nested || Array.isArray(nested) || typeof nested !== "object") return nested;
  return Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]));
});

/** Allows saved zones to be migrated safely when runtime behavior changes between releases. */
export const compareVersions = (a, b) => {
  const pa = String(a ?? "0").split(".").map((n) => Number(n) || 0);
  const pb = String(b ?? "0").split(".").map((n) => Number(n) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
};
