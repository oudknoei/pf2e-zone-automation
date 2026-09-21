import { resolveDurationRounds } from "./duration.js";
import { postFormulaDurationMessage } from "./duration-chat.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { executeShieldingTaunt } from "./shielding-taunt-worker.js";
/* GM-only actions adapted from PF2e Zone GM Worker v0.5.13. */

export async function handleWorkerRequest(request) {
  "use strict";

  const WORKER_VERSION = "0.5.15";
  const RUNTIME_VERSION = "0.5.15";
  const ZONE_COLOR_LIGHTEN = 0.1;
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

  const clone = (obj) => {
    if (globalThis.structuredClone) return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  };

  function lightenZoneColor(value, amount = ZONE_COLOR_LIGHTEN) {
    const raw = String(value ?? "#999999").trim();
    const short = raw.match(/^#?([0-9a-f]{3})$/i);
    const full = raw.match(/^#?([0-9a-f]{6})$/i);
    const hex = full?.[1] ?? (short ? short[1].split("").map((c) => `${c}${c}`).join("") : null);
    if (!hex) return raw || "#999999";

    const t = Math.clamp(Number(amount) || 0, 0, 1);
    const channels = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * t));
    return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }

  const fail = (message) => ({ ok: false, workerVersion: WORKER_VERSION, error: String(message) });
  const succeed = (data = {}) => ({ ok: true, workerVersion: WORKER_VERSION, ...data });

  if (game.system.id !== "pf2e") return fail("PF2e Zone GM Worker requires the Pathfinder Second Edition system.");
  if (!game.user.isGM) return fail("PF2e Zone GM Worker must execute on an active GM client.");
  if (!request || request.protocol !== 1) return fail("No valid PF2e Zone worker request was supplied.");

  function getRequester() {
    const user = game.users.get(request.requesterUserId ?? "");
    if (!user) throw new Error("The requesting user no longer exists.");
    if (!user.active) throw new Error(`Requesting user '${user.name}' is not active.`);
    return user;
  }

  function assertSourcePermission(actor, requester) {
    if (requester.isGM) return;
    if (!actor?.testUserPermission?.(requester, "OWNER")) {
      throw new Error(`${requester.name} does not own the source Actor '${actor?.name ?? "Unknown"}'.`);
    }
  }

  function normalizeConfig(raw) {
    const cfg = clone(raw ?? {});
    if (!cfg || typeof cfg !== "object") throw new Error("Zone configuration is missing.");
    if (!String(cfg.name ?? "").trim()) throw new Error("Zone name is required.");
    if (!['emanation', 'area'].includes(cfg.mode)) throw new Error(`Unsupported zone mode '${cfg.mode}'.`);
    cfg.visibility = ["all", "gm"].includes(cfg.visibility) ? cfg.visibility : "all";
    cfg.radius = Number(cfg.radius);
    if (!Number.isFinite(cfg.radius) || cfg.radius <= 0 || cfg.radius > 1000) throw new Error("Zone radius is invalid.");
    if (!Array.isArray(cfg.effects)) throw new Error("Zone effect blocks are missing.");
    return cfg;
  }


  const escHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

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

  function libraryRecords(data) {
    return Object.values(data.zones ?? {}).filter((record) => record && typeof record === "object");
  }

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

  function findLibraryJournal() {
    return game.journal.find((journal) => Boolean(journal.getFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY))) ?? null;
  }

  function findLibraryFolder() {
    return game.folders.find((folder) => (
      folder.type === "JournalEntry"
      && (folder.getFlag(FLAG_SCOPE, LIBRARY_FOLDER_FLAG_KEY) || folder.name === LIBRARY_FOLDER_NAME)
    )) ?? null;
  }

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

  async function persistLibrary(journal, data, page = null) {
    const clean = normalizeLibrary(data);
    await journal.unsetFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY);
    await journal.setFlag(FLAG_SCOPE, LIBRARY_FLAG_KEY, clean);

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

  async function saveLibraryPreset() {
    const requester = getRequester();
    const { journal, data, page } = await ensureLibraryJournal();
    const cfg = normalizeConfig(request.config);
    const requestedId = String(request.recordId ?? "").trim();
    const now = Date.now();

    let record;
    if (requestedId) {
      const existing = data.zones[requestedId];
      if (!existing) throw new Error("That saved zone no longer exists.");
      if (!requester.isGM && existing.createdBy?.userId !== requester.id) {
        throw new Error(`Only ${existing.createdBy?.name ?? "the creator"} or a GM can overwrite this saved zone.`);
      }
      record = {
        ...clone(existing),
        id: existing.id ?? requestedId,
        name: cfg.name,
        createdBy: clone(existing.createdBy),
        createdAt: existing.createdAt ?? now,
        modifiedBy: { userId: requester.id, name: requester.name },
        modifiedAt: now,
        revision: Math.max(1, Number(existing.revision ?? 1)) + 1,
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

  async function deleteLibraryPreset() {
    const requester = getRequester();
    const { journal, data, page } = await ensureLibraryJournal();
    const recordId = String(request.recordId ?? "").trim();
    const existing = data.zones[recordId];
    if (!existing) throw new Error("That saved zone no longer exists.");
    if (!requester.isGM && existing.createdBy?.userId !== requester.id) {
      throw new Error(`Only ${existing.createdBy?.name ?? "the creator"} or a GM can delete this saved zone.`);
    }
    delete data.zones[recordId];
    await persistLibrary(journal, data, page);
    return succeed({ action: "library-delete", journalId: journal.id, recordId });
  }

  function executeScriptBehaviorType() {
    const match = Object.entries(CONFIG.RegionBehavior?.dataModels ?? {})
      .find(([, cls]) => cls?.name === "ExecuteScriptRegionBehaviorType");
    return match?.[0] ?? "executeScript";
  }

  function runtimeScriptSource() {
    return `
const api = game.modules.get("pf2e-zone-automation")?.api;
if (!api?.handleRegionEvent) throw new Error("PF2e Zone Automation module is not active.");
await api.handleRegionEvent({ behavior, event, region, scene: typeof scene !== "undefined" ? scene : region?.parent });
`;
  }

  function regionBehaviorData() {
    return {
      name: "PF2e Zone Runtime",
      type: executeScriptBehaviorType(),
      system: {
        events: [
          "behaviorActivated",
          "behaviorDeactivated",
          "behaviorViewed",
          "tokenEnter",
          "tokenExit",
          "tokenTurnStart",
          "tokenTurnEnd"
        ],
        source: runtimeScriptSource()
      },
      disabled: false,
      flags: {}
    };
  }

  function finiteDurationRounds(cfg) {
    switch (cfg.duration?.type) {
      case "1-round": return 1;
      case "custom-rounds": {
        const rounds = Number(cfg.duration?.rounds);
        return Number.isSafeInteger(rounds) && rounds > 0 ? rounds : null;
      }
      case "1-minute": return 10;
      case "10-minutes": return 100;
      default: return null;
    }
  }

  function initialRuntimeState(cfg, chosenDamageType, sourceActor, sourceToken, createdBy, durationResolution = null) {
    const combat = game.combat;
    const sourceCombatant = sourceActor.combatant ?? null;
    const rounds = durationResolution?.rounds ?? finiteDurationRounds(cfg);
    const currentIsSource = Boolean(combat && sourceCombatant && combat.combatant?.id === sourceCombatant.id);
    const currentTurnKey = currentIsSource
      ? `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${sourceCombatant.id}`
      : null;

    return {
      createdWorldTime: Number(game.time?.worldTime ?? 0),
      createdBy: createdBy ? { userId: createdBy.id, name: createdBy.name } : { userId: game.user.id, name: game.user.name },
      sourceActorUuid: sourceActor.uuid,
      sourceTokenUuid: sourceToken.uuid,
      activation: { damageType: chosenDamageType ?? null },
      activationProcessed: false,
      activationPending: true,
      activationFinalizeScheduled: false,
      activationTargets: {},
      initialOccupants: {},
      deactivated: false,
      pendingSaves: {},
      resolvedSaves: {},
      repeat: {},
      immunities: {},
      applied: {},
      damageRolls: {},
      healingRolls: {},
      recoveryWatchers: {},
      turnStartEvents: {},
      lastSourceTriggerTurnKey: currentTurnKey,
      duration: rounds ? {
        rounds,
        formula: durationResolution?.formula ?? null,
        worldExpires: Number(game.time?.worldTime ?? 0) + rounds * 6,
        combatId: combat?.id ?? null,
        sourceCombatantId: sourceCombatant?.id ?? null,
        sourceTurnsElapsed: 0,
        lastSourceTurnKey: currentTurnKey
      } : {}
    };
  }

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

    const cfg = normalizeConfig(request.config);
    const durationResolution = await resolveDurationRounds(cfg.duration);
    const payload = {
      runtimeVersion: RUNTIME_VERSION,
      config: cfg,
      state: initialRuntimeState(
        cfg,
        request.chosenDamageType ?? null,
        sourceActor,
        sourceToken,
        requester,
        durationResolution
      )
    };
    const regionData = {
      name: cfg.name,
      color: lightenZoneColor(request.color ?? requester.color ?? game.user.color),
      visibility: cfg.visibility === "gm"
        ? (CONST.REGION_VISIBILITY?.GAMEMASTER ?? 1)
        : (CONST.REGION_VISIBILITY?.ALWAYS ?? 2),
      behaviors: [regionBehaviorData()],
      flags: { [FLAG_SCOPE]: { [FLAG_KEY]: payload } }
    };

    let region = null;
    if (cfg.mode === "emanation") {
      const RegionDocument = CONFIG.Region.documentClass;
      if (typeof RegionDocument?.createTokenEmanation !== "function") {
        throw new Error("Foundry V14 RegionDocument.createTokenEmanation is unavailable.");
      }
      region = await RegionDocument.createTokenEmanation(sourceToken, cfg.radius, regionData);
    } else {
      const center = request.areaCenter;
      if (!center || !Number.isFinite(Number(center.x)) || !Number.isFinite(Number(center.y))) {
        throw new Error("Area center is missing or invalid.");
      }
      const distancePixels = Number(scene.dimensions?.distancePixels ?? (scene.grid?.size / scene.grid?.distance));
      if (!Number.isFinite(distancePixels) || distancePixels <= 0) throw new Error("Scene distance scale is unavailable.");
      const radiusPixels = cfg.radius * distancePixels;
      const [created] = await scene.createEmbeddedDocuments("Region", [{
        ...regionData,
        shapes: [{
          type: "circle",
          x: Number(center.x),
          y: Number(center.y),
          radius: radiusPixels,
          gridBased: true
        }]
      }]);
      region = created ?? null;
    }

    if (!region) throw new Error("Foundry did not create the Region.");
    const runtime = await zoneRuntimeEntrypoint();
    await runtime.activateRegion(region);
    await postFormulaDurationMessage({
      zoneName: cfg.name,
      duration: durationResolution,
      visibility: cfg.visibility,
      actor: sourceActor,
      token: sourceToken
    });
    return succeed({
      action: "create",
      sceneId: scene.id,
      regionId: region.id,
      regionUuid: region.uuid,
      duration: durationResolution?.formula
        ? { formula: durationResolution.formula, rounds: durationResolution.rounds }
        : null
    });
  }

  async function endZone() {
    const requester = getRequester();
    const scene = game.scenes.get(request.sceneId ?? "");
    const region = scene?.regions.get(request.regionId ?? "");
    if (!scene || !region) throw new Error("The requested PF2e Zone no longer exists.");

    const payload = region.getFlag(FLAG_SCOPE, FLAG_KEY);
    if (!payload) throw new Error("The requested Region is not a PF2e Zone.");

    if (!requester.isGM) {
      if (!payload.config?.duration?.dismissible) throw new Error("This zone is not dismissible by its source.");
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
      case "library-list": return await listLibrary();
      case "library-save": return await saveLibraryPreset();
      case "library-delete": return await deleteLibraryPreset();
      case "ping": return succeed({ action: "ping" });
      default: return fail(`Unsupported worker action '${request.action}'.`);
    }
  } catch (error) {
    console.error("PF2e Zone GM Worker failed", { request, error });
    return fail(error?.message ?? error);
  }
}
