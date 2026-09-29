import { requestGMWorker } from "./transport.js";

const MODULE_ID = "pf2e-zone-automation";
const shieldingTauntAttempts = new Map();

/** Gives retries one stable identity while a timed-out GM request may still be finishing. */
function newOperationId() {
  return foundry.utils.randomID?.(20) ?? crypto.randomUUID();
}

/** Keeps player-facing macros thin so all Shielding Taunt rule changes ship with the module. */
export async function requestShieldingTaunt(sourceTokenUuid, targetTokenUuid, { operationId: suppliedOperationId = null } = {}) {
  if (!sourceTokenUuid || !targetTokenUuid) {
    throw new Error("Shielding Taunt requires a Guardian token and a target token.");
  }

  if (suppliedOperationId) {
    const response = await requestGMWorker({
      protocol: 1, action: "shielding-taunt", requesterUserId: game.user.id,
      operationId: suppliedOperationId, sourceTokenUuid, targetTokenUuid
    });
    if (!response?.ok) throw new Error(response?.error ?? "Shielding Taunt failed.");
    return response;
  }

  let attempt = shieldingTauntAttempts.get(sourceTokenUuid);
  if (attempt && attempt.targetTokenUuid !== targetTokenUuid) {
    throw new Error("A previous Shielding Taunt request may still finish. Retry it against the same target before choosing another target.");
  }
  if (attempt?.promise) return attempt.promise;
  if (!attempt) {
    attempt = { operationId: newOperationId(), targetTokenUuid, promise: null, uncertain: false };
    shieldingTauntAttempts.set(sourceTokenUuid, attempt);
  }

  attempt.promise = (async () => {
    try {
      const response = await requestGMWorker({
        protocol: 1,
        action: "shielding-taunt",
        requesterUserId: game.user.id,
        operationId: attempt.operationId,
        sourceTokenUuid,
        targetTokenUuid
      });
      if (!response?.ok) {
        const error = new Error(response?.error ?? "Shielding Taunt failed.");
        error.code = response?.errorCode;
        error.retryable = Boolean(response?.retryable);
        throw error;
      }
      if (shieldingTauntAttempts.get(sourceTokenUuid) === attempt) shieldingTauntAttempts.delete(sourceTokenUuid);
      return response;
    } catch (error) {
      attempt.promise = null;
      attempt.uncertain = error?.code === "PF2E_ZONE_REQUEST_TIMEOUT" || error?.retryable === true;
      if (!attempt.uncertain && shieldingTauntAttempts.get(sourceTokenUuid) === attempt) {
        shieldingTauntAttempts.delete(sourceTokenUuid);
      }
      throw error;
    }
  })();
  return attempt.promise;
}

/** Makes target selection explicit before the module asks the GM to alter combat state. */
export async function openShieldingTaunt() {
  const controlled = canvas?.tokens?.controlled ?? [];
  const targets = [...(game.user?.targets ?? [])];

  if (controlled.length !== 1) {
    ui.notifications.warn("Select exactly one Guardian token.");
    return null;
  }
  if (targets.length !== 1) {
    ui.notifications.warn("Target exactly one creature.");
    return null;
  }

  try {
    const response = await requestShieldingTaunt(
      controlled[0].document.uuid,
      targets[0].document.uuid
    );
    for (const warning of response.warnings ?? []) ui.notifications.warn(warning);
    return response;
  } catch (error) {
    console.error("PF2e Zone Automation Shielding Taunt failed", error);
    ui.notifications.error(error?.message ?? "Shielding Taunt failed.");
    return null;
  }
}

export { MODULE_ID };
