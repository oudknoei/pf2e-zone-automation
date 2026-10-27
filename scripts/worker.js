import { zoneRuntimeEntrypoint } from "./runtime.js";
import { executeShieldingTaunt } from "./shielding-taunt-worker.js";
import { executeHeroPointChange } from "./hero-points-worker.js";
import { executeClearHeroPointReminders, executeCreateHeroPointReminder } from "./hero-point-reminder-worker.js";
import { fixedAreaShape, moveAreaShapesToCenter } from "./area-shape.js";
import { createZoneDocument, creationRequestFingerprint } from "./zone-creation.js";
import { cloneData as clone } from "./utils.js";
import { oncePerOperation } from "./request-cache.js";
import { createPresetRepository } from "./preset-repository.js";
import { getWorkerRequester, assertSourcePermission } from "./worker-permissions.js";
import { getWorkerActionPolicy } from "./worker-action-policy.js";
import { executeSessionNotes } from "./session-notes-repository.js";
/* GM-only document operations and authorization for module socket requests. */

const creationRequests = new Map();
const CREATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const shieldingTauntRequests = new Map();
const SHIELDING_TAUNT_REQUEST_TTL_MS = 10 * 60 * 1000;
const presetRepository = createPresetRepository();

/** Joins concurrent retries and remembers a completed result while a late socket reply is possible. */
function oncePerCreationRequest(request, create) {
  const operationId = request.operationId;
  if (operationId == null) return create();
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(operationId)) {
    throw new Error("Creation operation ID is invalid.");
  }
  const key = `${request.requesterUserId}:${operationId}`;
  const fingerprint = creationRequestFingerprint(request);
  return oncePerOperation(creationRequests, {
    key, fingerprint, ttlMs: CREATION_REQUEST_TTL_MS,
    reuseError: "Creation operation ID was reused with different zone details."
  }, () => create(fingerprint));
}

/** Joins duplicate Taunt requests and retains success while a socket response can arrive late. */
function oncePerShieldingTauntRequest(request, execute) {
  const operationId = request.operationId;
  if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(operationId)) {
    throw new Error("Shielding Taunt operation ID is invalid.");
  }
  const key = `${request.requesterUserId}:${operationId}`;
  const fingerprint = JSON.stringify({
    sourceTokenUuid: request.sourceTokenUuid,
    targetTokenUuid: request.targetTokenUuid
  });
  return oncePerOperation(shieldingTauntRequests, {
    key, fingerprint, ttlMs: SHIELDING_TAUNT_REQUEST_TTL_MS,
    reuseError: "Shielding Taunt operation ID was reused with different request details."
  }, execute);
}

