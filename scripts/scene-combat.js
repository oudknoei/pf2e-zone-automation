/** Resolves the owning Scene from saved token UUIDs without loading documents. */
function sceneIdFromTokenUuid(uuid) {
  return /^Scene\.([^.]+)\.Token\.[^.]+$/.exec(String(uuid ?? ""))?.[1] ?? null;
}

/** Reads the available roster before and after Foundry builds turn order. */
function combatants(combat) {
  return Array.isArray(combat?.turns) && combat.turns.length
    ? combat.turns
    : Array.from(combat?.combatants?.contents ?? combat?.combatants ?? []);
}

/** Keeps another Scene's encounter from advancing a zone's clock. */
function combatSceneId(combat) {
  const explicit = combat?.scene?.id ?? combat?.sceneId ?? combat?._source?.scene;
  if (explicit) return explicit;
  return combatants(combat).map((entry) =>
    entry?.token?.parent?.id ?? sceneIdFromTokenUuid(entry?.token?.uuid)
  ).find(Boolean) ?? null;
}

/** Requires the actual source token when possible so reused Actors cannot borrow another token's turn. */
export function sourceCombatantInCombat(combat, sourceTokenUuid, sourceActorUuid, recordedId = null) {
  const roster = combatants(combat);
  const tokenId = /^Scene\.[^.]+\.Token\.([^.]+)$/.exec(String(sourceTokenUuid ?? ""))?.[1];
  const exact = roster.find((entry) => entry?.token?.uuid === sourceTokenUuid ||
    (tokenId && entry?.tokenId === tokenId));
  if (exact) return exact;
  if (recordedId) {
    const recorded = roster.find((entry) => entry?.id === recordedId &&
      (!sourceActorUuid || entry?.actor?.uuid === sourceActorUuid));
    if (recorded) return recorded;
  }
  return roster.find((entry) => !entry?.token && !entry?.tokenId &&
    sourceActorUuid && entry?.actor?.uuid === sourceActorUuid) ?? null;
}

/** Returns an encounter only when its Scene and source match, preserving a recorded clock after roster removal. */
export function combatForZone({ sceneId, sourceTokenUuid, sourceActorUuid, recordedCombatId = null }) {
  if (!sceneId || !sourceTokenUuid) return null;
  const candidates = [game.combat, ...Array.from(game.combats?.contents ?? game.combats ?? [])];
  const seen = new Set();
  let recorded = null;
  for (const combat of candidates) {
    if (!combat?.id || seen.has(combat.id) || combatSceneId(combat) !== sceneId) continue;
    seen.add(combat.id);
    if (combat.started === false) continue;
    const sourceCombatant = sourceCombatantInCombat(combat, sourceTokenUuid, sourceActorUuid, recordedCombatId);
    if (sourceCombatant) return { combat, sourceCombatant };
    if (combat.id === recordedCombatId) recorded = { combat, sourceCombatant: null };
  }
  return recorded;
}

/** Finds the owning Scene of saved zones without requiring asynchronous UUID lookup for each clock check. */
export function combatForZoneState(state, recordedCombatId = null) {
  const sourceTokenUuid = state?.sourceTokenUuid;
  return combatForZone({
    sceneId: sceneIdFromTokenUuid(sourceTokenUuid),
    sourceTokenUuid,
    sourceActorUuid: state?.sourceActorUuid,
    recordedCombatId
  });
}
