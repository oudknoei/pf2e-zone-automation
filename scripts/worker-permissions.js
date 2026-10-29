/** Rejects stale or forged socket identities before any world data is changed. */
export function getWorkerRequester(request) {
  const user = game.users.get(request.requesterUserId ?? "");

  if (!user) throw new Error("The requesting user no longer exists.");
  if (!user.active) throw new Error(`Requesting user '${user.name}' is not active.`);

  return user;
}

/** Prevents a player from creating or changing zones through an Actor they do not own. */
export function assertSourcePermission(actor, requester) {
  if (requester.isGM) return;
  if (!actor?.testUserPermission?.(requester, "OWNER")) {
    throw new Error(`${requester.name} does not own the source Actor '${actor?.name ?? "Unknown"}'.`);
  }
}
