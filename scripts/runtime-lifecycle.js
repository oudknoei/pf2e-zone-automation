import { combatDurationDeadline } from "./duration-clock.js";
import { combatForZone } from "./scene-combat.js";
import { randomId } from "./utils.js";
import { nowWorld, stateKey } from "./runtime-helpers.js";

/** Owns Region activation, expiry, cleanup, and authority recovery on the composed runtime. */
export function createRegionLifecycleService() {
  return {
    endingZones: new Set(),

    endZonePromises: new Map(),

    regionReconcileTimers: new Map(),

    activationFinalizeTimers: new Map(),

    authorityRecovery: null,

    authorityRecoveryLease: null,

    authorityRecoveryTimer: null,

    /** Ignores disabled or hidden Region behaviors even if an older flag was never updated. */
    isRuntimeBehaviorActive(region) {
      if (region?.hidden) return false;
      if (!region?.behaviors) return true;
      const behaviors = Array.from(region.behaviors.contents ?? region.behaviors);
      return behaviors.some((behavior) => {
        const source = String(behavior?.system?.source ?? "");
        const belongsToModule = behavior?.name === "PF2e Zone Runtime"
          || (source.includes("pf2e-zone-automation") && source.includes("handleRegionEvent"));
        return belongsToModule && !behavior.disabled;
      });
    },

    /** Makes the persisted deactivation flag authoritative for every event source. */
    isOperational(region, payload = this.readPayload(region)) {
      return Boolean(payload && !payload.state?.deactivated && this.isRuntimeBehaviorActive(region));
    },

    /** Refreshes HP threshold baselines for every operational zone after authority changes. */
    async reconcileAllHpBaselines(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) {
        if (!this.isOperational(region)) continue;
        await this.withState(region, (payload) =>
          this.reconcileHpBaselinesUnlocked(region, payload, { replace: true }), lease);
      }
    },

    /** Resolves the stored source only when needed so a deleted source does not invalidate unrelated cleanup. */
    async resolveSource(payload) {
      const token = payload?.state?.sourceTokenUuid ? await fromUuid(payload.state.sourceTokenUuid) : null;
      const actor = token?.actor ?? (payload?.state?.sourceActorUuid ? await fromUuid(payload.state.sourceActorUuid) : null);
      return { token, actor };
    },

    /** Resolves an applied-effect record so cleanup can survive token and actor document changes. */
    async resolveTarget(record) {
      const token = record?.tokenUuid ? await fromUuid(record.tokenUuid) : null;
      const actor = token?.actor ?? (record?.actorUuid ? await fromUuid(record.actorUuid) : null);
      return { token, actor };
    },

    /** Removes cleanup records whose target Actor or embedded Item no longer exists. */
    async pruneStaleAppliedRecords(payload) {
      let changed = false;
      for (const [recordId, record] of Object.entries(payload?.state?.applied ?? {})) {
        let actor;
        try {
          ({ actor } = await this.resolveTarget(record));
        } catch (error) {
          console.warn("PF2e Zone: stale applied-record lookup failed", record, error);
          continue;
        }
        if (!actor) {
          delete payload.state.applied[recordId];
          changed = true;
          continue;
        }
        const item = actor.items?.get?.(record.itemId)
          ?? actor.items?.find?.((candidate) => candidate.id === record.itemId)
          ?? null;
        if (item || !actor.items) continue;
        delete payload.state.applied[recordId];
        changed = true;
      }
      return changed;
    },

    /** Prunes accumulated history and stale Item references after reloads or GM handoff. */
    async reconcileRuntimeHistory(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) {
        const snapshot = this.readPayload(region);
        const state = snapshot?.state;
        if (!state) continue;
        const hasHistory = Object.keys(state.damageRolls ?? {}).length
          || Object.keys(state.healingRolls ?? {}).length
          || Object.keys(state.resolvedSaves ?? {}).length
          || Object.keys(state.applied ?? {}).length;
        if (!hasHistory) continue;
        await this.withState(region, async (payload) => {
          this.pruneRuntimeHistory(payload);
          await this.pruneStaleAppliedRecords(payload);
        }, lease);
      }
    },

    /** Removes one deleted embedded Item from its owning Region's cleanup ledger. */
    async forgetDeletedAppliedItem(item, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !item?.id) return;
      const flag = this.zoneItemFlag(item);
      if (!flag?.zoneUuid) return;
      const region = await fromUuid(flag.zoneUuid);
      if (!this.isLiveRegion(region)) return;
      const actorUuid = item.actor?.uuid ?? item.parent?.uuid ?? null;
      await this.withState(region, (payload) => {
        for (const [recordId, record] of Object.entries(payload.state.applied ?? {})) {
          if (record.itemId !== item.id) continue;
          if (actorUuid && record.actorUuid && record.actorUuid !== actorUuid) continue;
          delete payload.state.applied[recordId];
        }
      }, lease);
    },

    /** Reconciles effects after a Token deletion, including all records owned by an unlinked synthetic Actor. */
    async reconcileDeletedToken(token, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !token?.uuid) return;
      const actorIsLinked = token.actorLink === true;
      const actorUuid = token.actor?.uuid ?? null;
      const failures = [];
      for (const region of this.allZones()) {
        try {
          const snapshot = this.readPayload(region);
          if (snapshot?.config?.mode === "emanation" && snapshot.state.sourceTokenUuid === token.uuid) {
            await this.endZone(region, "source token deleted", lease);
            continue;
          }

          const hasMatchingRecord = Object.values(snapshot?.state?.applied ?? {}).some((record) => actorIsLinked
            ? record.removal === "on-exit" && ((actorUuid && record.actorUuid === actorUuid) || record.tokenUuid === token.uuid)
            : record.tokenUuid === token.uuid
          );
          if (!hasMatchingRecord) continue;

          await this.withState(region, async (payload) => {
            if (actorIsLinked) {
              // The deleted Token may be only one of several scene
              // representations of this Actor. Re-evaluate the Actor's
              // remaining eligible occupancy before removing its Item.
              await this.cleanupExitedItemsUnlocked(region, payload);
              return;
            }
            for (const [recordId, record] of Object.entries(payload.state.applied)) {
              if (record.tokenUuid !== token.uuid) continue;
              // Deleting an unlinked Token also deletes its synthetic Actor
              // and every embedded Item, so only the stale record remains.
              delete payload.state.applied[recordId];
            }
          }, lease);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        throw new AggregateError(failures, `PF2e Zone: deleted Token cleanup failed for ${failures.length} zone(s).`);
      }
    },

    /** Reconciles records after Actor deletion because its embedded Items have already been removed by Foundry. */
    async reconcileDeletedActor(actor, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !actor?.uuid) return;
      const failures = [];
      try { await this.removeSharedImmunitiesForActor(actor.uuid, lease); }
      catch (error) { failures.push(error); }
      for (const region of this.allZones()) {
        try {
          const snapshot = this.readPayload(region);
          if (snapshot?.state?.sourceActorUuid === actor.uuid) {
            await this.endZone(region, "source actor deleted", lease);
            continue;
          }
          if (!Object.values(snapshot?.state?.applied ?? {}).some((record) => record.actorUuid === actor.uuid)) {
            continue;
          }
          await this.withState(region, (payload) => {
            for (const [recordId, record] of Object.entries(payload.state.applied)) {
              if (record.actorUuid === actor.uuid) delete payload.state.applied[recordId];
            }
          }, lease);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        throw new AggregateError(failures, `PF2e Zone: deleted Actor cleanup failed for ${failures.length} zone(s).`);
      }
    },

    /** Rechecks Actor occupancy when an application finishes after its initiating Token has left. */
    async cleanupTokenOnExitUnlocked(payload, tokenUuid, region = null) {
      if (region) {
        await this.cleanupExitedItemsUnlocked(region, payload);
        return;
      }
      // Preserve the helper's legacy targeted form for callers that already
      // know a specific Token has exited but do not have its Region document.
      const records = Object.entries(payload.state.applied)
        .filter(([, record]) => record.tokenUuid === tokenUuid && record.removal === "on-exit");
      for (const [recordId] of records) await this.deleteAppliedRecord(payload, recordId);
    },

    /** Collects all remaining zone-owned changes when a Region ends. */
    async cleanupZoneUnlocked(payload) {
      const records = Object.entries(payload.state.applied)
        .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
      const failures = [];
      for (const [recordId] of records) {
        try { await this.deleteAppliedRecord(payload, recordId); }
        catch (error) { failures.push(error); }
      }
      payload.state.pendingSaves = {};
      payload.state.recoveryWatchers = {};
      payload.state.deactivated = true;
      if (failures.length) {
        throw new AggregateError(failures, `PF2e Zone: ${failures.length} owned Item cleanup(s) failed: ${failures[0].message}`);
      }
    },

    /** Saves deactivation before deleting owned effects so later events see an inactive zone. */
    async deactivateRegion(region, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      const timer = this.activationFinalizeTimers.get(region.uuid);
      if (timer) clearTimeout(timer);
      this.activationFinalizeTimers.delete(region.uuid);
      await this.withState(region, (payload) => {
        payload.state.deactivated = true;
        payload.state.pendingSaves = {};
        payload.state.recoveryWatchers = {};
      }, lease);
      await this.withState(region, async (payload) => {
        // A rapid reactivation may have queued between these writes.
        if (payload.state.deactivated) await this.cleanupZoneUnlocked(payload);
      }, lease);
    },

    /** Repairs disabled zones created before deactivation was persisted. */
    async reconcileDisabledZones(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) {
        if (!this.isRuntimeBehaviorActive(region)) await this.deactivateRegion(region, lease);
      }
    },

    /** Retries dismissals whose Region and cleanup records survived an earlier failure. */
    async reconcileUnfinishedZoneEnds(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) {
        if (!this.readPayload(region)?.state?.endRequested) continue;
        try {
          await this.endZone(region, "retry unfinished cleanup", lease);
        } catch (_error) {
          // endZone retains the Region and reports the failure; another GM
          // startup or a manual dismissal can try again later.
        }
      }
    },

    /** Retries exit-bound Item removal after a missed or failed movement cleanup. */
    async reconcileUnfinishedExitCleanup(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) {
        const snapshot = this.readPayload(region);
        if (!this.isOperational(region, snapshot)) continue;
        if (!Object.values(snapshot.state.applied).some((record) => record.removal === "on-exit")) continue;
        try {
          await this.withState(region, async (payload) => {
            if (this.isOperational(region, payload)) await this.cleanupExitedItemsUnlocked(region, payload);
          }, lease);
        } catch (error) {
          console.error("PF2e Zone: exit cleanup retry failed", region, error);
          ui.notifications.error(`PF2e Zone: failed to remove an exited effect from '${region.name}'. See console.`);
        }
      }
    },

    /** Finishes cleanup when Foundry deletes a Region outside the normal end-zone path. */
    async cleanupDeletedRegion(region, payload, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      const records = Object.entries(payload?.state?.applied ?? {})
        .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
      const failures = [];
      for (const [, record] of records) {
        try {
          const { actor } = await this.resolveTarget(record);
          const item = actor?.items?.get(record.itemId);
          if (item) await this.deleteOwnedItem(item, "cleanup after Region deletion", lease);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) {
        throw new AggregateError(failures, `PF2e Zone: ${failures.length} owned Item cleanup(s) failed after Region deletion.`);
      }
    },

    /** Removes temporary Items only after every eligible Token for their Actor has left. */
    async cleanupExitedItemsUnlocked(region, payload, insideTokens = this.tokensInside(region)) {
      const eligibleTokenUuids = new Set();
      const eligibleActorUuids = new Set();
      for (const token of insideTokens) {
        if (!(await this.eligible(payload, token, region))) continue;
        eligibleTokenUuids.add(token.uuid);
        if (token.actor?.uuid) eligibleActorUuids.add(token.actor.uuid);
      }

      // Remove on-exit zone-owned data from tokens that are no longer both
      // inside and eligible. Linked Tokens share one Actor Item, so any
      // eligible representation of that Actor retains it. This also catches
      // alliance changes on a later reconcile and supports legacy records
      // that only contain a Token UUID.
      for (const [recordId, record] of Object.entries(payload.state.applied)) {
        if (record.removal !== "on-exit") continue;
        const retained = record.actorUuid
          ? eligibleActorUuids.has(record.actorUuid)
          : eligibleTokenUuids.has(record.tokenUuid);
        if (!retained) await this.deleteAppliedRecord(payload, recordId);
      }
    },

    /** Coalesces rapid Foundry updates so occupancy reconciliation does not run repeatedly for one change. */
    scheduleRegionReconcile(region, delay = 100) {
      const lease = this.captureAuthorityLease();
      if (!region?.parent?.id || !region?.id) return;
      const key = region.uuid;
      const prior = this.regionReconcileTimers.get(key);
      if (prior) clearTimeout(prior);

      const sceneId = region.parent.id;
      const regionId = region.id;
      const timer = setTimeout(async () => {
        this.regionReconcileTimers.delete(key);
        if (!this.authorityLeaseCurrent(lease)) return;
        const liveRegion = game.scenes.get(sceneId)?.regions.get(regionId);
        if (!liveRegion) return;
        try {
          await this.withState(liveRegion, async (payload) => {
            if (!this.isOperational(liveRegion, payload)) return;
            await this.reconcileContinuousUnlocked(liveRegion, payload);
          }, lease);
        } catch (error) {
          console.error("PF2e Zone: Region movement reconcile failed", error);
        }
      }, Math.max(0, Number(delay) || 0));

      this.regionReconcileTimers.set(key, timer);
    },

    /** Handles initial occupants once so activation effects cannot be duplicated by Foundry membership reconciliation. */
    async processActivationTokenUnlocked(region, payload, token, batchSeed = randomId()) {
      if (payload.state.activationProcessed) return;
      if (!(await this.eligible(payload, token, region))) return;

      for (const block of payload.config.effects ?? []) {
        if (!block.triggers?.activation) continue;
        const key = stateKey("activation", block.id, token.uuid);
        if (payload.state.activationTargets[key]) continue;

        // Mark only after the block successfully begins processing. For saves,
        // requestSave() creates the pending workflow before returning.
        let count = 0;
        for (const candidate of this.tokensInside(region)) {
          if (!(await this.eligible(payload, candidate, region))) continue;
          if (this.isImmuneFor(payload, candidate, block)) continue;
          if (this.repeatBlocked(payload, candidate.uuid, block)) continue;
          count += 1;
        }

        await this.processBlock(
          region,
          payload,
          block,
          token,
          "activation",
          `activation:${block.id}:${batchSeed}`,
          { eventContext: { count: Math.max(1, count) } }
        );
        payload.state.activationTargets[key] = true;
      }
    },

    /** Lets a new authoritative GM finish an activation at its original wall-clock deadline. */
    scheduleActivationFinalization(region, deadline, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !this.isLiveRegion(region) || this.activationFinalizeTimers.has(region.uuid)) return;
      const delay = Math.max(0, Number(deadline) - Date.now());
      const timer = setTimeout(async () => {
        this.activationFinalizeTimers.delete(region.uuid);
        if (!this.authorityLeaseCurrent(lease) || !this.isLiveRegion(region)) return;
        try {
          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload) || payload.state.activationProcessed) return;

            // Final sweep after Region membership has had time to settle.
            const batchSeed = randomId();
            for (const token of this.tokensInside(region)) {
              await this.processActivationTokenUnlocked(region, payload, token, batchSeed);
            }

            payload.state.activationProcessed = true;
            payload.state.activationPending = false;
            delete payload.state.activationFinalizeAt;
            payload.state.initialOccupants = {};
          }, lease);
        } catch (error) {
          console.error("PF2e Zone: activation finalization failed", error);
        }
      }, Number.isFinite(delay) ? delay : 0);
      this.activationFinalizeTimers.set(region.uuid, timer);
    },

    /** Rebuilds lost activation timers after startup or a change of authoritative GM. */
    async reconcileUnfinishedActivations(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) {
        const payload = this.readPayload(region);
        if (!this.isOperational(region, payload) || payload.state.activationProcessed) continue;
        await this.activateRegion(region, lease);
      }
    },

    /** Initializes a newly created Region before delayed hooks can process its occupants. */
    async activateRegion(region, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !this.isRuntimeBehaviorActive(region)) return;
      if (!this.areaBoundarySnapshots.has(region.uuid)) this.rememberAreaBoundary(region);

      // A behavior may be re-enabled after its old deadline passed. Check
      // expiration before maintained effects are applied again.
      if (this.readPayload(region)?.state?.deactivated) {
        await this.withState(region, (payload) => { payload.state.deactivated = false; }, lease);
        await this.checkSourceAndDuration(region, lease);
        if (!this.isLiveRegion(region)) return;
      }

      // Foundry can finish Region membership asynchronously after the Region
      // document itself exists. Keep an activation grace window open so the
      // initial tokenEnter events can still count as "inside on activation."
      const finalizationAt = await this.withState(region, async (payload) => {
        this.reconcileHpBaselinesUnlocked(region, payload);
        if (!payload.state.activationProcessed) {
          payload.state.activationPending = true;
          const batchSeed = randomId();
          const activationTokens = this.tokensInside(region);
          const activationBlocks = (payload.config.effects ?? []).filter((b) => b.triggers?.activation);

          for (const token of activationTokens) {
            payload.state.initialOccupants[stateKey("initial", token.uuid)] = true;
          }

          console.info("PF2e Zone activation", {
            zone: payload.config.name,
            region: region.uuid,
            activationBlocks: activationBlocks.map((b) => b.name),
            inside: activationTokens.map((t) => t.name)
          });

          // Process tokens using Foundry's authoritative containment test.
          for (const token of activationTokens) {
            await this.processActivationTokenUnlocked(region, payload, token, batchSeed);
          }

          // Persist the deadline, while timer ownership stays in this client.
          // A reconnect resumes the remaining wait instead of opening a
          // fresh grace window or trusting a stale "scheduled" flag.
          if (!Number.isFinite(payload.state.activationFinalizeAt)) {
            payload.state.activationFinalizeAt = Date.now() + 1000;
          }
        }

        payload.state.deactivated = false;
        await this.reconcileContinuousUnlocked(region, payload);
        return payload.state.activationProcessed ? null : payload.state.activationFinalizeAt;
      }, lease);

      if (finalizationAt != null) this.scheduleActivationFinalization(region, finalizationAt, lease);
    },

    /** Ends a finite zone at its stored combat deadline even when intermediate turn hooks were missed. */
    async checkSourceAndDuration(region, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      let shouldEnd = false;
      await this.withState(region, async (payload) => {
        if (!this.isOperational(region, payload)) return;
        this.syncImmunityCombatClock(payload);
        const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
        if (payload.config.mode === "emanation" && (!sourceToken || !sourceActor)) {
          shouldEnd = true;
          return;
        }

        // Formula durations are resolved once at creation and never rolled again.
        const rounds = this.durationRounds(payload.config, payload.state);
        if (!rounds) return;
        const d = payload.state.duration;
        d.rounds ??= rounds;
        if (!Number.isFinite(d.worldExpires)) {
          d.worldExpires = Number(payload.state.createdWorldTime ?? nowWorld()) + rounds * 6;
        }
        const worldExpired = nowWorld() >= d.worldExpires;

        const { combat = null, sourceCombatant = null } = combatForZone({
          sceneId: region.parent?.id,
          sourceTokenUuid: payload.state.sourceTokenUuid,
          sourceActorUuid: payload.state.sourceActorUuid,
          recordedCombatId: d.combatId
        }) ?? {};
        if (!combat) {
          shouldEnd = worldExpired;
          return;
        }
        const currentRound = Number(combat.round ?? 0);

        if (d.combatId !== combat.id) {
          // A new encounter cannot reuse the old encounter's round number.
          // Preserve the lesser of the remaining world time and the last
          // observed combat progress rather than restarting the duration.
          if (worldExpired) {
            shouldEnd = true;
            return;
          }
          const worldRemaining = Math.ceil((d.worldExpires - nowWorld()) / 6);
          const combatRemaining = Number.isSafeInteger(d.combatExpiresAtRound)
            && Number.isSafeInteger(d.lastObservedRound)
            ? Math.max(0, d.combatExpiresAtRound - d.lastObservedRound)
            : Math.max(0, rounds - Number(d.sourceTurnsElapsed ?? 0));
          const remaining = Math.min(worldRemaining, combatRemaining);
          if (remaining <= 0) {
            shouldEnd = true;
            return;
          }
          Object.assign(d, combatDurationDeadline(combat, sourceCombatant, remaining));
        } else if (!Number.isSafeInteger(d.combatExpiresAtRound)) {
          // Older zones have no deadline. Recover it from their last
          // observed source turn when possible, then persist the result.
          const turnKey = String(d.lastSourceTurnKey ?? "");
          const parts = turnKey.startsWith(`${combat.id}:`) ? turnKey.split(":") : [];
          const lastRound = Number(parts.at(-3));
          const elapsed = Math.max(0, Number(d.sourceTurnsElapsed ?? 0));
          if (parts.length >= 4 && Number.isSafeInteger(lastRound)) {
            d.combatExpiresAtRound = lastRound + Math.max(0, rounds - elapsed);
            d.lastObservedRound ??= lastRound;
          } else {
            Object.assign(d, combatDurationDeadline(combat, sourceCombatant, Math.max(1, rounds - elapsed)));
          }
        }

        d.sourceCombatantId = sourceCombatant?.id ?? null;
        d.lastObservedRound = Math.max(Number(d.lastObservedRound ?? currentRound), currentRound);
        const deadline = d.combatExpiresAtRound;

        if (currentRound > deadline) {
          shouldEnd = true;
        } else if (currentRound === deadline) {
          const sourceTurn = Array.isArray(combat.turns)
            ? combat.turns.findIndex((entry) => entry.id === sourceCombatant?.id)
            : -1;
          shouldEnd = !sourceCombatant
            || (sourceTurn >= 0 && Number(combat.turn ?? -1) >= sourceTurn)
            || combat.combatant?.id === sourceCombatant.id;
        } else if (!sourceCombatant && worldExpired) {
          // Without a source turn, either elapsed clock may end the zone.
          shouldEnd = true;
        }
      }, lease);
      if (shouldEnd && this.authorityLeaseCurrent(lease) && this.isOperational(region)) await this.endZone(region, "duration/source", lease);
    },

    /** Lets world-time and combat changes reevaluate every active finite zone. */
    async checkAllDurations(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) await this.checkSourceAndDuration(region, lease);
      await this.reconcileSharedImmunities({ cancelPending: false }, lease);
    },

    /** Leaves a retryable Region when owned Items or Region deletion fails. */
    async endZone(region, reason = "ended", lease = null) {
      if (!this.authorityLeaseCurrent(lease)) return;
      const scene = region?.parent;
      const regionId = region?.id;
      if (!scene || !regionId) return;

      // A stale document is already gone; simultaneous requests share one result.
      const liveRegion = scene.regions?.get?.(regionId);
      if (!liveRegion) return;
      const key = liveRegion.uuid;
      const pendingEnd = this.endZonePromises.get(key);
      if (pendingEnd) return pendingEnd;

      this.endingZones.add(key);
      const reconcileTimer = this.regionReconcileTimers.get(key);
      if (reconcileTimer) clearTimeout(reconcileTimer);
      this.regionReconcileTimers.delete(key);
      const activationTimer = this.activationFinalizeTimers.get(key);
      if (activationTimer) clearTimeout(activationTimer);
      this.activationFinalizeTimers.delete(key);

      const ending = (async () => {
        let cleanupPayload = null;
        let cleanupComplete = false;
        try {
          // Drain accepted work before marking the Region inactive. While
          // endingZones holds the key, no new state work can start.
          const pendingState = this.locks.get(key);
          if (pendingState) await pendingState.catch(() => undefined);
          if (!this.authorityLeaseCurrent(lease)) return;

          const current = scene.regions?.get?.(regionId);
          if (!current) return;
          cleanupPayload = this.bindAuthorityLease(this.readPayload(current), lease);
          if (cleanupPayload) {
            cleanupPayload.state.deactivated = true;
            cleanupPayload.state.endRequested = true;
            cleanupPayload.state.pendingSaves = {};
            cleanupPayload.state.recoveryWatchers = {};
            // Persist the retry marker before any Item deletion. If cleanup
            // stops halfway, the Region stays quiet and startup can retry.
            await this.writePayload(current, cleanupPayload);
            if (!this.authorityLeaseCurrent(lease)) return;
            await this.cleanupZoneUnlocked(cleanupPayload);
          }
          cleanupComplete = true;

          const stillLive = scene.regions?.get?.(regionId);
          if (!this.authorityLeaseCurrent(lease)) return;
          if (stillLive) await stillLive.delete();
          if (scene.regions?.get?.(regionId)) {
            throw new Error(`PF2e Zone: Region '${liveRegion.name}' was not deleted.`);
          }
        } catch (error) {
          const remaining = scene.regions?.get?.(regionId);
          if (!remaining && cleanupComplete) return;
          if (remaining && cleanupPayload) {
            try {
              // Persist completed deletions; records for failed deletions
              // remain, and the endRequested marker survives a reconnect.
              await this.writePayload(remaining, cleanupPayload);
            } catch (persistError) {
              console.error("PF2e Zone: failed to save unfinished cleanup", remaining, persistError);
            }
          }
          console.error(`PF2e Zone: failed to end zone (${reason})`, liveRegion, error);
          ui.notifications.error(`PF2e Zone: failed to end '${liveRegion.name}'. See console.`);
          throw error;
        }
      })();
      this.endZonePromises.set(key, ending);
      try {
        return await ending;
      } finally {
        this.endZonePromises.delete(key);
        this.endingZones.delete(key);
      }
    },

    /** Ends condition-linked cleanup watches when actors change outside a zone event. */
    async reconcileActorDependencies(actor, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !actor) return;

      // Linked-condition cleanup is stored on the owned condition itself so
      // it still works if the originating Region has already ended, as long
      // as the runtime is active in the world/client session.
      const toDelete = actor.items.filter((item) => {
        const flag = this.zoneItemFlag(item);
        if (item.type !== "condition" || flag?.removal !== "condition-end" || !flag.linkedCondition) return false;
        const linked = actor.conditions?.bySlug?.(flag.linkedCondition, { active: true }) ?? [];
        return linked.length === 0;
      });
      for (const item of toDelete) {
        await this.deleteOwnedItem(item, "linked-condition cleanup", lease);
      }

      for (const region of this.allZones()) {
        const snapshot = this.readPayload(region);
        if (!this.isOperational(region, snapshot)) continue;
        if (!Object.values(snapshot.state.recoveryWatchers ?? {})
          .some((watcher) => watcher.actorUuid === actor.uuid)) continue;
        await this.withState(region, async (payload) => {
          if (!this.isOperational(region, payload)) return;
          for (const [key, watcher] of Object.entries(payload.state.recoveryWatchers)) {
            if (watcher.actorUuid !== actor.uuid) continue;
            if (watcher.itemId) {
              const watched = actor.items?.get?.(watcher.itemId)
                ?? actor.items?.find?.((item) => item.id === watcher.itemId);
              if (watched) continue;
            } else {
              // Legacy watchers did not persist an Item identity, so retain
              // their broader slug-based behavior until they are consumed.
              const remaining = actor.conditions?.bySlug?.(watcher.condition, { active: true }) ?? [];
              if (remaining.length) continue;
            }
            const block = payload.config.effects?.find((b) => b.id === watcher.blockId);
            if (block) this.setImmunity(
              payload,
              watcher.tokenUuid,
              block,
              watcher.actorUuid ?? actor.uuid,
              region.uuid
            );
            delete payload.state.recoveryWatchers[key];
          }
        }, lease);
      }
    },

    /** Repairs condition-based cleanup after reloads or broad actor updates. */
    async reconcileAllLinkedConditions(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      const actors = new Set(game.actors.contents);
      for (const scene of game.scenes?.contents ?? game.scenes ?? []) {
        for (const token of scene.tokens ?? []) if (token.actor) actors.add(token.actor);
      }
      for (const actor of actors) {
        if (actor.items.some((i) => this.zoneItemFlag(i)?.removal === "condition-end")) {
          await this.reconcileActorDependencies(actor, lease);
        }
      }
    },

    /** Repairs temporary owned Items after an externally deleted Region lost its cleanup record. */
    async reconcileOrphanedZoneItems(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      const actors = new Set(game.actors?.contents ?? []);
      for (const scene of game.scenes?.contents ?? game.scenes ?? []) {
        for (const token of scene.tokens?.values?.() ?? scene.tokens ?? []) {
          if (token.actor) actors.add(token.actor);
        }
      }
      for (const actor of actors) {
        for (const item of [...(actor.items?.values?.() ?? actor.items ?? [])]) {
          const flag = this.zoneItemFlag(item);
          if (!flag?.zoneUuid || !["on-exit", "zone-end"].includes(flag.removal)) continue;
          try {
            const region = await fromUuid(flag.zoneUuid);
            if (region?.parent?.regions?.get?.(region.id)) continue;
            await this.deleteOwnedItem(item, "orphaned zone Item cleanup", lease);
          } catch (error) {
            console.error("PF2e Zone: orphaned Item cleanup failed", item, error);
            ui.notifications.error(`PF2e Zone: failed to remove an orphaned effect from ${actor.name}. See console.`);
          }
        }
      }
    },

    /** Runs the complete startup repair set once for concurrent active-GM handoff signals. */
    async reconcileAuthorityState(reason = "authority recovery", lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      if (this.authorityRecovery && this.authorityLeaseCurrent(this.authorityRecoveryLease)) return await this.authorityRecovery;

      const recovery = Promise.resolve().then(async () => {
        const steps = [
          ["linked conditions", () => this.reconcileAllLinkedConditions(lease)],
          ["orphaned Items", () => this.reconcileOrphanedZoneItems(lease)],
          ["shared immunities", () => this.reconcileSharedImmunities(undefined, lease)],
          ["runtime history", () => this.reconcileRuntimeHistory(lease)],
          ["unfinished zone ends", () => this.reconcileUnfinishedZoneEnds(lease)],
          ["disabled zones", () => this.reconcileDisabledZones(lease)],
          ["unfinished exit cleanup", () => this.reconcileUnfinishedExitCleanup(lease)],
          ["completed saves", () => this.reconcileCompletedSaves(lease)],
          ["save delivery", () => this.reconcileUndeliveredSaveRequests(lease)],
          ["durations", () => this.checkAllDurations(lease)],
          ["unfinished activations", () => this.reconcileUnfinishedActivations(lease)],
          ["HP baselines", () => this.reconcileAllHpBaselines(lease)]
        ];

        for (const [label, run] of steps) {
          if (!this.authorityLeaseCurrent(lease)) return;
          try {
            await run();
          } catch (error) {
            console.error(`PF2e Zone: ${reason} ${label} failed`, error);
          }
        }
      });
      this.authorityRecovery = recovery;
      this.authorityRecoveryLease = lease;
      try {
        return await recovery;
      } finally {
        if (this.authorityRecovery === recovery) this.authorityRecovery = null;
      }
    },

    /** Debounces Foundry user hooks before starting the serialized authority recovery pass. */
    scheduleAuthorityRecovery(reason = "authority recovery") {
      if (this.authorityRecoveryTimer !== null) return;
      this.authorityRecoveryTimer = setTimeout(() => {
        this.authorityRecoveryTimer = null;
        this.reconcileAuthorityState(reason)
          .catch((error) => console.error(`PF2e Zone: ${reason} coordinator failed`, error));
      }, 0);
    },
  };
}
