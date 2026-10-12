const INTERNAL_FIELDS = new Set(["typeLabels", "_stats", "_migration"]);
const DOCUMENT_FIELDS = new Set(["folder", "img", "sort", "ownership", "prototypeToken"]);

/** Copies factual reference data, omitting document bookkeeping and empty fields while preserving rule syntax. */
function cleanReferenceData(value, preserveEmpty = false) {
  if (Array.isArray(value)) return value.map((entry) => cleanReferenceData(entry, preserveEmpty));
  if (!value || typeof value !== "object") return value;
  const isDocument = typeof value.name === "string" && typeof value.type === "string" && value.system;
  const entries = [];
  for (const [key, entry] of Object.entries(value)) {
    if (INTERNAL_FIELDS.has(key) || (isDocument && DOCUMENT_FIELDS.has(key))) continue;
    const cleaned = cleanReferenceData(entry, preserveEmpty || key === "rules");
    if (!preserveEmpty && key !== "rules" && (cleaned == null || cleaned === "" ||
        (typeof cleaned === "object" && Object.keys(cleaned).length === 0))) continue;
    entries.push([key, cleaned]);
  }
  return Object.fromEntries(entries);
}

/** Records only prepared changes; null explicitly clears a source field that is absent from the current data. */
function referenceChanges(current, source) {
  if (JSON.stringify(current) === JSON.stringify(source)) return undefined;
  if (!current || !source || typeof current !== "object" || typeof source !== "object" ||
      Array.isArray(current) || Array.isArray(source)) return current;
  const entries = [];
  for (const key of new Set([...Object.keys(source), ...Object.keys(current)])) {
    if (!Object.hasOwn(current, key)) {
      entries.push([key, null]);
      continue;
    }
    const change = referenceChanges(current[key], source[key]);
    if (change !== undefined) entries.push([key, change]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Removes display breakdowns and roll-engine fields while retaining modifier values and conditional mechanics. */
function compactStatistic(statistic) {
  if (!statistic || typeof statistic !== "object") return;
  delete statistic.breakdown;
  for (const key of ["modifiers", "_modifiers"]) {
    for (const modifier of statistic[key] ?? []) {
      delete modifier.domains;
      delete modifier.hideIfDisabled;
      delete modifier.kind;
      if (modifier.force === false) delete modifier.force;
      if (modifier.custom === false) delete modifier.custom;
    }
  }
}

/** Builds a smaller creature reference without mutating the Actor or discarding abilities, spells, or current values. */
export function compactCreatureData(actor, currentSystem) {
  const reference = cleanReferenceData(actor);
  const prepared = cleanReferenceData(currentSystem);
  for (const collection of [prepared.skills, prepared.saves, prepared.attributes, prepared.movement?.speeds]) {
    for (const statistic of Object.values(collection ?? {})) compactStatistic(statistic);
  }
  compactStatistic(prepared.perception);
  compactStatistic(prepared.initiative);
  const items = new Map((reference.items ?? []).filter((item) => item._id).map((item) => [item._id, item]));
  for (const action of prepared.actions ?? []) {
    compactStatistic(action);
    for (const key of ["item", "weapon"]) {
      const item = action[key];
      const original = items.get(item?._id);
      if (!original) continue;
      const changes = referenceChanges(item, original);
      action[key] = { itemReference: original._id, ...(changes === undefined ? {} : { currentData: changes }) };
    }
  }
  const changes = referenceChanges(prepared, reference.system ?? {});
  return { actor: reference, ...(changes === undefined ? {} : { currentSystem: changes }) };
}
