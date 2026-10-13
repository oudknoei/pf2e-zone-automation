/** Escapes world-provided text for HTML content and quoted attribute values. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Copies configuration and flag data without mutating the source, including older browsers without structuredClone. */
export function cloneData(value) {
  if (globalThis.structuredClone) return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** Sorts JSON object keys without changing the meaningful order of arrays. */
function orderedJsonData(value) {
  if (Array.isArray(value)) return value.map(orderedJsonData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, orderedJsonData(value[key])]));
  }
  return value;
}

/** Gives operation fingerprints a stable representation using the same value conversions as socket JSON. */
export function canonicalJson(value) {
  return JSON.stringify(orderedJsonData(JSON.parse(JSON.stringify(value))));
}

/** Makes stored slugs readable without changing their data identity. */
export function titleCase(value) {
  return String(value ?? "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Uses system translations when available and preserves the caller's fallback for custom content. */
export function localize(key, fallback) {
  if (typeof key !== "string") return fallback;
  const localized = game.i18n.localize(key);
  return localized && localized !== key ? localized : fallback;
}

/** Preserves the short identifiers used for configuration blocks, library records, and runtime events. */
export function randomId(length = 12) {
  return globalThis.foundry?.utils?.randomID?.(length) ?? crypto.randomUUID().slice(0, length);
}

/** Gives socket requests and retriable actions a durable ID, preserving the full UUID fallback. */
export function newOperationId() {
  return globalThis.foundry?.utils?.randomID?.(20) ?? crypto.randomUUID();
}

/** Creates a valid Foundry document ID even when the native generator is unavailable. */
export function newDocumentId() {
  return globalThis.foundry?.utils?.randomID?.(16) ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

/** Reads flags from live Foundry documents or source-shaped data used during recovery. */
export function readDocumentFlag(document, scope, key) {
  return document?.getFlag?.(scope, key) ?? document?.flags?.[scope]?.[key] ?? null;
}

/** Checks the chat's actual author against world Users, retaining the legacy user field for saved cards. */
export function isGMAuthoredMessage(message) {
  const author = message?.author !== undefined ? message.author : message?.user;
  const authorId = typeof author === "string" ? author : author?.id;
  return Boolean(typeof authorId === "string" && game.users?.get(authorId)?.isGM);
}
