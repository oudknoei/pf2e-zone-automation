import {
  SCHEMA_VERSION,
  newId,
  isValuedCondition,
  getDcChoices,
  newBlock,
  defaultConfig,
  normalizeConfig,
  validateConfig as validateZoneConfig
} from "./zone-config.js";
import { requestGMWorker } from "./transport.js";
import { fixedAreaShape } from "./area-shape.js";
import { createZoneDocument } from "./zone-creation.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { activeOutcomeKeys, inspectEffectItem, validateEffectItems } from "./effect-items.js";
import { cloneData as clone, newOperationId } from "./utils.js";
import { getConditionChoices, getDamageChoices } from "./builder-catalog.js";
import { field, readConfig } from "./builder-form.js";
import {
  refreshConditionRow,
  validationTarget,
  renderInlineValidation,
  renderBuilderReadiness,
  renderOperationStatus,
  showEffectDetails,
  refreshVisibility,
  hideBuilderNativeFooter
} from "./builder-dom-view.js";
import {
  createBuilderView,
  blockSummary,
  renderEffectRow,
  renderEmptyResults,
  renderJsonExport,
  renderJsonImport,
  renderValidationDialog,
  renderActivationDamageChoice
} from "./builder-view.js";
import { createBuilderPresetController } from "./builder-preset-controller.js";
import { createBuilderManagerController } from "./builder-manager-controller.js";

/*
 * PF2e Zone Automation - Zone Builder
 * Target: Foundry VTT v14 + Pathfinder Second Edition 8.5.1
 * Edits zone configurations and places Regions through shared creation logic.
 * Player operations use the module socket to request actions from the active GM.
 *
 * Targeted and source-checked against PF2e 8.5.1 / Foundry VTT V14.
 */

