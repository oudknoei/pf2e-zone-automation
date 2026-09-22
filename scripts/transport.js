import { handleWorkerRequest } from "./worker.js";

const CHANNEL = "module.pf2e-zone-automation";
const RESPONSE_TIMEOUT_MS = 60000;
const pending = new Map();
let listening = false;

/** Installs one dispatcher so player requests reach a GM without requiring world macros. */
export function registerZoneSocket() {
  if (listening) return;
  if (!game.socket) throw new Error("Foundry's game socket is unavailable.");
  game.socket.on(CHANNEL, onSocketMessage);
  listening = true;
}

/** Gives callers a bounded request-response path instead of leaving player actions pending indefinitely. */
export async function requestGMWorker(request) {
  if (game.user.isGM) return handleWorkerRequest(request);

  const gm = game.users.activeGM;
  if (!gm) throw new Error("An active GM must be logged into the world for player PF2e Zone operations.");
  if (!game.socket?.connected || !listening) {
    throw new Error("The PF2e Zone module socket is not ready. Refresh Foundry and try again.");
  }

  const id = foundry.utils.randomID?.(20) ?? crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The GM did not respond to the PF2e Zone request in time."));
    }, RESPONSE_TIMEOUT_MS);
    pending.set(id, { resolve, gmId: gm.id, timeout });
    try {
      game.socket.emit(CHANNEL, { kind: "request", id, gmId: gm.id, request });
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(id);
      reject(error);
    }
  });
}

/** Ensures only the active GM processes a player request and returns its result to the requester. */
async function onSocketMessage(message, senderUserId) {
  if (!message || typeof message !== "object" || typeof message.id !== "string") return;

  if (message.kind === "response") {
    if (message.recipientUserId !== game.user.id) return;
    const entry = pending.get(message.id);
    if (!entry || senderUserId !== entry.gmId || message.gmId !== entry.gmId) return;
    clearTimeout(entry.timeout);
    pending.delete(message.id);
    entry.resolve(message.response);
    return;
  }

  if (message.kind !== "request" || !game.user.isGM) return;
  if (message.gmId !== game.user.id || game.users.activeGM?.id !== game.user.id) return;

  // Foundry's relay supplies the authenticated sender as the second argument.
  // A user id inside the message is never sufficient to authorize a GM action.
  if (typeof senderUserId !== "string" || !game.users.get(senderUserId)?.active) return;
  const request = message.request;
  let response;
  try {
    response = request?.requesterUserId === senderUserId
      ? await handleWorkerRequest(request)
      : { ok: false, error: "The PF2e Zone requester does not match the socket sender." };
  } catch (error) {
    console.error("PF2e Zone GM request failed", error);
    response = { ok: false, error: String(error?.message ?? error) };
  }
  game.socket.emit(CHANNEL, {
    kind: "response",
    id: message.id,
    gmId: game.user.id,
    recipientUserId: senderUserId,
    response
  });
}
