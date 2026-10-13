import { canonicalJson } from "./utils.js";

/** Captures every accepted save detail independently of repaired configuration or later preset edits. */
export function presetSaveFingerprint(request) {
  return canonicalJson({
    version: 1, requesterUserId: request.requesterUserId ?? null,
    recordId: request.recordId ?? null, expectedRevision: request.expectedRevision ?? null,
    sourceActorUuid: request.sourceActorUuid ?? null, config: request.config ?? null
  });
}
