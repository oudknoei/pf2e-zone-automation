import { requestGMWorker } from "./transport.js";

const MODULE_ID = "pf2e-zone-automation";

/** Request a Shielding Taunt using known source and target token UUIDs. */
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

/** Read the current token selection and target, then request a Shielding Taunt. */
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
