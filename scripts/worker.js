import { zoneRuntimeEntrypoint } from "./runtime.js";
import { executeShieldingTaunt } from "./shielding-taunt-worker.js";
import { executeAskQuestion } from "./recall-knowledge-worker.js";
import { executeHeroPointChange } from "./hero-points-worker.js";
import { executeCreateHeroPointReminder } from "./hero-point-reminder-worker.js";
import { fixedAreaShape, moveAreaShapesToCenter } from "./area-shape.js";
import { createZoneDocument, creationRequestFingerprint, requireValidConfig } from "./zone-creation.js";
import { validateEffectItems } from "./effect-items.js";
import { cloneData as clone, escapeHtml as escHtml, randomId } from "./utils.js";
import { oncePerOperation } from "./request-cache.js";
import { presetSaveFingerprint } from "./preset-save.js";
/* GM-only document operations and authorization for module socket requests. */

let libraryOperationTail = Promise.resolve();
const creationRequests = new Map();
const CREATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const shieldingTauntRequests = new Map();
const SHIELDING_TAUNT_REQUEST_TTL_MS = 10 * 60 * 1000;
const presetSaveRequests = new Map();
const PRESET_SAVE_REQUEST_TTL_MS = 10 * 60 * 1000;

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

/** Keeps one GM client's library reads and writes in order so each mutation starts from the latest flag. */
function serializeLibraryOperation(operation) {
  const result = libraryOperationTail.then(operation, operation);
  libraryOperationTail = result.then(() => undefined, () => undefined);
  return result;
}

/** Reserves an identified preset save before waiting and joins its identical retries. */
function oncePerPresetSaveRequest(request, save) {
  if (request.operationId == null) return serializeLibraryOperation(() => save());
  if (typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(request.operationId)) {
    throw new Error("Preset save operation ID is invalid.");
  }
  const fingerprint = presetSaveFingerprint(request);
  const operation = {
    key: `${request.requesterUserId}:${request.operationId}`,
    operationId: request.operationId, requesterUserId: request.requesterUserId, fingerprint
  };
  return oncePerOperation(presetSaveRequests, {
    key: operation.key, fingerprint, ttlMs: PRESET_SAVE_REQUEST_TTL_MS,
    reuseError: "Preset save operation ID was reused with different save details."
  }, () => serializeLibraryOperation(() => save(operation)));
}

