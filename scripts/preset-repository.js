import { requireValidConfig } from "./zone-creation.js";
import { validateEffectItems } from "./effect-items.js";
import { cloneData as clone, escapeHtml as escHtml, randomId } from "./utils.js";
import { oncePerOperation } from "./request-cache.js";
import { presetSaveFingerprint } from "./preset-save.js";
import { getWorkerRequester, assertSourcePermission } from "./worker-permissions.js";

const FLAG_SCOPE = "world";
const LIBRARY_FLAG_KEY = "pf2eZoneLibrary";
const LIBRARY_INDEX_FLAG_KEY = "pf2eZoneLibraryIndex";
const LIBRARY_FOLDER_FLAG_KEY = "pf2eZoneLibraryFolder";
const LIBRARY_FOLDER_NAME = "PF2e Zone Automation";
const LIBRARY_JOURNAL_NAME = "PF2e Zone Library";
const LIBRARY_PAGE_NAME = "Shared Zone Presets";
const LIBRARY_SCHEMA_VERSION = 1;
const PRESET_SAVE_REQUEST_TTL_MS = 10 * 60 * 1000;

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
async function listLibrary(request) {
  getWorkerRequester(request);
  const { journal, data } = await ensureLibraryJournal();
  return {
    action: "library-list",
    journalId: journal.id,
    journalUuid: journal.uuid,
    records: libraryRecords(data).map(libraryRecordForClient)
  };
}

/** Applies ownership and revision checks so one user cannot silently overwrite another user's work. */
async function saveLibraryPreset(request, operation = null) {
  const requester = getWorkerRequester(request);
  const savedJournal = operation ? findLibraryJournal() : null;
  if (savedJournal) {
    const completed = completedPresetSave(normalizeLibrary(savedJournal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY)), operation);
    if (completed) return { action: "library-save", journalId: savedJournal.id, record: completed, warnings: [] };
  }
  const sourceActor = await fromUuid(request.sourceActorUuid ?? "");
  if (!sourceActor?.uuid) throw new Error("Source Actor was not found.");
  assertSourcePermission(sourceActor, requester);
  const cfg = requireValidConfig(request.config, sourceActor);
  const effectValidation = await validateEffectItems(cfg);
  if (effectValidation.errors.length) throw new Error(effectValidation.errors[0]);
  const { journal, data, page } = await ensureLibraryJournal();
  const completed = completedPresetSave(data, operation);
  if (completed) return { action: "library-save", journalId: journal.id, record: completed, warnings: [] };
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
  return {
    action: "library-save",
    journalId: journal.id,
    record: libraryRecordForClient(record),
    warnings: warning ? [warning] : []
  };
}

/** Applies the same ownership rules to deletion that the module uses for saving. */
async function deleteLibraryPreset(request) {
  const requester = getWorkerRequester(request);
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
  return { action: "library-delete", journalId: journal.id, recordId, warnings: warning ? [warning] : [] };
}

/** Checks preset origin through the same discovery and repair path used by library operations. */
async function hasLibraryPreset(recordId) {
  const { data } = await ensureLibraryJournal();
  return Boolean(data.zones[recordId]);
}

/** Gives each GM worker its own ordered library queue and retry cache, independent of other clients. */
export function createPresetRepository() {
  let libraryOperationTail = Promise.resolve();
  const presetSaveRequests = new Map();

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

  return Object.freeze({
    /** Reads the current library after earlier mutations finish and authenticates the requester. */
    list(request) {
      return serializeLibraryOperation(() => listLibrary(request));
    },
    /** Freezes and authenticates a save before reserving its retry identity or waiting in the queue. */
    save(request) {
      const snapshot = clone(request);
      getWorkerRequester(snapshot);
      return oncePerPresetSaveRequest(snapshot, operation => saveLibraryPreset(snapshot, operation));
    },
    /** Deletes against the latest revision after preceding library operations finish. */
    delete(request) {
      return serializeLibraryOperation(() => deleteLibraryPreset(request));
    },
    hasPreset: hasLibraryPreset
  });
}
