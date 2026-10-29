import { escapeHtml, readDocumentFlag } from "./utils.js";
import {
  canManageHeroPoints,
  heroPointState,
  nextHeroPointTotal,
  validateHeroPointChange
} from "./hero-points-rules.js";

const MODULE_ID = "pf2e-zone-automation";
const RECEIPT_FLAG = "heroPointOperation";
const REQUEST_TTL_MS = 10 * 60 * 1000;
const operations = new Map();
const actorTails = new Map();

/** Revalidates the elected GM and active requester before queued resource changes begin. */
function requireHeroPointRequester(requesterUserId) {
  if (!game.user?.isGM || game.users.activeGM?.id !== game.user.id) {
    throw new Error("Hero Point changes must be resolved by the active GM. Review the totals and try again.");
  }

  const requester = game.users.get(requesterUserId);

  if (!requester?.active) throw new Error("Only an active user can change Hero Points.");

  return requester;
}

/** Resolves only eligible world characters on the authoritative client. */
function heroPointActor(actorId, requester) {
  const actor = game.actors.get(actorId);

  if (actor?.type !== "character" || !actor.hasPlayerOwner) {
    throw new Error("Choose at least one player character to update.");
  }
  if (!canManageHeroPoints(actor, requester)) {
    const error = new Error("You can only change Hero Points for characters you own.");

    error.code = "PF2E_ZONE_HERO_POINTS_PERMISSION";

    throw error;
  }

  return actor;
}

/** Validates immutable request details before joining or creating a retry plan. */
function normalizeHeroPointRequest(request, requester) {
  validateHeroPointChange(request.amount, request.mode);

  if (typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(request.operationId)) {
    throw new Error("Hero Point operation ID is invalid.");
  }
  if (!Array.isArray(request.actorIds) || !request.actorIds.length
      || request.actorIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("Choose at least one player character to update.");
  }

  const actorIds = [...new Set(request.actorIds)];

  actorIds.forEach(id => heroPointActor(id, requester));

  return { ...request, actorIds };
}

/** Serializes one Actor without blocking changes to unrelated characters or poisoning later work after failure. */
function serializeHeroPointActor(actorId, change) {
  const result = (actorTails.get(actorId) ?? Promise.resolve()).then(change);
  const tail = result.then(() => undefined, () => undefined);

  actorTails.set(actorId, tail);
  tail.then(() => {
    if (actorTails.get(actorId) === tail) actorTails.delete(actorId);
  });

  return result;
}

/** Confirms a committed update even if its acknowledgment failed, without inferring success from a matching total alone. */
function hasHeroPointReceipt(actor, request, fingerprint) {
  const receipt = readDocumentFlag(actor, MODULE_ID, RECEIPT_FLAG);

  return receipt?.operationId === request.operationId && receipt.requesterUserId === request.requesterUserId
    && receipt.fingerprint === fingerprint;
}

/** Applies a frozen retry only while its original resource state and preceding module operation still match. */
async function changeHeroPointActor(request, operation, entry) {
  const requester = requireHeroPointRequester(request.requesterUserId);
  const actor = heroPointActor(entry.actorId, requester);

  if (entry.complete) return null;

  const state = heroPointState(actor);
  const priorOperation = JSON.stringify(readDocumentFlag(actor, MODULE_ID, RECEIPT_FLAG));

  if (entry.before == null) {
    Object.assign(entry, {
      before: state.value,
      max: state.max,
      priorOperation,
      total: nextHeroPointTotal(actor, request.amount, request.mode),
      name: actor.name
    });
  } else if (hasHeroPointReceipt(actor, request, operation.fingerprint)) {
    entry.complete = true;

    return null;
  } else if (state.value !== entry.before || state.max !== entry.max || priorOperation !== entry.priorOperation) {
    const error = new Error("Hero Points changed since this update. Review the current totals and apply a new change.");

    error.code = "PF2E_ZONE_HERO_POINTS_CONFLICT";

    throw error;
  }
  if (entry.before === entry.total) {
    entry.complete = true;

    return null;
  }

  try {
    await actor.update({
      "system.resources.heroPoints.value": entry.total,
      [`flags.${MODULE_ID}.${RECEIPT_FLAG}`]: {
        operationId: request.operationId,
        requesterUserId: request.requesterUserId,
        fingerprint: operation.fingerprint
      }
    });

    if (!hasHeroPointReceipt(actor, request, operation.fingerprint)) {
      throw new Error("The Actor update was not confirmed. Retry to finish the same change.");
    }
  } catch (error) {
    if (!hasHeroPointReceipt(actor, request, operation.fingerprint)) throw error;
  }

  entry.complete = true;

  return {
    actorId: actor.id,
    name: actor.name,
    before: entry.before,
    after: entry.total
  };
}