/** Keeps privileged world changes behind one GM-only entry point so player requests remain constrained. */
export async function handleWorkerRequest(request) {
  "use strict";

  const WORKER_VERSION = "0.5.17";
  const FLAG_SCOPE = "world";
  const FLAG_KEY = "pf2eZone";
  const LIBRARY_FLAG_KEY = "pf2eZoneLibrary";
  const LIBRARY_INDEX_FLAG_KEY = "pf2eZoneLibraryIndex";
  const LIBRARY_FOLDER_FLAG_KEY = "pf2eZoneLibraryFolder";
  const LIBRARY_FOLDER_NAME = "PF2e Zone Automation";
  const LIBRARY_JOURNAL_NAME = "PF2e Zone Library";
  const LIBRARY_PAGE_NAME = "Shared Zone Presets";
  const LIBRARY_SCHEMA_VERSION = 1;
  /** Returns worker errors in one predictable shape so clients can present them safely. */
  const fail = (message, details = {}) => ({
    ok: false, workerVersion: WORKER_VERSION, error: String(message), ...details
  });
  /** Returns worker results in one predictable shape so the socket bridge can resolve requests consistently. */
  const succeed = (data = {}) => ({ ok: true, workerVersion: WORKER_VERSION, ...data });

  if (game.system.id !== "pf2e") return fail("PF2e Zone GM Worker requires the Pathfinder Second Edition system.");
  if (!game.user.isGM) return fail("PF2e Zone GM Worker must execute on an active GM client.");
  if (!request || request.protocol !== 1) return fail("No valid PF2e Zone worker request was supplied.");

  /** Rejects stale or forged socket identities before any world data is changed. */
  function getRequester() {
    const user = game.users.get(request.requesterUserId ?? "");
    if (!user) throw new Error("The requesting user no longer exists.");
    if (!user.active) throw new Error(`Requesting user '${user.name}' is not active.`);
    return user;
  }

  /** Prevents a player from creating or changing zones through an Actor they do not own. */
  function assertSourcePermission(actor, requester) {
    if (requester.isGM) return;
    if (!actor?.testUserPermission?.(requester, "OWNER")) {
      throw new Error(`${requester.name} does not own the source Actor '${actor?.name ?? "Unknown"}'.`);
    }
  }

  /** Lets older or incomplete Journal flags recover to a usable shared preset library. */
  function normalizeLibrary(raw) {
    const data = raw && typeof raw === "object" ? clone(raw) : {};
    const zones = data.zones && typeof data.zones === "object" && !Array.isArray(data.zones)
      ? data.zones
      : {};
    return {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      zones,
      saveOperations: data.saveOperations && typeof data.saveOperations === "object" && !Array.isArray(data.saveOperations)
        ? data.saveOperations : {}
    };
  }

  /** Centralizes record filtering so every library operation ignores malformed entries. */
  function libraryRecords(data) {
    return Object.values(data.zones ?? {}).filter((record) => record && typeof record === "object");
  }

  /** Keeps the Journal index useful as a human-readable view of shared presets. */
  function libraryIndexHtml(data) {
    const rows = libraryRecords(data)
      .sort((a, b) => {
        const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
        if (byName) return byName;
        return String(a.createdBy?.name ?? "").localeCompare(String(b.createdBy?.name ?? ""), undefined, { sensitivity: "base" });
      })
      .map((record) => `<li>${escHtml(record.name ?? "Unnamed Zone")} (${escHtml(record.createdBy?.name ?? "Unknown")})</li>`)
      .join("");
    return `<h2>PF2e Zone Library</h2>${rows ? `<ul>${rows}</ul>` : "<p><em>No saved zones.</em></p>"}`;
  }

  /** Reuses the module-owned Journal so repeated requests never create competing libraries. */
  function findLibraryJournal() {
    return game.journal.find((journal) => Boolean(journal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY))) ?? null;
  }

  /** Reuses the module folder so the Library Journal stays organized after reloads. */
  function findLibraryFolder() {
    return game.folders.find((folder) => (
      folder.type === "JournalEntry"
      && (folder.getFlag(FLAG_SCOPE, LIBRARY_FOLDER_FLAG_KEY) || folder.name === LIBRARY_FOLDER_NAME)
    )) ?? null;
  }

  /** Creates the required folder only when the world does not already have one. */
  async function ensureLibraryFolder() {
    let folder = findLibraryFolder();
    if (folder) return folder;

    const FolderClass = CONFIG.Folder?.documentClass;
    if (!FolderClass?.create) throw new Error("Foundry Folder creation API is unavailable.");
    folder = await FolderClass.create({
      name: LIBRARY_FOLDER_NAME,
      type: "JournalEntry",
      sorting: "a",
      color: null,
      flags: {
        [FLAG_SCOPE]: {
          [LIBRARY_FOLDER_FLAG_KEY]: true
        }
      }
    });
    if (!folder) throw new Error("Foundry did not create the PF2e Zone Automation Journal folder.");
    return folder;
  }

  /** Establishes one authoritative Journal and keeps it in the expected folder. */
  async function ensureLibraryJournal() {
    const libraryFolder = await ensureLibraryFolder();
    let journal = findLibraryJournal();
    if (!journal) {
      const collision = game.journal.find((entry) => entry.name === LIBRARY_JOURNAL_NAME);
      if (collision) {
        throw new Error(`A Journal named '${LIBRARY_JOURNAL_NAME}' already exists but is not the PF2e Zone library. Rename it and try again.`);
      }

      const JournalClass = CONFIG.JournalEntry?.documentClass;
      if (!JournalClass?.create) throw new Error("Foundry JournalEntry creation API is unavailable.");
      const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
      journal = await JournalClass.create({
        name: LIBRARY_JOURNAL_NAME,
        folder: libraryFolder.id,
        ownership: { default: observer },
        flags: {
          [FLAG_SCOPE]: {
            [LIBRARY_FLAG_KEY]: {
              schemaVersion: LIBRARY_SCHEMA_VERSION,
              zones: {}, saveOperations: {}
            }
          }
        }
      });
      if (!journal) throw new Error("Foundry did not create the PF2e Zone Library Journal.");
    }

    const journalFolderId = journal.folder?.id ?? journal.folder ?? null;
    if (journalFolderId !== libraryFolder.id) await journal.update({ folder: libraryFolder.id });

    const data = normalizeLibrary(journal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY));
    let page = journal.pages.find((p) => p.getFlag(FLAG_SCOPE, LIBRARY_INDEX_FLAG_KEY))
      ?? journal.pages.find((p) => p.name === LIBRARY_PAGE_NAME)
      ?? null;
    if (!page) {
      const [createdPage] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
        name: LIBRARY_PAGE_NAME,
        type: "text",
        text: {
          content: libraryIndexHtml(data),
          format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1
        },
        flags: {
          [FLAG_SCOPE]: {
            [LIBRARY_INDEX_FLAG_KEY]: true
          }
        }
      }]);
      page = createdPage ?? null;
    }
    return { journal, data, page };
  }

  /** Replaces the shared flag in one document update before refreshing its readable index. */
  async function persistLibrary(journal, data, page = null, saveOperation = null) {
    let clean = normalizeLibrary(data);
    if (typeof globalThis._replace !== "function") throw new Error("Foundry v14's flag replacement operator is unavailable.");
    try {
      await journal.update({ [`flags.${FLAG_SCOPE}.${LIBRARY_FLAG_KEY}`]: globalThis._replace(clean) });
      if (saveOperation) {
        const current = normalizeLibrary(journal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY));
        if (!completedPresetSave(current, saveOperation)) throw new Error("Preset completion was not persisted.");
        clean = current;
      }
    } catch (error) {
      if (!saveOperation) throw error;
      const current = normalizeLibrary(journal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY));
      if (!completedPresetSave(current, saveOperation)) {
        const uncertain = new Error("The preset save could not be confirmed. Retry the same save before starting another.", { cause: error });
        uncertain.code = "PF2E_ZONE_PRESET_SAVE_UNCERTAIN";
        uncertain.retryable = true;
        throw uncertain;
      }
      clean = current;
    }

    let indexWarning = null;
    try {
      const indexPage = page
        ?? journal.pages.find((p) => p.getFlag(FLAG_SCOPE, LIBRARY_INDEX_FLAG_KEY))
        ?? journal.pages.find((p) => p.name === LIBRARY_PAGE_NAME)
        ?? null;
      const html = libraryIndexHtml(clean);
      if (indexPage) {
        await indexPage.update({
          "text.content": html,
          "text.format": CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1,
          [`flags.${FLAG_SCOPE}.${LIBRARY_INDEX_FLAG_KEY}`]: true
        });
      } else {
        await journal.createEmbeddedDocuments("JournalEntryPage", [{
          name: LIBRARY_PAGE_NAME,
          type: "text",
          text: {
            content: html,
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1
          },
          flags: {
            [FLAG_SCOPE]: {
              [LIBRARY_INDEX_FLAG_KEY]: true
            }
          }
        }]);
      }
    } catch (error) {
      console.warn("PF2e Zone: library flag was saved but its Journal index update failed", error);
      indexWarning = "The library change was saved, but its Journal index page could not be refreshed. The next library change will retry the index.";
    }
    return { data: clean, warning: indexWarning };
  }

  /** Limits shared data to the fields a client needs instead of exposing Journal internals. */
  function libraryRecordForClient(record) {
    return {
      id: record.id,
      name: record.name,
      createdBy: clone(record.createdBy ?? null),
      createdAt: record.createdAt ?? null,
      modifiedBy: clone(record.modifiedBy ?? null),
      modifiedAt: record.modifiedAt ?? null,
      revision: Number(record.revision ?? 1),
      config: clone(record.config ?? {})
    };
  }

  /** Returns the original saved snapshot without resurrecting a deleted record or reverting a later revision. */
  function completedPresetSave(data, operation) {
    if (!operation || !Object.hasOwn(data.saveOperations, operation.key)) return null;
    const receipt = data.saveOperations[operation.key];
    if (!receipt || receipt.operationId !== operation.operationId || receipt.requesterUserId !== operation.requesterUserId
      || typeof receipt.fingerprint !== "string" || !receipt.fingerprint
      || typeof receipt.record?.id !== "string" || !receipt.record.id
      || typeof receipt.record.name !== "string" || !Number.isSafeInteger(receipt.record.revision) || receipt.record.revision < 1
      || !receipt.record.config || typeof receipt.record.config !== "object" || Array.isArray(receipt.record.config)) {
      throw new Error("The earlier preset save cannot be verified. Review the saved zones before starting another save.");
    }
    if (receipt.fingerprint !== operation.fingerprint) {
      throw new Error("Preset save operation ID was reused with different save details.");
    }
    return clone(receipt.record);
  }

  /** Lets clients read presets through the GM without granting Journal write access. */
  async function listLibrary() {
    getRequester();
    const { journal, data } = await ensureLibraryJournal();
    return succeed({
      action: "library-list",
      journalId: journal.id,
      journalUuid: journal.uuid,
      records: libraryRecords(data).map(libraryRecordForClient)
    });
  }

  /** Applies ownership and revision checks so one user cannot silently overwrite another user's work. */
  async function saveLibraryPreset(operation = null) {
    const requester = getRequester();
    const savedJournal = operation ? findLibraryJournal() : null;
    if (savedJournal) {
      const completed = completedPresetSave(normalizeLibrary(savedJournal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY)), operation);
      if (completed) return succeed({ action: "library-save", journalId: savedJournal.id, record: completed, warnings: [] });
    }
    const sourceActor = await fromUuid(request.sourceActorUuid ?? "");
    if (!sourceActor?.uuid) throw new Error("Source Actor was not found.");
    assertSourcePermission(sourceActor, requester);
    const cfg = requireValidConfig(request.config, sourceActor);
    const effectValidation = await validateEffectItems(cfg);
    if (effectValidation.errors.length) throw new Error(effectValidation.errors[0]);
    const { journal, data, page } = await ensureLibraryJournal();
    const completed = completedPresetSave(data, operation);
    if (completed) return succeed({ action: "library-save", journalId: journal.id, record: completed, warnings: [] });
    const requestedId = String(request.recordId ?? "").trim();
    const now = Date.now();

    let record;
    if (requestedId) {
      const existing = data.zones[requestedId];
      if (!existing) throw new Error("That saved zone no longer exists.");
      if (!requester.isGM && existing.createdBy?.userId !== requester.id) {
        throw new Error(`Only ${existing.createdBy?.name ?? "the creator"} or a GM can overwrite this saved zone.`);
      }
      const currentRevision = Math.max(1, Number(existing.revision ?? 1));
      if (request.expectedRevision !== currentRevision) {
        throw new Error("This saved zone changed since you opened it. Reopen it and reapply your edits, or use Save As.");
      }
      record = {
        ...clone(existing),
        id: existing.id ?? requestedId,
        name: cfg.name,
        createdBy: clone(existing.createdBy),
        createdAt: existing.createdAt ?? now,
        modifiedBy: { userId: requester.id, name: requester.name },
        modifiedAt: now,
        revision: currentRevision + 1,
        config: cfg
      };
    } else {
      const id = operation ? `save-${requester.id}-${operation.operationId}` : randomId();
      if (Object.hasOwn(data.zones, id)) {
        throw new Error("The earlier preset save cannot be verified. Review the saved zones before starting another save.");
      }
      record = {
        id,
        name: cfg.name,
        createdBy: { userId: requester.id, name: requester.name },
        createdAt: now,
        modifiedBy: { userId: requester.id, name: requester.name },
        modifiedAt: now,
        revision: 1,
        config: cfg
      };
    }

    data.zones[record.id] = record;
    if (operation) {
      data.saveOperations[operation.key] = {
        operationId: operation.operationId, requesterUserId: requester.id, fingerprint: operation.fingerprint,
        completedAt: now, record: libraryRecordForClient(record)
      };
    }
    const { warning } = await persistLibrary(journal, data, page, operation);
    return succeed({
      action: "library-save",
      journalId: journal.id,
      record: libraryRecordForClient(record),
      warnings: warning ? [warning] : []
    });
  }

  /** Applies the same ownership rules to deletion that the module uses for saving. */
  async function deleteLibraryPreset() {
    const requester = getRequester();
    const { journal, data, page } = await ensureLibraryJournal();
    const recordId = String(request.recordId ?? "").trim();
    const existing = data.zones[recordId];
    if (!existing) throw new Error("That saved zone no longer exists.");
    if (!requester.isGM && existing.createdBy?.userId !== requester.id) {
      throw new Error(`Only ${existing.createdBy?.name ?? "the creator"} or a GM can delete this saved zone.`);
    }
    if (request.expectedRevision !== Math.max(1, Number(existing.revision ?? 1))) {
      throw new Error("This saved zone changed since you opened the list. Reopen the list before deleting it.");
    }
    delete data.zones[recordId];
    const { warning } = await persistLibrary(journal, data, page);
    return succeed({ action: "library-delete", journalId: journal.id, recordId, warnings: warning ? [warning] : [] });
  }

  /** Enforces source ownership before the shared creation path changes the Scene. */
  async function createZone(creationFingerprint = null) {
    const requester = getRequester();
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
      const { data } = await ensureLibraryJournal();
      if (!data.zones[savedPresetId]) throw new Error("The saved zone this configuration came from no longer exists.");
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
    const requester = getRequester();
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
    const requester = getRequester();
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
    const requester = getRequester();
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
    switch (request.action) {
      case "create": {
        request = clone(request);
        return await oncePerCreationRequest(request, createZone);
      }
      case "move": return await moveZone();
      case "end": return await endZone();
      case "cancel-pending-save": return await cancelPendingSave();
      case "ask-question": return succeed(await executeAskQuestion(request));
      case "set-hero-points": return succeed(await executeHeroPointChange(request));
      case "create-hero-point-reminder": return succeed(await executeCreateHeroPointReminder(request));
      case "shielding-taunt": {
        const requester = getRequester();
        const sourceToken = await fromUuid(request.sourceTokenUuid ?? "");
        if (sourceToken?.documentName !== "Token" || !sourceToken.actor) {
          throw new Error("The Guardian token was not found.");
        }
        assertSourcePermission(sourceToken.actor, requester);
        return await oncePerShieldingTauntRequest(
          request,
          async () => succeed(await executeShieldingTaunt(request))
        );
      }
      case "library-list": return await serializeLibraryOperation(listLibrary);
      case "library-save": {
        request = clone(request);
        getRequester();
        return await oncePerPresetSaveRequest(request, saveLibraryPreset);
      }
      case "library-delete": return await serializeLibraryOperation(deleteLibraryPreset);
      case "ping": return succeed({ action: "ping" });
      default: return fail(`Unsupported worker action '${request.action}'.`);
    }
  } catch (error) {
    console.error("PF2e Zone GM Worker failed", { request, error });
    return fail(error?.message ?? error, {
      ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
      ...(error?.retryable === true ? { retryable: true } : {})
    });
  }
}