/** Keeps builder startup tied to the active PF2e scene and selected source token. */
export async function openZoneBuilderController() {
  "use strict";

  const BUILDER_VERSION = "0.5.20";
  const LIBRARY_JOURNAL_NAME = "PF2e Zone Library";
  const DialogV2 = foundry.applications.api.DialogV2;

  if (game.system.id !== "pf2e") {
    ui.notifications.error("PF2e Zone Builder requires the Pathfinder Second Edition system.");

    return;
  }

  if (!canvas?.ready) {
    ui.notifications.error("PF2e Zone Builder requires an active Scene.");

    return;
  }

  /** Prevents ambiguous zones by requiring exactly one valid source before editing begins. */
  function selectedSourceToken({ notify = true } = {}) {
    const selected = canvas.tokens.controlled;

    if (selected.length !== 1) {
      if (notify) {
        ui.notifications.warn(
          selected.length === 0
            ? "Select exactly one source token before using PF2e Zone Builder."
            : "PF2e Zone Builder requires exactly one selected source token."
        );
      }

      return null;
    }
    if (!selected[0].actor) {
      if (notify) ui.notifications.warn("The selected token does not have an Actor.");

      return null;
    }

    return selected[0];
  }

  let sourceToken = selectedSourceToken();

  if (!sourceToken) return;

  let sourceActor = sourceToken.actor;

  /** Turns hidden player-to-GM prerequisites into an actionable builder status. */
  function workerSetupProblem() {
    if (game.user.isGM) return null;
    if (!game.users.activeGM) {
      return "An active GM must be logged into the world for player PF2e Zone operations.";
    }
    if (!game.socket?.connected) {
      return "The PF2e Zone module socket is not connected. Refresh Foundry and try again.";
    }

    return null;
  }

  /** Explains whether this user can create a zone before they invest time configuring one. */
  function currentOperationStatus() {
    if (!selectionStillMatchesSource()) {
      return {
        text: "Source token changed",
        detail: "Click Use Current Selection before previewing or creating a zone.",
        icon: "fa-triangle-exclamation",
        ready: false
      };
    }

    if (game.user.isGM) {
      return {
        text: "GM connected",
        detail: "This GM can create zones directly.",
        icon: "fa-user-shield",
        ready: true
      };
    }

    const problem = workerSetupProblem();

    if (!problem) {
      return {
        text: "Player creation available",
        detail: "An active GM is available to create the requested zone.",
        icon: "fa-user-check",
        ready: true
      };
    }

    return {
      text: "Player creation unavailable",
      detail: problem,
      icon: "fa-triangle-exclamation",
      ready: false
    };
  }

  /** Keeps player creation requests on the same privileged path as direct GM actions. */
  async function callGMWorker(action, data = {}) {
    const problem = workerSetupProblem();

    if (problem) throw new Error(problem);

    const request = {
      ...clone(data),
      protocol: 1,
      builderVersion: BUILDER_VERSION,
      action,
      requesterUserId: game.user.id
    };

    let response;

    try {
      response = await requestGMWorker(request);
    } catch (error) {
      if (action !== "library-save") throw error;

      const uncertain = new Error(error?.message ?? String(error), { cause: error });

      if (typeof error?.code === "string") uncertain.code = error.code;

      uncertain.retryable = true;

      throw uncertain;
    }

    if (!response?.ok) {
      const error = new Error(response?.error || `PF2e Zone GM Worker failed '${action}'.`);

      error.workerRejected = true;
      if (typeof response?.errorCode === "string") error.code = response.errorCode;
      if (response?.retryable === true) error.retryable = true;

      throw error;
    }

    return response;
  }

  /** Avoids reporting success before Foundry has made the newly created Region available. */
  async function waitForRegion(sceneId, regionId, timeoutMs = 3000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const region = game.scenes.get(sceneId)?.regions.get(regionId) ?? null;

      if (region) return region;

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return game.scenes.get(sceneId)?.regions.get(regionId) ?? null;
  }

  /** Removes the dialog from the canvas while placing an area so it cannot intercept the click. */
  function hideBuilderForAreaPlacement() {
    const element = dialog?.element ?? dialog?.window?.element ?? null;

    if (!element?.style) return () => {};

    const prior = {
      display: element.style.display,
      visibility: element.style.visibility,
      pointerEvents: element.style.pointerEvents
    };
    let restored = false;

    element.style.display = "none";

    return () => {
      if (restored) return;

      restored = true;
      if (!element?.style || !element.isConnected) return;

      element.style.display = prior.display;
      element.style.visibility = prior.visibility;
      element.style.pointerEvents = prior.pointerEvents;
    };
  }

  /** Makes fixed-area placement explicit and safely restores canvas input after completion or cancellation. */
  async function pickAreaCenter(name, description) {
    if (!canvas?.ready || !canvas.scene) throw new Error("An active Scene is required to place an area.");

    const canvasElement = canvas.app?.canvas ?? canvas.app?.view;

    if (!canvasElement) throw new Error("Foundry canvas element is unavailable.");

    ui.notifications.info(`Click the center of the ${description} ${name} area. Press Escape to cancel.`);

    const priorCursor = canvasElement.style.cursor;

    canvasElement.style.cursor = "crosshair";

    return await new Promise((resolve) => {
      let done = false;

      /** Restores canvas input after an area-placement interaction ends. */
      const cleanup = () => {
        canvasElement.removeEventListener("pointerdown", onPointer, true);
        window.removeEventListener("keydown", onKey, true);
        canvasElement.style.cursor = priorCursor;
      };

      /** Ensures area placement resolves once even when multiple input events occur. */
      const finish = (value) => {
        if (done) return;

        done = true;
        cleanup();
        resolve(value);
      };

      /** Consumes the placement click so creating an area does not also move or select a token. */
      const onPointer = (event) => {
        if (event.button !== 0) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });

        finish({ x: Number(point.x), y: Number(point.y) });
      };

      /** Lets users cancel placement without needing to close and reopen the builder. */
      const onKey = (event) => {
        if (event.key !== "Escape") return;

        event.preventDefault();
        finish(null);
      };

      canvasElement.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("keydown", onKey, true);
    });
  }

  /** Supplies the source selection context to the shared builder and GM validation rules. */
  function validateConfig(cfg, { requireCurrentSource = false } = {}) {
    return validateZoneConfig(cfg, {
      sourceActor,
      requireCurrentSource,
      currentSourceMatches: selectionStillMatchesSource()
    });
  }

  let state = defaultConfig();
  let loadedPreset = null; // { id, createdBy, modifiedBy, revision, ... } for the currently loaded/saved library entry
  let pendingMutation = null;
  let editRevision = 0;
  let creationAttempt = null;

  let creationCompleted = false;

  // Only operation controllers can update editor state; views receive plain rendering snapshots.
  const editor = {
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    get loadedPreset() {
      return loadedPreset;
    },
    set loadedPreset(value) {
      loadedPreset = value;
    },
    get dialog() {
      return dialog;
    }
  };
  const presetController = createBuilderPresetController({
    editor,
    callGMWorker,
    validateForAction,
    showValidation,
    mutationStillCurrent,
    rerenderInsideDialog,
    DialogV2,
    libraryName: LIBRARY_JOURNAL_NAME
  });
  const { canOverwritePreset, fetchSavedZoneRecords, saveCurrentPreset, showSavedZones } = presetController;
  const { manageExistingZones } = createBuilderManagerController({
    editor,
    callGMWorker,
    fetchSavedZoneRecords,
    rerenderInsideDialog,
    hideBuilderForAreaPlacement,
    pickAreaCenter,
    DialogV2
  });

  /** Captures only the source labels, choices and editor data needed for pure rendering. */
  function builderView() {
    return createBuilderView({
      state,
      loadedPreset,
      sourceActor: { name: sourceActor.name, img: sourceActor.img },
      sourceToken: { name: sourceToken.name, document: { texture: { src: sourceToken.document.texture?.src } } },
      conditionChoices: getConditionChoices(),
      damageChoices: getDamageChoices(),
      dcChoices: getDcChoices(sourceActor),
      sourceMatches: selectionStillMatchesSource(),
      canOverwrite: canOverwritePreset()
    });
  }

  /** Renders the editor from current operation state without handing state ownership to the view. */
  function renderRoot() {
    return builderView().renderRoot();
  }

  /** Uses the current catalog when adding a condition control to an existing block. */
  function renderConditionRow(...args) {
    return builderView().renderConditionRow(...args);
  }

  /** Formats a private preview using the current source and the validated click-time configuration. */
  function previewHtml(...args) {
    return builderView().previewHtml(...args);
  }

  /** Reserves a write before validation can yield, and keeps its source and preset fixed. */
  function beginMutation(root, kind) {
    if (pendingMutation || (kind === "create" && creationCompleted)) return null;

    pendingMutation = { kind };

    try {
      pendingMutation = {
        kind,
        root,
        editRevision,
        config: clone(syncState(root)),
        scene: canvas.scene,
        sourceActor,
        sourceToken: sourceToken.document,
        preset: loadedPreset ? clone(loadedPreset) : null,
        color: game.user.color
      };

      refreshLiveValidation(root);

      return pendingMutation;
    } catch (error) {
      pendingMutation = null;

      throw error;
    }
  }

  /** Leaves a later editor version untouched when an earlier save finishes. */
  function mutationStillCurrent(operation) {
    const currentRoot = dialog?.window?.content?.querySelector(".pf2e-zone-builder");

    return currentRoot === operation.root && currentRoot.isConnected
      && canvas.scene?.id === operation.scene?.id
      && editRevision === operation.editRevision
      && sourceToken.document.uuid === operation.sourceToken.uuid
      && loadedPreset?.id === operation.preset?.id
      && loadedPreset?.revision === operation.preset?.revision
      && JSON.stringify(readConfig(currentRoot)) === JSON.stringify(operation.config);
  }

  /** Releases the write slot without re-enabling a button in a replaced editor. */
  function finishMutation(operation) {
    if (pendingMutation !== operation) return;

    pendingMutation = null;

    const currentRoot = dialog?.window?.content?.querySelector(".pf2e-zone-builder");

    if (currentRoot?.isConnected) refreshLiveValidation(currentRoot);
  }

  /** Detects a changed token selection before it can create a zone from the wrong actor. */
  function selectionStillMatchesSource() {
    const current = selectedSourceToken({ notify: false });

    return Boolean(current && current.document.uuid === sourceToken.document.uuid);
  }

  const effectLookupCache = new Map();

  /** Rechecks visible rows when a source Item changes or the user asks to retry its UUID. */
  function invalidateEffectLookups(uuids) {
    let invalidated = false;

    for (const uuid of uuids) {
      if (effectLookupCache.delete(String(uuid ?? "").trim())) invalidated = true;
    }

    if (!invalidated) return;

    const root = dialog?.window?.content?.querySelector(".pf2e-zone-builder");

    if (root?.isConnected) refreshLiveValidation(root);
  }

  /** Reuses resolved Item details while keeping pending lookups from making creation appear ready. */
  function lookupEffect(root, uuid) {
    if (!effectLookupCache.has(uuid)) {
      const entry = { status: "pending", result: null };

      effectLookupCache.set(uuid, entry);
      void inspectEffectItem(uuid).then((result) => {
        entry.status = "done";
        entry.result = result;

        const visibleRoot = root.isConnected ? root : dialog?.window?.content?.querySelector(".pf2e-zone-builder");

        if (visibleRoot?.isConnected) refreshLiveValidation(visibleRoot);
      });
    }

    return effectLookupCache.get(uuid);
  }

  /** Keeps readiness accurate as the user edits rather than waiting for a failed create attempt. */
  function refreshLiveValidation(root) {
    const cfg = readConfig(root);
    const validation = validateConfig(cfg, { requireCurrentSource: true });
    let pendingCount = 0;

    for (const [index, block] of cfg.effects.entries()) {
      for (const outcomeKey of activeOutcomeKeys(block)) {
        const outcome = block.outcomes[outcomeKey];

        for (const [effectIndex, effect] of (outcome?.effects ?? []).entries()) {
          const target = {
            scope: "block",
            index,
            field: "effect-uuid",
            outcomeKey,
            effectIndex
          };
          const row = validationTarget(root, { target })?.closest(".zb-effect-row");
          const uuid = String(effect.uuid ?? "").trim();
          const entry = uuid ? lookupEffect(root, uuid) : null;

          showEffectDetails(row, entry);
          if (!entry) continue;
          if (entry.status === "pending") {
            pendingCount += 1;
          } else if (entry.result.error) {
            const message = (block.name || "Effect Block " + (index + 1)) + " " + outcomeKey + " Effect Item " + (effectIndex + 1) + ": " + entry.result.error;

            validation.errors.push(message);
            validation.issues.push({ message, target });
          }
        }
      }
    }

    renderInlineValidation(root, validation);

    renderBuilderReadiness(root, {
      validation,
      pendingCount,
      pendingMutation: Boolean(pendingMutation),
      creationCompleted,
      loadedPreset: Boolean(loadedPreset),
      canOverwrite: canOverwritePreset(),
      saveAttempt: presetController.saveAttempt
    });

    refreshOperationStatus(root);

    return validation;
  }

  /** Confirms the current UUIDs at action time, including when a lookup was still pending. */
  async function validateForAction(root, cfg, { requireCurrentSource = false } = {}) {
    const validation = validateConfig(cfg, { requireCurrentSource });
    const effectValidation = await validateEffectItems(cfg);

    validation.errors.push(...effectValidation.errors);
    validation.issues.push(...effectValidation.issues);

    for (const [uuid, result] of effectValidation.resolved) {
      effectLookupCache.set(uuid, { status: "done", result });
    }

    refreshLiveValidation(root);
    renderInlineValidation(root, validation);

    return validation;
  }

  /** Lets users copy export data without opening developer tools or altering live zones. */
  async function showJson(title, json) {
    const content = document.createElement("div");

    content.innerHTML = renderJsonExport(json);

    const dlg = new DialogV2({
      window: { title },
      position: { width: Math.max(620, Math.min(760, globalThis.innerWidth - 100)) },
      content,
      buttons: [
        { action: "close", label: "Close", icon: "fa-solid fa-xmark" }
      ]
    });

    await dlg.render({ force: true });
  }

  /** Keeps source ownership out of imported data so a preset cannot redirect a zone to another actor. */
  async function importJson() {
    const content = document.createElement("div");

    content.innerHTML = renderJsonImport(sourceActor.name);

    const fd = await DialogV2.input({
      window: { title: "Import PF2e Zone JSON" },
      position: { width: Math.max(600, Math.min(720, globalThis.innerWidth - 100)) },
      content,
      ok: { label: "Import", icon: "fa-solid fa-file-import" },
      rejectClose: false
    });

    if (!fd) return null;

    try {
      const parsed = JSON.parse(String(fd.json ?? ""));

      if (parsed?.schemaVersion && Number(parsed.schemaVersion) > SCHEMA_VERSION) {
        ui.notifications.error(`This preset uses schema version ${parsed.schemaVersion}; this builder supports version ${SCHEMA_VERSION}.`);

        return null;
      }

      return normalizeConfig(parsed);
    } catch (err) {
      console.error("PF2e Zone Builder import error", err);
      ui.notifications.error(`Could not import zone JSON: ${err.message}`);

      return null;
    }
  }

  /** Gives users an explicit review step when they ask to validate rather than create. */
  async function showValidation(result) {
    const content = document.createElement("div");

    content.innerHTML = renderValidationDialog(result);
    await DialogV2.prompt({
      window: { title: result.errors.length ? "Zone Configuration Problems" : "Zone Configuration Validation" },
      content,
      ok: { label: "Close" },
      rejectClose: false
    });
  }

  /** Asks once for shared damage type choices so every block uses the same activation decision. */
  async function chooseActivationDamageType(cfg) {
    const choice = cfg.activationChoices?.damageType;

    if (!choice?.enabled) return null;
    if (choice.options.length === 1) return choice.options[0];

    const fd = await DialogV2.input({
      window: { title: `${cfg.name} — Choose Damage Type` },
      content: renderActivationDamageChoice(choice.options),
      ok: { label: "Use Damage Type", icon: "fa-solid fa-check" },
      rejectClose: false
    });

    return fd ? String(fd.damageType ?? "") : undefined;
  }

  /** Sends one frozen creation request so a retry can reuse its original GM operation ID. */
  async function createZoneRegion(operation, chosenDamageType, attempt) {
    const cfg = operation.config;
    const savedPresetId = operation.preset?.id ?? null;
    const savedPresetRevision = operation.preset?.revision ?? null;

    if (savedPresetId && !attempt.uncertain
      && !(await fetchSavedZoneRecords()).some((record) => record.id === savedPresetId)) {
      throw new Error("The saved zone this configuration came from no longer exists. Use Save As to create a new preset.");
    }
    if (!game.user.isGM) {
      if (cfg.mode === "area" && !attempt.areaCenter) {
        const dimensions = cfg.areaShape === "square" ? cfg.sideLength + "-foot square" : cfg.radius + "-foot circle";

        attempt.areaCenter = await pickAreaCenter(cfg.name, dimensions);
        if (!attempt.areaCenter) return null;
      }

      const response = await callGMWorker("create", {
        operationId: attempt.operationId,
        sceneId: operation.scene.id,
        sourceTokenUuid: operation.sourceToken.uuid,
        config: clone(cfg),
        savedPresetId,
        savedPresetRevision,
        chosenDamageType: chosenDamageType ?? null,
        color: operation.color,
        areaCenter: attempt.areaCenter ?? null
      });

      if (response.duration?.formula) {
        ui.notifications.info("PF2e Zone duration: " + response.duration.rounds + " rounds (rolled " + response.duration.formula + ").");
      }

      const region = await waitForRegion(response.sceneId, response.regionId);
      const warnings = [...(response.warnings ?? [])];

      if (!region) {
        warnings.push("The GM created the zone, but it has not appeared on this client yet. Check Manage Existing Zones before creating another.");
      }

      return { region, regionId: response.regionId, warnings };
    }

    const { region, durationResolution, warnings } = await createZoneDocument({
      rawConfig: cfg,
      scene: operation.scene,
      sourceActor: operation.sourceActor,
      sourceToken: operation.sourceToken,
      requester: game.user,
      savedPresetId,
      savedPresetRevision,
      chosenDamageType,
      color: operation.color,
      placeArea: async (regionData, config) => {
        const dimensions = config.areaShape === "square" ? config.sideLength + "-foot square" : config.radius + "-foot circle";

        ui.notifications.info("Place the " + dimensions + " " + config.name + " area on the Scene.");

        return await canvas.regions.placeRegion({
          ...regionData,
          shapes: [fixedAreaShape(config, { x: 0, y: 0 }, canvas.dimensions.distancePixels)]
        }, { allowRotation: false });
      }
    });

    if (durationResolution?.formula) {
      ui.notifications.info("PF2e Zone duration: " + durationResolution.rounds + " rounds (rolled " + durationResolution.formula + ").");
    }

    return { region, regionId: region?.id ?? null, warnings };
  }

  /** Captures current form input before actions that rerender, save, preview, or create. */
  function syncState(root) {
    state = readConfig(root);

    return state;
  }

  let dialog;
  let operationStatusTimer = null;

  /** Keeps connection and ownership limits visible while the builder remains open. */
  function refreshOperationStatus(root) {
    const operation = currentOperationStatus();

    renderOperationStatus(root, operation);

    return operation;
  }

  /** Prevents background timers from surviving after the dialog is closed. */
  function stopOperationStatusPolling() {
    if (operationStatusTimer === null) return;

    globalThis.clearInterval(operationStatusTimer);
    operationStatusTimer = null;
  }

  /** Refreshes player availability when a GM connects or disconnects while the dialog is open. */
  function startOperationStatusPolling(root) {
    stopOperationStatusPolling();
    operationStatusTimer = globalThis.setInterval(() => {
      if (!root.isConnected) {
        stopOperationStatusPolling();

        return;
      }

      refreshOperationStatus(root);
    }, 1000);
  }

  /** Updates dynamic content without losing the current dialog context or its event wiring. */
  function rerenderInsideDialog() {
    const content = dialog.window.content;

    content.innerHTML = renderRoot();
    wire(content.querySelector(".pf2e-zone-builder"));
  }

  /** Finds the canonical block before mutations so UI buttons cannot edit an obsolete copy. */
  function findBlock(blockId) {
    return state.effects.find((b) => b.id === blockId);
  }

  /** Connects the rendered controls to state changes while keeping validation current after every edit. */
  function wire(root) {
    if (!root) return;

    refreshVisibility(root);
    refreshLiveValidation(root);
    startOperationStatusPolling(root);

    for (const blockElement of root.querySelectorAll("details.zb-block")) {
      blockElement.addEventListener("toggle", () => {
        if (blockElement.open) return;

        const block = readConfig(root).effects.find((entry) => entry.id === blockElement.dataset.blockId);
        const summary = blockElement.querySelector("[data-block-summary]");

        if (block && summary) summary.textContent = blockSummary(block);
      });
    }

    root.addEventListener("change", (event) => {
      editRevision++;

      const target = event.target;

      if (!(target instanceof HTMLElement)) return;

      if (target.matches('[data-field="condition-slug"]')) {
        const row = target.closest(".zb-condition-row");
        const valueInput = row?.querySelector('[data-field="condition-value"]');

        if (valueInput) {
          const valued = isValuedCondition(target.value);

          valueInput.disabled = !valued;
          valueInput.placeholder = valued ? "1" : "—";
          if (valued && !valueInput.value) valueInput.value = "1";
          if (!valued) valueInput.value = "";
        }

        refreshLiveValidation(root);

        return;
      }

      if (target.matches('[data-field="condition-removal"]')) {
        refreshConditionRow(target.closest(".zb-condition-row"));
        refreshLiveValidation(root);

        return;
      }

      if (target.matches('[data-zone="mode"], [data-zone="duration-type"], [data-zone="damage-choice-enabled"], [data-trigger="traitUse"], [data-trigger="spellCast"], [data-trigger="hpThreshold"], [data-field="chat-alert-enabled"], [data-field="save-enabled"], [data-field="save-type"], [data-field="dc-source"], [data-field="basic-save"], [data-field="damage-enabled"], [data-field="healing-enabled"], [data-field="damage-type-mode"], [data-field="immunity-duration"], [data-field="immunity-scope"], [data-immunity-start]')) {
        refreshVisibility(root);
      }

      refreshLiveValidation(root);
    });

    root.addEventListener("input", (event) => {
      editRevision++;
      if (event.target instanceof HTMLElement) refreshLiveValidation(root);
    });

    root.addEventListener("dragover", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest(".zb-effect-list")) {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }
    });

    root.addEventListener("drop", async (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) return;

      const list = target.closest(".zb-effect-list");

      if (!list) return;

      event.preventDefault();
      event.stopPropagation();

      try {
        const dragData = foundry.applications.ux.TextEditor.getDragEventData(event);

        if (dragData?.type !== "Item" || !dragData.uuid) {
          ui.notifications.warn("Drop a PF2e Effect Item with a UUID from a sheet, Items list, or compendium.");

          return;
        }

        const details = await inspectEffectItem(dragData.uuid);

        if (!list.isConnected) return;
        if (details.error) {
          ui.notifications.warn(details.error);

          return;
        }

        let row = target.closest(".zb-effect-row") ?? [...list.querySelectorAll(".zb-effect-row")]
          .find((candidate) => !candidate.querySelector('[data-field="effect-uuid"]').value.trim());

        if (!row) {
          const outcome = list.closest(".zb-outcome");
          const block = list.closest(".zb-block");
          const holder = document.createElement("div");

          holder.innerHTML = renderEffectRow(
            { uuid: "", removal: "item-duration" },
            block.dataset.blockId,
            outcome.dataset.outcome,
            list.querySelectorAll(".zb-effect-row").length
          );

          row = holder.firstElementChild;
          list.querySelector(".zb-empty")?.remove();
          list.append(row);
        }

        row.querySelector('[data-field="effect-uuid"]').value = details.uuid;
        effectLookupCache.set(details.uuid, { status: "done", result: details });
        refreshLiveValidation(root);
      } catch (error) {
        console.error("PF2e Zone Effect Item drop failed", error);
        ui.notifications.error("Could not read that Effect Item drop.");
      }
    });

    root.querySelector(".zb-use-selection").addEventListener("click", () => {
      syncState(root);

      const current = selectedSourceToken();

      if (!current) return;

      sourceToken = current;
      sourceActor = current.actor;
      rerenderInsideDialog();
      ui.notifications.info(`PF2e Zone Builder source set to ${sourceActor.name}.`);
    });

    for (const button of root.querySelectorAll(".zb-add-block")) {
      button.addEventListener("click", () => {
        syncState(root);
        state.effects.push(newBlock(state.effects.length + 1));
        rerenderInsideDialog();
      });
    }

    for (const button of root.querySelectorAll(".zb-remove-block")) {
      button.addEventListener("click", () => {
        syncState(root);
        if (state.effects.length <= 1) return;

        state.effects = state.effects.filter((b) => b.id !== button.dataset.block);
        rerenderInsideDialog();
      });
    }

    for (const button of root.querySelectorAll(".zb-duplicate-block")) {
      button.addEventListener("click", () => {
        syncState(root);

        const block = findBlock(button.dataset.block);

        if (!block) return;

        const copy = clone(block);

        copy.id = newId();
        copy.name = `${copy.name} Copy`;

        const idx = state.effects.findIndex((b) => b.id === block.id);

        state.effects.splice(idx + 1, 0, copy);
        rerenderInsideDialog();
      });
    }

    // Degree-of-success payload rows are edited in place so adding/removing a
    // Condition or Effect Item does not rerender the builder and reset scroll.
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button");

      if (!button || !root.contains(button)) return;

      if (button.matches(".zb-retry-effect")) {
        const uuid = button.closest(".zb-effect-row")?.querySelector('[data-field="effect-uuid"]')?.value;

        invalidateEffectLookups([uuid]);

        return;
      }

      if (button.matches(".zb-add-condition")) {
        const outcomeEl = button.closest(".zb-outcome");
        const list = outcomeEl?.querySelector(".zb-condition-list");

        if (!outcomeEl || !list) return;

        list.querySelector(".zb-empty")?.remove();

        const holder = document.createElement("div");
        const index = list.querySelectorAll(".zb-condition-row").length;

        holder.innerHTML = renderConditionRow(
          {
            slug: "frightened",
            value: 1,
            removal: "normal",
            condition: null
          },
          button.dataset.block,
          button.dataset.outcome,
          index
        );

        const row = holder.firstElementChild;

        if (row) {
          list.append(row);
          refreshConditionRow(row);
        }

        refreshLiveValidation(root);

        return;
      }

      if (button.matches(".zb-remove-condition")) {
        const row = button.closest(".zb-condition-row");
        const list = row?.closest(".zb-condition-list");

        if (!row || !list) return;

        row.remove();

        if (!list.querySelector(".zb-condition-row")) {
          list.innerHTML = renderEmptyResults("No conditions");
        }

        refreshLiveValidation(root);

        return;
      }

      if (button.matches(".zb-add-effect")) {
        const outcomeEl = button.closest(".zb-outcome");
        const list = outcomeEl?.querySelector(".zb-effect-list");

        if (!outcomeEl || !list) return;

        list.querySelector(".zb-empty")?.remove();

        const holder = document.createElement("div");
        const index = list.querySelectorAll(".zb-effect-row").length;

        holder.innerHTML = renderEffectRow(
          { uuid: "", removal: "item-duration" },
          button.dataset.block,
          button.dataset.outcome,
          index
        );

        const row = holder.firstElementChild;

        if (row) list.append(row);

        refreshLiveValidation(root);

        return;
      }

      if (button.matches(".zb-remove-effect")) {
        const row = button.closest(".zb-effect-row");
        const list = row?.closest(".zb-effect-list");

        if (!row || !list) return;

        row.remove();

        if (!list.querySelector(".zb-effect-row")) {
          list.innerHTML = renderEmptyResults("No Effect Items");
        }

        refreshLiveValidation(root);
      }
    });

    root.querySelector(".zb-clear").addEventListener("click", () => {
      state = defaultConfig();
      loadedPreset = null;
      rerenderInsideDialog();
      ui.notifications.info("Zone configuration cleared. Source actor was not changed.");
    });

    root.querySelector(".zb-load-saved").addEventListener("click", async () => {
      syncState(root);

      try {
        await showSavedZones();
      } catch (error) {
        console.error("PF2e Zone saved-zone load failed", error);
        ui.notifications.error(`Could not open saved zones: ${error.message ?? error}`);
      }
    });

    root.querySelector(".zb-save").addEventListener("click", async () => {
      const operation = beginMutation(root, "save");

      if (!operation) return;

      try {
        await saveCurrentPreset(operation, { asNew: false });
      } catch (error) {
        console.error("PF2e Zone save failed", error);
        ui.notifications.error(`Could not save zone: ${error.message ?? error}`);
      } finally {
        finishMutation(operation);
      }
    });

    root.querySelector(".zb-save-as").addEventListener("click", async () => {
      const operation = beginMutation(root, "save-as");

      if (!operation) return;

      try {
        await saveCurrentPreset(operation, { asNew: true });
      } catch (error) {
        console.error("PF2e Zone Save As failed", error);
        ui.notifications.error(`Could not save zone copy: ${error.message ?? error}`);
      } finally {
        finishMutation(operation);
      }
    });

    root.querySelector(".zb-manage").addEventListener("click", async () => {
      syncState(root);
      await manageExistingZones();
    });

    root.querySelector(".zb-import").addEventListener("click", async () => {
      syncState(root);

      const imported = await importJson();

      if (!imported) return;

      state = imported;
      loadedPreset = null;
      rerenderInsideDialog();
      ui.notifications.info("Zone configuration imported. Source actor was not changed.");
    });

    root.querySelector(".zb-close").addEventListener("click", async () => {
      await dialog.close();
    });

    root.querySelector(".zb-export").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = await validateForAction(root, cfg);

      if (validation.errors.length) {
        await showValidation(validation);

        return;
      }

      const json = JSON.stringify(cfg, null, 2);

      console.log("PF2e Zone Builder exported configuration", cfg);
      await showJson(`Export Zone JSON — ${cfg.name}`, json);
    });

    root.querySelector(".zb-validate").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = await validateForAction(root, cfg, { requireCurrentSource: true });

      console.log("PF2e Zone Builder validation", { cfg, validation });
      await showValidation(validation);
    });

    root.querySelector(".zb-preview").addEventListener("click", async () => {
      const cfg = syncState(root);
      const validation = await validateForAction(root, cfg, { requireCurrentSource: true });

      if (validation.errors.length) {
        await showValidation(validation);

        return;
      }

      // Useful during phase-one testing. This is intentionally not persistent game data.
      globalThis.PF2EZoneBuilderLastConfig = clone(cfg);
      console.log("PF2e Zone Builder normalized configuration", cfg);

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken.document }),
        content: previewHtml(cfg, validation),
        whisper: [game.user.id]
      });

      ui.notifications.info("Zone configuration is valid. Private preview posted to chat.");
    });

    root.querySelector(".zb-create").addEventListener("click", async () => {
      const operation = beginMutation(root, "create");

      if (!operation) return;

      let restoreBuilder = () => {};

      try {
        const cfg = operation.config;
        const validation = await validateForAction(root, cfg, { requireCurrentSource: true });

        if (validation.errors.length) {
          await showValidation(validation);

          return;
        }
        if (!mutationStillCurrent(operation) || !selectionStillMatchesSource()) {
          ui.notifications.warn("The editor or source selection changed while validating. Create again to use the current configuration.");

          return;
        }

        const chosenDamageType = await chooseActivationDamageType(cfg);

        if (cfg.activationChoices?.damageType?.enabled && chosenDamageType === undefined) return;
        if (!mutationStillCurrent(operation) || !selectionStillMatchesSource()) {
          ui.notifications.warn("The editor or source selection changed while choosing a damage type. Create again to use the current configuration.");

          return;
        }

        const signature = JSON.stringify({
          config: cfg,
          sceneId: operation.scene.id,
          sourceTokenUuid: operation.sourceToken.uuid,
          presetId: operation.preset?.id ?? null,
          presetRevision: operation.preset?.revision ?? null,
          chosenDamageType
        });

        if (creationAttempt?.uncertain && creationAttempt.signature !== signature) {
          ui.notifications.warn("A previous creation request may still finish. Retry that configuration or check Manage Existing Zones before creating a different one.");

          return;
        }
        if (!creationAttempt || creationAttempt.signature !== signature) {
          creationAttempt = {
            signature,
            operationId: newOperationId(),
            areaCenter: null,
            uncertain: false
          };
        }

        const attempt = creationAttempt;

        restoreBuilder = cfg.mode === "area" ? hideBuilderForAreaPlacement() : () => {};

        globalThis.PF2EZoneBuilderLastConfig = clone(cfg);

        const creation = await createZoneRegion(operation, chosenDamageType, attempt);

        if (!creation?.region && !creation?.regionId) {
          creationAttempt = null;
          ui.notifications.info("Zone creation was cancelled.");

          return;
        }

        creationAttempt = null;
        creationCompleted = true;
        console.log("PF2e Zone created", { region: creation.region, regionId: creation.regionId, config: cfg });
        ui.notifications.info(`PF2e Zone '${cfg.name}' created.`);
        for (const warning of creation.warnings ?? []) ui.notifications.warn(warning);

        if (!mutationStillCurrent(operation)) {
          restoreBuilder();
          ui.notifications.warn("The zone was created from the earlier configuration. Your newer editor changes were kept; close and reopen the builder before creating another zone.");

          return;
        }

        try {
          await dialog.close();
        } catch (error) {
          restoreBuilder();
          console.error("PF2e Zone was created but the builder could not close", error);
          ui.notifications.warn("The zone was created, but the builder could not close. Check Manage Existing Zones before creating another.");
        }
      } catch (error) {
        restoreBuilder();
        if (creationAttempt) creationAttempt.uncertain = error?.code === "PF2E_ZONE_REQUEST_TIMEOUT";
        if (!creationAttempt?.uncertain) creationAttempt = null;

        console.error("PF2e Zone creation failed", error);
        ui.notifications.error(`PF2e Zone creation failed: ${error.message ?? error}`);
      } finally {
        finishMutation(operation);
      }
    });
  }

  await zoneRuntimeEntrypoint();

  if (!game.user.isGM) {
    const workerProblem = workerSetupProblem();

    if (workerProblem) console.warn("PF2e Zone player setup:", workerProblem);
  }

  if (globalThis.PF2EZoneRuntimeLegacyHooksDetected) {
    ui.notifications.warn(
      "PF2e Zone: hooks from an older test build are still active in this browser session. Refresh Foundry once before further duration testing."
    );
  }

  const content = document.createElement("div");

  content.innerHTML = renderRoot();

  const builderWidth = Math.max(720, Math.min(980, globalThis.innerWidth - 120));

  dialog = new DialogV2({
    window: { title: `PF2e Zone Automation v${game.modules.get("pf2e-zone-automation")?.version ?? "unknown"}` },
    position: { width: builderWidth },
    content,
    // DialogV2 requires at least one native button. The builder has its own
    // sticky Close/Validate bar, so this native footer is hidden after render.
    buttons: [
      {
        action: "close",
        label: "Close",
        icon: "fa-solid fa-xmark",
        default: true
      }
    ]
  });

  const effectItemHooks = [];

  for (const name of ["createItem", "updateItem", "deleteItem"]) {
    effectItemHooks.push([name, Hooks.on(name, (item) => invalidateEffectLookups([item?.uuid]))]);
  }

  effectItemHooks.push(["updateCompendium", Hooks.on("updateCompendium", (pack) => {
    if (!pack?.collection) return;

    const prefix = `Compendium.${pack.collection}.Item.`;

    invalidateEffectLookups([...effectLookupCache.keys()].filter((uuid) => uuid.startsWith(prefix)));
  })]);

  dialog.addEventListener("close", () => {
    stopOperationStatusPolling();
    for (const [name, hookId] of effectItemHooks) Hooks.off(name, hookId);
  }, { once: true });

  dialog.addEventListener("render", () => {
    // Do not override DialogV2's internal form/layout. The builder itself is the
    // scroll container, which also behaves cleanly when the window is detached.
    const root = dialog.window.content.querySelector(".pf2e-zone-builder");

    // DialogV2 insists on a native button entry. Hide that native footer so the
    // visible controls are only the builder's sticky Close/Validate bar.
    // If Foundry changes this selector later, the harmless fallback is simply
    // that an additional native Close button remains visible.
    hideBuilderNativeFooter(dialog);

    wire(root);
  }, { once: true });

  await dialog.render({ force: true });
}