/** Posts only changes completed in this attempt, so retries do not announce completed awards again. */
async function announceHeroPointChanges(changes, requesterUserId) {
  if (!changes.length) return [];

  try {
    await ChatMessage.create({
      content: `<p><strong>Hero Points updated</strong></p><ul>${changes.map(({ name, before, after }) =>
        `<li>${escapeHtml(name)}: ${before} → ${after}</li>`).join("")}</ul>`,
      author: requesterUserId,
      whisper: [...new Set([...game.users].filter((user) => user.isGM || user.id === requesterUserId).map((user) => user.id))]
    });

    return [];
  } catch (error) {
    console.error("PF2e Zone Hero Point announcement failed", error);

    return ["Hero Points were updated, but the chat summary could not be posted."];
  }
}

/** Retains partial progress and distinguishes stale plans from write failures that can safely be retried. */
async function applyHeroPointOperation(request, operation) {
  const changed = [];
  const failures = [];
  let conflict = false;
  let permissionDenied = false;

  for (const entry of operation.plan) {
    try {
      const result = await serializeHeroPointActor(entry.actorId, () => changeHeroPointActor(request, operation, entry));

      if (result) changed.push(result);
    } catch (error) {
      failures.push(`${entry.name ?? entry.actorId}: ${error?.message ?? error}`);
      if (error?.code === "PF2E_ZONE_HERO_POINTS_CONFLICT") conflict = true;
      if (error?.code === "PF2E_ZONE_HERO_POINTS_PERMISSION") {
        permissionDenied = conflict = true;
        break;
      }

      // Stop after a handoff or permission change; the replacement GM must start a reviewed operation.
      try {
        requireHeroPointRequester(request.requesterUserId);
      } catch {
        conflict = true;
        break;
      }
    }
  }

  const warnings = await announceHeroPointChanges(changed, request.requesterUserId);
  const requester = game.users.get(request.requesterUserId);
  const visiblePlan = requester?.active
    ? operation.plan.filter(entry => canManageHeroPoints(game.actors.get(entry.actorId), requester))
    : [];
  const result = {
    action: "set-hero-points",
    ok: !failures.length,
    warnings,
    plan: visiblePlan.map(({ actorId, total }) => ({ actorId, total })),
    changes: visiblePlan.filter((entry) => entry.complete && entry.before !== entry.total)
      .map(({ actorId, name, before, total }) => ({
        actorId,
        name,
        before,
        after: total
      }))
  };

  if (failures.length)
    Object.assign(result, {
      error: permissionDenied
        ? "Character access changed while this update was pending. Review your characters before applying again."
        : conflict
          ? `Hero Points changed while this update was pending. Review the totals before applying again. ${failures.join("; ")}`
          : `Some Hero Points could not be updated. Retry to finish the same change. ${failures.join("; ")}`,
      errorCode: permissionDenied
        ? "PF2E_ZONE_HERO_POINTS_PERMISSION"
        : conflict ? "PF2E_ZONE_HERO_POINTS_CONFLICT" : "PF2E_ZONE_HERO_POINTS_UPDATE_FAILED",
      retryable: !conflict
    });
  if (result.ok || conflict) operation.result = result;

  return result;
}

/** Joins duplicate submissions and routes independent operations through authoritative per-Actor queues. */
export async function executeHeroPointChange(rawRequest) {
  const requester = requireHeroPointRequester(rawRequest.requesterUserId);
  const request = normalizeHeroPointRequest(rawRequest, requester);
  const now = Date.now();

  for (const [key, operation] of operations) {
    if (!operation.promise && now - operation.updatedAt > REQUEST_TTL_MS) operations.delete(key);
  }

  const key = `${request.requesterUserId}:${request.operationId}`;
  const fingerprint = JSON.stringify({ actorIds: [...request.actorIds].sort(), amount: request.amount, mode: request.mode });
  let operation = operations.get(key);

  if (operation && operation.fingerprint !== fingerprint)
    throw new Error("Hero Point operation ID was reused with different details.");
  if (!operation) {
    if (request.retry || request.actorIds.some((id) => hasHeroPointReceipt(heroPointActor(id, requester), request, fingerprint))) {
      throw new Error("The Hero Point retry plan is no longer available. Review the current totals and apply a new change.");
    }

    operation = { fingerprint, updatedAt: now, plan: request.actorIds.map((actorId) => ({ actorId, before: null, complete: false })) };
    operations.set(key, operation);
  }
  if (operation.result) return operation.result;
  if (operation.promise) return operation.promise;

  operation.promise = applyHeroPointOperation(request, operation);

  try {
    return await operation.promise;
  } finally {
    operation.promise = null;
    operation.updatedAt = Date.now();
  }
}
