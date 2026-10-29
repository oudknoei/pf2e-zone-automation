import { normalizeConfig } from "./zone-config.js";
import { savedPresetFromZone } from "./zone-creation.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { cloneData as clone, titleCase } from "./utils.js";
import { renderManagedZones } from "./builder-view.js";

/** Owns existing-zone actions and preserves terminal Move placement through the editor's close and canvas adapters. */
export function createBuilderManagerController({
  editor,
  callGMWorker,
  fetchSavedZoneRecords,
  rerenderInsideDialog,
  hideBuilderForAreaPlacement,
  pickAreaCenter,
  DialogV2
}) {
  /** Prevents players from ending zones that their source ownership does not authorize them to dismiss. */
  async function canCurrentUserDismiss(payload) {
    if (game.user.isGM) return true;

    const actor = payload?.state?.sourceActorUuid ? await fromUuid(payload.state.sourceActorUuid) : null;

    return Boolean(actor?.testUserPermission?.(game.user, "OWNER"));
  }

  /** Provides a safe lifecycle view for active zones instead of requiring users to find Regions manually. */
  async function manageExistingZones() {
    const runtime = await zoneRuntimeEntrypoint();
    const zones = [...canvas.scene.regions].filter((r) => r.getFlag("world", "pf2eZone"));

    if (!zones.length) {
      ui.notifications.info("There are no PF2e Zone Automation Regions on this Scene.");

      return;
    }

    const zoneRows = [];

    for (const region of zones) {
      const payload = region.getFlag("world", "pf2eZone");
      const cfg = payload?.config ?? {};
      const canEnd = await canCurrentUserDismiss(payload);
      const cleanupPending = Boolean(payload?.state?.endRequested);
      const canMove = canEnd && cfg.mode === "area" && !cleanupPending;
      const pendingRows = [];

      if (game.user.isGM) {
        for (const [pendingId, pending] of Object.entries(payload?.state?.pendingSaves ?? {})) {
          if (!pending?.identifier) continue;

          let target = null;

          try {
            target = await fromUuid(pending.tokenUuid);
          } catch { /* A deleted token still needs a cleanup control. */ }

          const targetName = target?.name ?? pending.actorUuid ?? pending.tokenUuid ?? "Unknown creature";
          const saveTypes = (pending.saveTypes ?? []).map(titleCase).join(" or ") || "Save";

          pendingRows.push({
            pendingId,
            targetName,
            blockName: pending.blockName ?? "Effect Block",
            saveTypes,
            dc: pending.dc ?? "?"
          });
        }
      }

      zoneRows.push({
        id: region.id,
        name: region.name,
        config: cfg,
        createdByName: payload?.state?.createdBy?.name ?? "Unknown",
        canEnd,
        canMove,
        cleanupPending,
        pendingRows
      });
    }

    const content = document.createElement("div");

    content.innerHTML = renderManagedZones(zoneRows);

    const dlg = new DialogV2({
      window: { title: "Manage PF2e Zones" },
      position: { width: Math.max(560, Math.min(760, globalThis.innerWidth - 100)) },
      content,
      buttons: [{ action: "close", label: "Close", icon: "fa-solid fa-xmark" }]
    });

    dlg.addEventListener("render", () => {
      const root = dlg.window.content.querySelector(".pza-manage");

      root?.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        const row = button?.closest("[data-region-id]");
        const region = row ? canvas.scene.regions.get(row.dataset.regionId) : null;

        if (!button || !region) return;

        const payload = region.getFlag("world", "pf2eZone");

        if (button.dataset.action === "cancel-save") {
          if (!game.user.isGM) return;

          const pendingId = button.dataset.pendingId;
          const pending = payload?.state?.pendingSaves?.[pendingId];

          if (!pending?.identifier) {
            ui.notifications.warn("That save request is no longer pending.");

            return;
          }

          button.disabled = true;

          try {
            const response = await callGMWorker("cancel-pending-save", {
              sceneId: region.parent.id,
              regionId: region.id,
              pendingId,
              identifier: pending.identifier
            });
            const pendingRow = button.closest(".pza-pending-row");
            const list = pendingRow?.closest(".pza-pending-list");

            pendingRow?.remove();

            const remaining = list?.querySelectorAll(".pza-pending-row").length ?? 0;

            if (remaining) list.querySelector(".pza-pending-count").textContent = `Pending saves (${remaining})`;
            else list?.remove();
            if (response.status === "cancelled") {
              ui.notifications.info("Pending save request cancelled. Its chat button is no longer active.");
            } else if (response.status === "resolved") {
              ui.notifications.info("The save was already rolled, so its result was applied instead of cancelling it.");
            } else {
              ui.notifications.warn("That save request is no longer pending.");
            }
          } catch (error) {
            console.error("PF2e Zone save cancellation failed", error);
            ui.notifications.error(`Could not cancel save request: ${error.message ?? error}`);
            button.disabled = false;
          }

          return;
        }
        if (button.dataset.action === "move") {
          if (payload?.config?.mode !== "area" || payload?.state?.endRequested) return;

          button.disabled = true;

          const dimensions = payload.config.areaShape === "square"
            ? `${payload.config.sideLength}-foot square`
            : `${payload.config.radius}-foot circle`;

          hideBuilderForAreaPlacement();

          try {
            await dlg.close();
            await editor.dialog.close();

            const areaCenter = await pickAreaCenter(region.name, dimensions);

            if (!areaCenter) {
              ui.notifications.info("Zone movement was cancelled.");

              return;
            }

            await callGMWorker("move", {
              sceneId: region.parent.id,
              regionId: region.id,
              areaCenter
            });

            ui.notifications.info(`Moved '${region.name}'.`);
          } catch (error) {
            console.error("PF2e Zone movement failed", error);
            ui.notifications.error(`PF2e Zone movement failed: ${error.message ?? error}`);
          }

          return;
        }
        if (button.dataset.action !== "end") return;

        button.disabled = true;

        try {
          if (!payload?.config) throw new Error(`PF2e Zone '${region.name}' has no configuration to load.`);

          const zoneConfig = normalizeConfig(payload.config);
          const savedPresetId = String(payload.state?.savedPresetId ?? "").trim();
          const savedPreset = savedPresetId
            ? (await fetchSavedZoneRecords()).find((record) => record.id === savedPresetId) ?? null
            : null;

          if (game.user.isGM) {
            await runtime.endZone(region, "manager");
          } else {
            await callGMWorker("end", { sceneId: canvas.scene.id, regionId: region.id });
          }

          editor.state = zoneConfig;
          editor.loadedPreset = savedPresetFromZone(savedPreset ? clone(savedPreset) : null, payload.state);
          await dlg.close();
          rerenderInsideDialog();
          ui.notifications.info(`Dismissed '${region.name}' and opened its configuration. Source actor was not changed.`);

          if (savedPresetId && !savedPreset) {
            ui.notifications.warn("The zone's saved preset no longer exists. Save will create a new preset.");
          } else if (savedPreset && editor.loadedPreset.revision !== savedPreset.revision) {
            ui.notifications.warn("This zone's saved preset has changed or its original revision is unknown. Use Save As to keep this configuration, or Open the current saved version.");
          }
        } catch (error) {
          console.error("PF2e Zone dismissal failed", error);
          ui.notifications.error(`PF2e Zone dismissal failed: ${error.message ?? error}`);
          button.disabled = false;
        }
      });
    }, { once: true });

    await dlg.render({ force: true });
  }

  return { manageExistingZones };
}