/** Keeps privileged world changes behind one GM-only entry point so player requests remain constrained. */
export async function handleWorkerRequest(request) {
  "use strict";

  const WORKER_VERSION = "0.5.17";
  const FLAG_SCOPE = "world";
  const FLAG_KEY = "pf2eZone";
  /** Returns worker errors in one predictable shape so clients can present them safely. */
  const fail = (message, details = {}) => ({
    ok: false, workerVersion: WORKER_VERSION, error: String(message), ...details
  });
  /** Returns worker results in one predictable shape so the socket bridge can resolve requests consistently. */
  const succeed = (data = {}) => ({ ok: true, workerVersion: WORKER_VERSION, ...data });

  if (game.system.id !== "pf2e") return fail("PF2e Zone GM Worker requires the Pathfinder Second Edition system.");
  if (!game.user.isGM) return fail("PF2e Zone GM Worker must execute on an active GM client.");
  if (!request || request.protocol !== 1) return fail("No valid PF2e Zone worker request was supplied.");

  /** Enforces source ownership before the shared creation path changes the Scene. */
  async function createZone(creationFingerprint = null) {
    const requester = getWorkerRequester(request);
    const scene = game.scenes.get(request.sceneId ?? "");
    if (!scene) throw new Error("Target Scene was not found.");
    const sourceToken = await fromUuid(request.sourceTokenUuid ?? "");
    if (!sourceToken || sourceToken.documentName !== "Token") throw new Error("Source Token was not found.");
    if (sourceToken.parent?.id !== scene.id) throw new Error("Source Token is not on the requested Scene.");
    const sourceActor = sourceToken.actor;
    if (!sourceActor) throw new Error("Source Token has no Actor.");
    assertSourcePermission(sourceActor, requester);
    const operationId = request.operationId ?? null;
    if (operationId) {
      let existing;
      // Operation IDs belong to a creator across the world, including retries that change the Scene.
      for (const candidateScene of game.scenes.values?.() ?? game.scenes.contents ?? [scene]) {
        existing = [...(candidateScene.regions?.values?.() ?? candidateScene.regions ?? [])].find((candidate) => {
          const state = candidate.getFlag?.(FLAG_SCOPE, FLAG_KEY)?.state;
          return state?.creationOperationId === operationId && state.createdBy?.userId === requester.id;
        });
        if (existing) break;
      }
      if (existing) {
        const state = existing.getFlag(FLAG_SCOPE, FLAG_KEY).state;
        if (typeof state.creationFingerprint !== "string" || !state.creationFingerprint.trim()) {
          throw new Error("This older zone cannot verify the retry details. Review Manage Existing Zones before creating another.");
        }
        if (state.creationFingerprint !== creationFingerprint || existing.parent?.id !== scene.id) {
          throw new Error("Creation operation ID was reused with different zone details.");
        }
        return succeed({
          action: "create", sceneId: scene.id, regionId: existing.id, regionUuid: existing.uuid,
          warnings: [],
          duration: state.duration?.formula
            ? { formula: state.duration.formula, rounds: state.duration.rounds }
            : null
        });
      }
    }
    const savedPresetId = String(request.savedPresetId ?? "").trim() || null;
    if (savedPresetId) {
      if (!await presetRepository.hasPreset(savedPresetId)) throw new Error("The saved zone this configuration came from no longer exists.");
    }
    const { region, durationResolution, warnings } = await createZoneDocument({
      rawConfig: request.config, scene, sourceActor, sourceToken, requester, savedPresetId,
      savedPresetRevision: request.savedPresetRevision ?? null,
      chosenDamageType: request.chosenDamageType ?? null, color: request.color, operationId, creationFingerprint,
      placeArea: async (regionData, config) => {
        const center = request.areaCenter;
        if (!center || !Number.isFinite(Number(center.x)) || !Number.isFinite(Number(center.y))) {
          throw new Error("Area center is missing or invalid.");
        }
        const distancePixels = Number(scene.dimensions?.distancePixels ?? (scene.grid?.size / scene.grid?.distance));
        if (!Number.isFinite(distancePixels) || distancePixels <= 0) throw new Error("Scene distance scale is unavailable.");
        const [created] = await scene.createEmbeddedDocuments("Region", [{
          ...regionData, shapes: [fixedAreaShape(config, center, distancePixels)]
        }]);
        return created ?? null;
      }
    });
    if (!region) throw new Error("Foundry did not create the Region.");
    return succeed({
      action: "create", sceneId: scene.id, regionId: region.id, regionUuid: region.uuid,
      warnings,
      duration: durationResolution?.formula
        ? { formula: durationResolution.formula, rounds: durationResolution.rounds }
        : null
    });
  }

  /** Routes manual dismissal through the runtime so linked effects and state are cleaned up consistently. */
  async function endZone() {
    const requester = getWorkerRequester(request);
    const scene = game.scenes.get(request.sceneId ?? "");
    const region = scene?.regions.get(request.regionId ?? "");
    if (!scene || !region) throw new Error("The requested PF2e Zone no longer exists.");

    const payload = region.getFlag(FLAG_SCOPE, FLAG_KEY);
    if (!payload) throw new Error("The requested Region is not a PF2e Zone.");

    if (!requester.isGM) {
      const sourceActor = payload.state?.sourceActorUuid ? await fromUuid(payload.state.sourceActorUuid) : null;
      if (!sourceActor?.testUserPermission?.(requester, "OWNER")) {
        throw new Error("You do not own the source Actor for this zone.");
      }
    }

    const runtime = await zoneRuntimeEntrypoint();
    await runtime.endZone(region, `worker request from ${requester.name}`);
    return succeed({ action: "end", sceneId: scene.id, regionId: request.regionId });
  }

  /** Moves an authorized fixed area through a normal Region update so Entry sweep handling still runs. */
  async function moveZone() {
    const requester = getWorkerRequester(request);
    const scene = game.scenes.get(request.sceneId ?? "");
    const region = scene?.regions.get(request.regionId ?? "");
    if (!scene || !region) throw new Error("The requested PF2e Zone no longer exists.");

    const payload = region.getFlag(FLAG_SCOPE, FLAG_KEY);
    if (!payload) throw new Error("The requested Region is not a PF2e Zone.");
    if (payload.config?.mode !== "area") throw new Error("Only fixed-area zones can be moved this way.");
    if (payload.state?.endRequested) throw new Error("This zone is waiting for cleanup and cannot be moved.");

    if (!requester.isGM) {
      const sourceActor = payload.state?.sourceActorUuid ? await fromUuid(payload.state.sourceActorUuid) : null;
      if (!sourceActor?.testUserPermission?.(requester, "OWNER")) {
        throw new Error("You do not own the source Actor for this zone.");
      }
    }

    const center = request.areaCenter;
    if (!center || !Number.isFinite(Number(center.x)) || !Number.isFinite(Number(center.y))) {
      throw new Error("Area center is missing or invalid.");
    }
    if (typeof region.update !== "function") throw new Error("The requested Region cannot be updated.");

    const shapes = [...(region.shapes ?? [])].map((shape) => shape.toObject?.() ?? clone(shape));
    await region.update({ shapes: moveAreaShapesToCenter(shapes, center) });
    return succeed({
      action: "move", sceneId: scene.id, regionId: region.id,
      areaCenter: { x: Number(center.x), y: Number(center.y) }
    });
  }

  /** Allows only a GM to remove one exact outstanding request through the active runtime. */
  async function cancelPendingSave() {
    const requester = getWorkerRequester(request);
    if (!requester.isGM) throw new Error("Only a GM can cancel a PF2e Zone save request.");
    const scene = game.scenes.get(request.sceneId ?? "");
    const region = scene?.regions.get(request.regionId ?? "");
    if (!scene || !region?.getFlag(FLAG_SCOPE, FLAG_KEY)) {
      throw new Error("The requested PF2e Zone no longer exists.");
    }
    const runtime = await zoneRuntimeEntrypoint();
    const pendingId = String(request.pendingId ?? "");
    const identifier = String(request.identifier ?? "");
    if (!pendingId || !identifier) throw new Error("A pending save ID and identifier are required.");
    const result = await runtime.cancelPendingSave(region, pendingId, identifier);
    if (!result) throw new Error("The PF2e Zone changed before its save request could be cancelled.");
    return succeed({
      action: "cancel-pending-save", sceneId: scene.id, regionId: region.id,
      pendingId, status: result.status
    });
  }

  try {
    const policy = getWorkerActionPolicy(request.action);
    if (!policy) return fail(`Unsupported worker action '${request.action}'.`);
    const handlers = {
      /** Keeps Session Notes writes on the elected GM with GM-only requester authorization. */
      async sessionNotes() { return succeed(await executeSessionNotes(request)); },
      /** Freezes creation details before joining retries or awaiting document lookup. */
      createZone() {
        request = clone(request);
        return oncePerCreationRequest(request, createZone);
      },
      moveZone,
      endZone,
      cancelPendingSave,
      /** Preserves Hero Point authorization, Actor queues, and retry plans. */
      async setHeroPoints() { return succeed(await executeHeroPointChange(request)); },
      /** Preserves the reminder worker's recipient isolation, reservations, and persistence. */
      async createHeroPointReminder() { return succeed(await executeCreateHeroPointReminder(request)); },
      /** Clears only the authenticated requester's reminders in the worker's recipient queue. */
      async clearHeroPointReminders() { return succeed(await executeClearHeroPointReminders(request)); },
      /** Checks source ownership before reserving or reusing a Shielding Taunt request. */
      async shieldingTaunt() {
        const requester = getWorkerRequester(request);
        const sourceToken = await fromUuid(request.sourceTokenUuid ?? "");
        if (sourceToken?.documentName !== "Token" || !sourceToken.actor) {
          throw new Error("The Guardian token was not found.");
        }
        assertSourcePermission(sourceToken.actor, requester);
        return oncePerShieldingTauntRequest(request, async () => succeed(await executeShieldingTaunt(request)));
      },
      /** Wraps the repository's ordered reads in the public worker response. */
      async listPresets() { return succeed(await presetRepository.list(request)); },
      /** Wraps the repository's reserved, authenticated save in the public worker response. */
      async savePreset() { return succeed(await presetRepository.save(request)); },
      /** Wraps the repository's permission and revision checks in the public worker response. */
      async deletePreset() { return succeed(await presetRepository.delete(request)); },
      /** Confirms that the module worker is reachable without changing world documents. */
      ping() { return succeed({ action: "ping" }); }
    };
    return await handlers[policy.handler]();
  } catch (error) {
    console.error("PF2e Zone GM Worker failed", { request, error });
    return fail(error?.message ?? error, {
      ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
      ...(error?.retryable === true ? { retryable: true } : {})
    });
  }
}
