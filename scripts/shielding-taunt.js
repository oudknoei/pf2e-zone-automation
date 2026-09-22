import { requestGMWorker } from "./transport.js";

const MODULE_ID = "pf2e-zone-automation";

/** Keeps player-facing macros thin so all Shielding Taunt rule changes ship with the module. */
export async function requestShieldingTaunt(sourceTokenUuid, targetTokenUuid) {
  if (!sourceTokenUuid || !targetTokenUuid) {
    throw new Error("Shielding Taunt requires a Guardian token and a target token.");
  }
  const response = await requestGMWorker({
    protocol: 1,
    action: "shielding-taunt",
    requesterUserId: game.user.id,
    sourceTokenUuid,
    targetTokenUuid
  });
  if (!response?.ok) throw new Error(response?.error ?? "Shielding Taunt failed.");
  return response;
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
    return await requestShieldingTaunt(
      controlled[0].document.uuid,
      targets[0].document.uuid
    );
  } catch (error) {
    console.error("PF2e Zone Automation Shielding Taunt failed", error);
    ui.notifications.error(error?.message ?? "Shielding Taunt failed.");
    return null;
  }
}

export { MODULE_ID };
