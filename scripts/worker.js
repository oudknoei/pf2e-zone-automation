import { zoneRuntimeEntrypoint } from "./runtime.js";
import { executeShieldingTaunt } from "./shielding-taunt-worker.js";
import { fixedAreaShape } from "./area-shape.js";
import { createZoneDocument, requireValidConfig } from "./zone-creation.js";
import { validateEffectItems } from "./effect-items.js";
/* GM-only document operations and authorization for module socket requests. */

let libraryOperationTail = Promise.resolve();

/** Keeps one GM client's library reads and writes in order so each mutation starts from the latest flag. */
function serializeLibraryOperation(operation) {
  const result = libraryOperationTail.then(operation, operation);
  libraryOperationTail = result.then(() => undefined, () => undefined);
  return result;
}

/** Keeps privileged world changes behind one GM-only entry point so player requests remain constrained. */
export async function handleWorkerRequest(request) {
  "use strict";

  const WORKER_VERSION = "0.5.16";
  const FLAG_SCOPE = "world";
  const FLAG_KEY = "pf2eZone";
  const LIBRARY_FLAG_KEY = "pf2eZoneLibrary";
  const LIBRARY_INDEX_FLAG_KEY = "pf2eZoneLibraryIndex";
  const LIBRARY_FOLDER_FLAG_KEY = "pf2eZoneLibraryFolder";
  const LIBRARY_FOLDER_NAME = "PF2e Zone Automation";
  const LIBRARY_JOURNAL_NAME = "PF2e Zone Library";
  const LIBRARY_PAGE_NAME = "Shared Zone Presets";
  const LIBRARY_SCHEMA_VERSION = 1;
  const fu = foundry.utils;

  /** Prevents the worker from mutating caller-owned request data while it validates and enriches it. */
  const clone = (obj) => {
    if (globalThis.structuredClone) return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  };

  /** Returns worker errors in one predictable shape so clients can present them safely. */
  const fail = (message) => ({ ok: false, workerVersion: WORKER_VERSION, error: String(message) });
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

  /** Keeps saved preset names from changing the Library Journal page markup. */
  const escHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  /** Lets older or incomplete Journal flags recover to a usable shared preset library. */
  function normalizeLibrary(raw) {
    const data = raw && typeof raw === "object" ? clone(raw) : {};
    const zones = data.zones && typeof data.zones === "object" && !Array.isArray(data.zones)
      ? data.zones
      : {};
    return {
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      zones
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
              zones: {}
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
  async function persistLibrary(journal, data, page = null) {
    const clean = normalizeLibrary(data);
    if (typeof globalThis._replace !== "function") throw new Error("Foundry v14's flag replacement operator is unavailable.");
    await journal.update({ [`flags.${FLAG_SCOPE}.${LIBRARY_FLAG_KEY}`]: globalThis._replace(clean) });

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
    return clean;
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
  async function saveLibraryPreset() {
    const requester = getRequester();
    const sourceActor = await fromUuid(request.sourceActorUuid ?? "");
    if (!sourceActor?.uuid) throw new Error("Source Actor was not found.");
    assertSourcePermission(sourceActor, requester);
    const cfg = requireValidConfig(request.config, sourceActor);
    const effectValidation = await validateEffectItems(cfg);
    if (effectValidation.errors.length) throw new Error(effectValidation.errors[0]);
    const { journal, data, page } = await ensureLibraryJournal();
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
      const id = fu.randomID?.(12) ?? crypto.randomUUID().slice(0, 12);
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
    await persistLibrary(journal, data, page);
    return succeed({
      action: "library-save",
      journalId: journal.id,
      record: libraryRecordForClient(record)
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
    await persistLibrary(journal, data, page);
    return succeed({ action: "library-delete", journalId: journal.id, recordId });
  }

  /** Enforces source ownership before the shared creation path changes the Scene. */
  async function createZone() {
    const requester = getRequester();
    const scene = game.scenes.get(request.sceneId ?? "");
    if (!scene) throw new Error("Target Scene was not found.");
    const sourceToken = await fromUuid(request.sourceTokenUuid ?? "");
    if (!sourceToken || sourceToken.documentName !== "Token") throw new Error("Source Token was not found.");
    if (sourceToken.parent?.id !== scene.id) throw new Error("Source Token is not on the requested Scene.");
    const sourceActor = sourceToken.actor;
    if (!sourceActor) throw new Error("Source Token has no Actor.");
    assertSourcePermission(sourceActor, requester);
    const savedPresetId = String(request.savedPresetId ?? "").trim() || null;
    if (savedPresetId) {
      const { data } = await ensureLibraryJournal();
      if (!data.zones[savedPresetId]) throw new Error("The saved zone this configuration came from no longer exists.");
    }
    const { region, durationResolution } = await createZoneDocument({
      rawConfig: request.config, scene, sourceActor, sourceToken, requester, savedPresetId,
      savedPresetRevision: request.savedPresetRevision ?? null,
      chosenDamageType: request.chosenDamageType ?? null, color: request.color,
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

  try {
    switch (request.action) {
      case "create": return await createZone();
      case "end": return await endZone();
      case "shielding-taunt": {
        const requester = getRequester();
        const sourceToken = await fromUuid(request.sourceTokenUuid ?? "");
        if (sourceToken?.documentName !== "Token" || !sourceToken.actor) {
          throw new Error("The Guardian token was not found.");
        }
        assertSourcePermission(sourceToken.actor, requester);
        return succeed(await executeShieldingTaunt(request));
      }
      case "library-list": return await serializeLibraryOperation(listLibrary);
      case "library-save": return await serializeLibraryOperation(saveLibraryPreset);
      case "library-delete": return await serializeLibraryOperation(deleteLibraryPreset);
      case "ping": return succeed({ action: "ping" });
      default: return fail(`Unsupported worker action '${request.action}'.`);
    }
  } catch (error) {
    console.error("PF2e Zone GM Worker failed", { request, error });
    return fail(error?.message ?? error);
  }
}
