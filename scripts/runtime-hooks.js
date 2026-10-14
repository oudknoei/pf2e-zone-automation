import { titleCase as titleCaseLocal } from "./utils.js";
import { VERSION, SAVE_PREFIX } from "./runtime-constants.js";

/** Owns Foundry hook registration and complete teardown for the composed runtime. */
export function createRuntimeHookService() {
  return {
    hooksInstalled: false,

    /** Releases hooks and timers so a replaced runtime cannot process events twice. */
    teardownHooks() {
      this.retired = true;
      this.authorityGeneration++;
      const registry = globalThis.PF2EZoneRuntimeHookRegistry;
      if (registry?.runtime !== this) {
        this.hooksInstalled = false;
        return;
      }

      for (const [hookName, hookId] of registry.hookIds ?? []) {
        try { Hooks.off(hookName, hookId); }
        catch (error) { console.warn("PF2e Zone: failed to unregister hook", hookName, hookId, error); }
      }

      for (const timer of this.regionReconcileTimers.values()) clearTimeout(timer);
      this.regionReconcileTimers.clear();
      for (const timer of this.activationFinalizeTimers.values()) clearTimeout(timer);
      this.activationFinalizeTimers.clear();
      for (const timer of this.sharedImmunityCancellationTimers.values()) clearTimeout(timer);
      this.sharedImmunityCancellationTimers.clear();
      this.sharedResolutionLocks.clear();
      this.areaBoundaryBefore.clear();
      this.areaBoundarySnapshots.clear();
      for (const entry of this.areaBoundarySuppression.values()) clearTimeout(entry.timer);
      this.areaBoundarySuppression.clear();
      this.effectiveOccupants.clear();
      if (this.authorityRecoveryTimer !== null) clearTimeout(this.authorityRecoveryTimer);
      this.authorityRecoveryTimer = null;

      if (registry.clickHandler) {
        document.removeEventListener("click", registry.clickHandler);
      }

      delete globalThis.PF2EZoneRuntimeHookRegistry;
      this.hooksInstalled = false;
    },

    /** Subscribes to the narrow set of Foundry events needed to keep zones current. */
    installHooks() {
      if (this.hooksInstalled) return;
      this.retired = false;

      // v0.3.4+ owns a single global hook registry. Future runtime upgrades
      // can therefore replace hooks cleanly instead of accumulating one
      // updateCombat listener per test version.
      const priorRegistry = globalThis.PF2EZoneRuntimeHookRegistry;
      if (priorRegistry?.runtime && priorRegistry.runtime !== this) {
        try { priorRegistry.runtime.teardownHooks?.(); }
        catch (error) { console.warn("PF2e Zone: prior runtime hook teardown failed", error); }
      }

      const runtime = this;
      const hookIds = [];
      /** Records hook IDs so teardown can reliably remove every runtime listener. */
      const on = (hookName, fn) => {
        const hookId = Hooks.on(hookName, fn);
        hookIds.push([hookName, hookId]);
        return hookId;
      };

      /** Rechecks every zone on a Scene after token movement or physical-wall changes. */
      const reconcileSceneZones = (document, delay = 100) => {
        const scene = document?.parent;
        if (!scene?.regions) return;
        for (const region of scene.regions.values?.() ?? scene.regions) {
          if (runtime.isOperational(region)) runtime.scheduleRegionReconcile(region, delay);
        }
      };

      on("createChatMessage", (message) => {
        const identifier = message.flags?.pf2e?.context?.identifier;
        if (typeof identifier === "string" && identifier.startsWith(`${SAVE_PREFIX}:`)) {
          runtime.handleSaveResult(message).catch((e) => console.error("PF2e Zone save-result hook", e));
        }
        runtime.handleTraitUseMessage(message).catch((e) => console.error("PF2e Zone trait-use hook", e));
      });

      /** Rechecks dependency watches when effects or conditions change outside a direct zone action. */
      const itemChanged = (item) => {
        // Dependency reconciliation is only relevant when a Condition
        // changes. Effect Items and other owned Items should not wake this
        // hook during ordinary zone cleanup.
        if (item?.type !== "condition") return;

        const actor = item?.actor ?? item?.parent;
        if (!actor) return;

        const deleteKey = runtime.itemDeleteKey(item);
        if (runtime.deletingItems.has(deleteKey)) return;

        // Allow Foundry's embedded document transaction to finish before
        // inspecting or modifying the actor's Condition collection.
        setTimeout(() => {
          if (runtime.deletingItems.has(deleteKey)) return;
          runtime.reconcileActorDependencies(actor)
            .catch((e) => console.error("PF2e Zone condition hook", e));
        }, 100);
      };
      on("updateActor", (actor) => {
        runtime.handleActorHitPointUpdate(actor)
          .catch((e) => console.error("PF2e Zone HP threshold hook", e));
      });

      on("updateItem", itemChanged);
      on("deleteItem", (item) => {
        runtime.forgetDeletedAppliedItem(item)
          .catch((e) => console.error("PF2e Zone deleted-Item history hook", e));
        itemChanged(item);
      });

      on("updateCombat", async (combat) => {
        const lease = runtime.captureAuthorityLease();
        try {
          await runtime.checkAllDurations(lease);
          await runtime.processAllSourceTurnStarts(combat, lease);
          await runtime.processAllActiveTurnStarts(combat, lease);
        } catch (e) {
          console.error("PF2e Zone combat hook", e);
        }
      });
      // Combatant and encounter lifecycle changes can replace the source clock without an updateCombat hook.
      for (const hookName of ["createCombatant", "updateCombatant", "deleteCombatant", "createCombat", "deleteCombat"]) {
        on(hookName, () =>
          runtime.checkAllDurations().catch((e) => console.error("PF2e Zone combat roster hook", e))
        );
      }
      on("updateWorldTime", () =>
        runtime.checkAllDurations().catch((e) => console.error("PF2e Zone world-time hook", e))
      );

      // A different connected GM can become authoritative without loading a
      // new module instance. Both signals share one debounced full recovery pass.
      /** Defers authority inspection until Foundry has updated its active-GM selection. */
      const resumeAuthorityWork = () => {
        runtime.refreshAuthorityGeneration();
        runtime.scheduleAuthorityRecovery("active-GM handoff");
      };
      on("userConnected", resumeAuthorityWork);
      on("updateUser", resumeAuthorityWork);

      on("createToken", (token) => reconcileSceneZones(token));
      on("updateToken", (token) => reconcileSceneZones(token));
      on("deleteToken", (token) => {
        reconcileSceneZones(token);
        runtime.reconcileDeletedToken(token)
          .catch((e) => console.error("PF2e Zone token deletion cleanup", e));
      });
      for (const hookName of ["createWall", "updateWall", "deleteWall"]) {
        on(hookName, (wall) => reconcileSceneZones(wall));
      }
      on("deleteActor", (actor) => {
        runtime.reconcileDeletedActor(actor)
          .catch((e) => console.error("PF2e Zone Actor deletion cleanup", e));
      });

      on("createRegion", (region) => {
        runtime.rememberAreaBoundary(region);
        runtime.rememberEffectiveOccupants(region)
          .catch((e) => console.error("PF2e Zone effective-occupant initialization", e));
      });
      on("createScene", (scene) => {
        for (const region of scene.regions ?? []) {
          runtime.rememberAreaBoundary(region);
          runtime.rememberEffectiveOccupants(region)
            .catch((e) => console.error("PF2e Zone effective-occupant initialization", e));
        }
      });

      on("preUpdateRegion", (region, changes) => {
        if (!runtime.isAuthority()) return;
        if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "shapes")) return;
        runtime.captureAreaBoundary(region);
      });

      on("updateRegion", (region, changes) => {
        if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "shapes")) return;
        const before = runtime.areaBoundaryBefore.get(region.uuid)
          ?? runtime.areaBoundarySnapshots.get(region.uuid);
        runtime.areaBoundaryBefore.delete(region.uuid);
        runtime.rememberAreaBoundary(region);
        if (!runtime.isAuthority() || !runtime.isOperational(region)) return;

        // Foundry reports destination entry, but a dragged area can pass
        // over a token that is outside again at the end of the move.
        if (before) runtime.processAreaBoundaryChange(region, before)
          .catch((e) => console.error("PF2e Zone area movement", e));

        // Resizing can also emit transient exits. Reconcile maintained
        // effects after membership has settled.
        runtime.scheduleRegionReconcile(region, 100);
      });

      on("deleteRegion", (region) => {
        const activationTimer = runtime.activationFinalizeTimers.get(region.uuid);
        if (activationTimer) clearTimeout(activationTimer);
        runtime.activationFinalizeTimers.delete(region.uuid);
        runtime.areaBoundaryBefore.delete(region.uuid);
        runtime.areaBoundarySnapshots.delete(region.uuid);
        runtime.effectiveOccupants.delete(region.uuid);
        const suppression = runtime.areaBoundarySuppression.get(region.uuid);
        if (suppression) clearTimeout(suppression.timer);
        runtime.areaBoundarySuppression.delete(region.uuid);
        if (!runtime.isAuthority() || runtime.endingZones.has(region.uuid)) return;
        const payload = runtime.readPayload(region);
        if (payload) {
          runtime.cleanupDeletedRegion(region, payload)
            .catch((e) => console.error("PF2e Zone deleted-region cleanup", e));
        }
      });

      /** Handles save and ping buttons through the request's persisted Token identity. */
      const clickHandler = async (event) => {
        const button = event.target?.closest?.("button[data-pf2e-zone-save], button[data-pf2e-zone-ping]");
        if (!button) return;
        event.preventDefault();

        const sceneId = button.dataset.sceneId;
        const regionId = button.dataset.regionId;
        const pendingId = button.dataset.pendingId;
        const saveType = button.dataset.saveType;
        const region = game.scenes.get(sceneId)?.regions.get(regionId);
        const payload = region ? runtime.readPayload(region) : null;
        const pending = payload?.state?.pendingSaves?.[pendingId];

        if (button.dataset.pf2eZonePing !== undefined) {
          const identifier = `${SAVE_PREFIX}:${sceneId}:${regionId}:${pendingId}`;
          const card = runtime.saveRequestMessageForPending({ identifier });
          const flag = card?.flags?.world?.pf2eZoneSaveRequest;
          const active = region && runtime.isOperational(region, payload) && pending?.identifier === identifier;
          const tokenUuid = active ? pending.tokenUuid
            : flag?.status === "completed" ? flag.tokenUuid : null;
          if (!tokenUuid) {
            ui.notifications.warn("This PF2e Zone save request is no longer active.");
            return;
          }
          button.disabled = true;
          try {
            await runtime.pingSaveTarget(sceneId, tokenUuid);
          } catch (error) {
            console.error("PF2e Zone: target ping failed", error);
            ui.notifications.error("PF2e Zone: target ping failed. See console.");
          } finally {
            button.disabled = false;
          }
          return;
        }

        if (!region || !runtime.isOperational(region, payload) || !pending) {
          ui.notifications.warn("This PF2e Zone save request is no longer active.");
          return;
        }

        if (!pending.saveTypes.includes(saveType)) return;

        const token = await fromUuid(pending.tokenUuid);
        const actor = token?.actor ?? (pending.actorUuid ? await fromUuid(pending.actorUuid) : null);
        if (!actor) {
          ui.notifications.error("PF2e Zone: the target actor for this save no longer exists.");
          return;
        }
        if (!game.user.isGM && !actor.isOwner) {
          ui.notifications.warn(`You do not own ${actor.name}; its owner or a GM must roll this save.`);
          return;
        }

        const statistic = actor.getStatistic?.(saveType);
        if (!statistic) {
          ui.notifications.error(`${actor.name} does not have a ${titleCaseLocal(saveType)} statistic.`);
          return;
        }
        const { actor: sourceActor } = await runtime.resolveSource(payload);
        const block = payload.config.effects?.find((b) => b.id === pending.blockId);
        const inflicts = block ? runtime.inflictedSlugs(block).map((s) => `inflicts:${s}`) : [];
        const options = [...new Set(["area-effect", ...(payload.config.traits ?? []), ...inflicts])];

        button.disabled = true;
        try {
          const roll = await statistic.roll({
            identifier: pending.identifier,
            token,
            origin: sourceActor,
            dc: { value: pending.dc },
            traits: payload.config.traits ?? [],
            extraRollOptions: options,
            title: `${payload.config.name}: ${pending.blockName}`
          });

          // PF2e's createChatMessage hook is the primary resolver because
          // it runs on the authoritative GM even when a player rolls.
          // The returned CheckRoll is retained only as a short fallback for
          // a GM-side roll in case a chat hook is missed.
          const rollIsTargetSave = roll?.options?.type === "saving-throw"
            && roll.options.identifier === pending.identifier
            && roll.options.rollerId === game.user.id;
          const outcome = rollIsTargetSave ? runtime.outcomeFromDegree(roll.degreeOfSuccess) : null;
          if (outcome && runtime.isAuthority()) {
            const lease = runtime.captureAuthorityLease();
            setTimeout(async () => {
              try {
                if (!runtime.authorityLeaseCurrent(lease)) return;
                const liveRegion = region.parent?.regions?.get?.(region.id);
                const fresh = liveRegion ? runtime.readPayload(liveRegion) : null;
                const stillPending = fresh?.state?.pendingSaves?.[pending.id];
                if (!runtime.isOperational(liveRegion, fresh) || !stillPending || stillPending.identifier !== pending.identifier) return;

                await runtime.resolvePendingSave(
                  liveRegion,
                  pending.id,
                  pending.identifier,
                  outcome,
                  actor.uuid,
                  null,
                  lease
                );
              } catch (error) {
                console.error("PF2e Zone: direct save-resolution fallback failed", error);
              }
            }, 250);
          }
        } catch (error) {
          console.error("PF2e Zone: save roll failed", error);
          ui.notifications.error("PF2e Zone: save roll failed. See console.");
        } finally {
          button.disabled = false;
        }
      };

      document.addEventListener("click", clickHandler);

      globalThis.PF2EZoneRuntimeHookRegistry = {
        version: VERSION,
        runtime: this,
        hookIds,
        clickHandler
      };
      this.hooksInstalled = true;
      for (const region of this.allZones()) {
        this.rememberAreaBoundary(region);
        this.rememberEffectiveOccupants(region)
          .catch((e) => console.error("PF2e Zone effective-occupant initialization", e));
      }

      // Startup and later active-GM changes use the exact same repair set.
      this.scheduleAuthorityRecovery("startup recovery");
    },
  };
}
