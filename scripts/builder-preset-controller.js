import { normalizeConfig } from "./zone-config.js";
import { cloneData as clone, newOperationId } from "./utils.js";
import { presetLabel, renderSavedZones } from "./builder-view.js";

/** Owns shared-preset operations and frozen save retries while the editor retains its source and mutation guards. */
export function createBuilderPresetController({ editor, callGMWorker, validateForAction, showValidation, mutationStillCurrent, rerenderInsideDialog, DialogV2, libraryName: LIBRARY_JOURNAL_NAME }) {
  let presetSaveAttempt = null;

  /** Protects shared presets from being overwritten by users who did not create them. */
  function canOverwritePreset(record = editor.loadedPreset) {
    if (!record) return true;
    return game.user.isGM || record.createdBy?.userId === game.user.id;
  }

  /** Reads shared presets through the GM worker so players do not need Journal write permissions. */
  async function fetchSavedZoneRecords() {
    const response = await callGMWorker("library-list");
    return Array.isArray(response.records) ? response.records : [];
  }

  /** Saves the click-time configuration while leaving later editor changes intact. */
  async function saveCurrentPreset(operation, { asNew = false } = {}) {
    const { root, config: cfg, preset } = operation;
    if (presetSaveAttempt?.uncertain) {
      if (presetSaveAttempt.asNew !== asNew) {
        ui.notifications.warn(`Retry the earlier ${presetSaveAttempt.asNew ? "Save As" : "Save"} before starting a different save.`);
        return false;
      }
    } else {
      const validation = await validateForAction(root, cfg);
      if (validation.errors.length) {
        await showValidation(validation);
        return false;
      }
      if (!mutationStillCurrent(operation)) {
        ui.notifications.warn("The editor changed while validating. Save again to use the current configuration.");
        return false;
      }
      if (!asNew && preset && !canOverwritePreset(preset)) {
        ui.notifications.warn(`You can load ${presetLabel(preset)}, but only its creator or a GM can overwrite it. Use Save As instead.`);
        return false;
      }
      presetSaveAttempt = {
        operation, asNew, uncertain: false,
        request: {
          operationId: newOperationId(), recordId: asNew ? null : (preset?.id ?? null),
          expectedRevision: asNew ? null : (preset?.revision ?? null),
          sourceActorUuid: operation.sourceActor.uuid, config: clone(cfg)
        }
      };
    }
    const attempt = presetSaveAttempt;
    let response;
    try {
      response = await callGMWorker("library-save", attempt.request);
      presetSaveAttempt = null;
    } catch (error) {
      attempt.uncertain = error?.code === "PF2E_ZONE_REQUEST_TIMEOUT" || error?.retryable === true
        || (attempt.uncertain && error?.workerRejected !== true);
      if (!attempt.uncertain) presetSaveAttempt = null;
      else ui.notifications.warn(`The save may have completed. Use ${attempt.asNew ? "Save As" : "Save"} again to confirm the earlier save; newer edits will be kept.`);
      throw error;
    }
    for (const warning of response.warnings ?? []) ui.notifications.warn(warning);
    if (!mutationStillCurrent(attempt.operation)) {
      ui.notifications.info(`Saved '${presetLabel(response.record)}' to ${LIBRARY_JOURNAL_NAME}. The editor changed during saving; reopen the preset to see the saved version.`);
      return true;
    }
    editor.loadedPreset = clone(response.record);
    editor.state = normalizeConfig(response.record.config);
    ui.notifications.info(`${asNew ? "Saved copy" : "Saved"} '${presetLabel(editor.loadedPreset)}' to ${LIBRARY_JOURNAL_NAME}.`);
    try {
      rerenderInsideDialog();
    } catch (error) {
      console.error("PF2e Zone preset saved but builder refresh failed", error);
      ui.notifications.warn("The preset was saved, but the builder could not refresh. Close and reopen it before editing again.");
    }
    return true;
  }

  /** Lets users choose a shared preset without exposing the implementation details of the Library Journal. */
  async function showSavedZones() {
    const records = await fetchSavedZoneRecords();
    records.sort((a, b) => {
      const byName = String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" });
      if (byName) return byName;
      return String(a.createdBy?.name ?? "").localeCompare(String(b.createdBy?.name ?? ""), undefined, { sensitivity: "base" });
    });

    if (!records.length) {
      ui.notifications.info(`There are no saved zones in ${LIBRARY_JOURNAL_NAME}.`);
      return;
    }

    const content = document.createElement("div");
    content.innerHTML = renderSavedZones(records, { isGM: game.user.isGM, userId: game.user.id });

    const dlg = new DialogV2({
      window: { title: "Saved PF2e Zones" },
      position: { width: Math.max(520, Math.min(720, globalThis.innerWidth - 100)) },
      content,
      buttons: [{ action: "close", label: "Close", icon: "fa-solid fa-xmark" }]
    });

    dlg.addEventListener("render", () => {
      const list = dlg.window.content.querySelector(".pza-saved-list");
      list?.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        const row = button?.closest("[data-record-id]");
        if (!button || !row) return;
        const record = records.find((r) => r.id === row.dataset.recordId);
        if (!record) return;

        if (button.dataset.action === "load") {
          try {
            editor.state = normalizeConfig(record.config);
          } catch (error) {
            ui.notifications.error(`Could not open '${presetLabel(record)}': ${error.message ?? error}`);
            return;
          }
          editor.loadedPreset = clone(record);
          await dlg.close();
          rerenderInsideDialog();
          ui.notifications.info(`Loaded '${presetLabel(record)}'.`);
          return;
        }

        if (button.dataset.action === "delete") {
          const allowed = game.user.isGM || record.createdBy?.userId === game.user.id;
          if (!allowed) {
            ui.notifications.warn("Only the zone's creator or a GM can delete that saved zone.");
            return;
          }
          if (!window.confirm(`Delete saved zone '${presetLabel(record)}'?`)) return;

          button.disabled = true;
          let deletionCommitted = false;
          try {
            const response = await callGMWorker("library-delete", { recordId: record.id, expectedRevision: record.revision });
            deletionCommitted = true;
            row.remove();
            const index = records.findIndex((r) => r.id === record.id);
            if (index >= 0) records.splice(index, 1);
            if (editor.loadedPreset?.id === record.id) {
              editor.loadedPreset = null;
              rerenderInsideDialog();
            }
            ui.notifications.info(`Deleted '${presetLabel(record)}'.`);
            for (const warning of response.warnings ?? []) ui.notifications.warn(warning);
            if (!list.querySelector("[data-record-id]")) await dlg.close();
          } catch (error) {
            if (deletionCommitted) {
              console.error("PF2e Zone preset deleted but list refresh failed", error);
              ui.notifications.warn("The saved zone was deleted, but this list could not refresh. Reopen it before making another change.");
            } else {
              console.error("PF2e Zone saved-zone deletion failed", error);
              ui.notifications.error(`Could not delete saved zone: ${error.message ?? error}`);
              button.disabled = false;
            }
          }
        }
      });
    }, { once: true });

    await dlg.render({ force: true });
  }

  return { canOverwritePreset, fetchSavedZoneRecords, saveCurrentPreset, showSavedZones,
    /** Exposes retry status to button rendering without letting other controllers replace the request. */
    get saveAttempt() { return presetSaveAttempt; }
  };
}
