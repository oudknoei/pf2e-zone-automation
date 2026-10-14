import { cloneData as clone } from "./utils.js";
import { MODULE_ID, SHARED_IMMUNITIES_SETTING, FLAG_SCOPE, FLAG_KEY } from "./runtime-constants.js";
import { stateKey, dataSignature } from "./runtime-helpers.js";

/** Owns Region payload transactions, retained history, and shared-state serialization on the composed runtime. */
export function createRegionStateService() {
  return {
    locks: new Map(),

    sharedImmunityCache: {},

    sharedImmunityWrite: null,

    sharedResolutionLocks: new Map(),

    /** Normalizes persisted state on read so older zones can participate in newer runtime behavior. */
    readPayload(region) {
      const raw = region?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
      if (!raw || typeof raw !== "object") return null;
      const payload = clone(raw);
      payload.state ??= {};
      payload.state.pendingSaves ??= {};
      for (const pending of Object.values(payload.state.pendingSaves)) {
        if (!pending || typeof pending !== "object") continue;
        if (!pending.delivery || typeof pending.delivery !== "object") pending.delivery = {};
        pending.delivery.status = pending.delivery.status === "delivered" ? "delivered" : "undelivered";
        pending.delivery.attempts = Number.isSafeInteger(pending.delivery.attempts)
          ? Math.max(0, pending.delivery.attempts) : 0;
        pending.delivery.messageId ??= null;
        pending.delivery.lastAttemptWorldTime ??= null;
        pending.delivery.lastError ??= null;
      }
      payload.state.resolvedSaves ??= {};
      payload.state.repeat ??= {};
      payload.state.hpObserved ??= {};
      payload.state.immunities ??= {};
      payload.state.applied ??= {};
      payload.state.damageRolls ??= {};
      payload.state.healingRolls ??= {};
      payload.state.recoveryWatchers ??= {};
      payload.state.turnStartEvents ??= {};
      payload.state.activation ??= {};
      payload.state.activationTargets ??= {};
      payload.state.initialOccupants ??= {};
      payload.state.activationPending ??= !payload.state.activationProcessed;
      // Older Regions stored a timer flag that cannot survive a GM refresh.
      delete payload.state.activationFinalizeScheduled;
      payload.state.duration ??= {};
      payload.state.lastSourceTriggerTurnKey ??= null;
      return payload;
    },

    /** Avoids persisting cleanup state to a Region that was deleted during an asynchronous action. */
    isLiveRegion(region) {
      const scene = region?.parent;
      return Boolean(scene?.regions?.get?.(region.id));
    },

    /** Replaces runtime state atomically so removed saves, immunities, and effects do not reappear after a merge. */
    async writePayload(region, payload) {
      if (!this.payloadAuthorityCurrent(payload) || !this.isLiveRegion(region)) return false;

      this.pruneRuntimeHistory(payload);
      const current = region.getFlag?.(FLAG_SCOPE, FLAG_KEY);
      if (current && dataSignature(current) === dataSignature(payload)) return true;

      const path = `flags.${FLAG_SCOPE}.${FLAG_KEY}`;
      /** Recognizes deletion races so a completed zone cleanup is not reported as an actionable error. */
      const staleRegionError = (error) =>
        !this.isLiveRegion(region) && /does not exist|not found/i.test(String(error?.message ?? error));

      try {
        // Foundry document updates recursively merge objects by default.
        // That is wrong for our runtime state because deleting a pending
        // save/immunity/applied-record from the local object must also delete
        // it from the persisted Region flag. V14's _replace operator makes
        // this payload an authoritative snapshot.
        if (typeof globalThis._replace === "function") {
          await region.update({ [path]: globalThis._replace(payload) });
          return true;
        }

        // Defensive fallback for an unexpected V14 build where the documented
        // global operator is unavailable. Slower, but preserves replacement
        // semantics rather than silently merging stale runtime keys.
        await region.unsetFlag(FLAG_SCOPE, FLAG_KEY);
        if (!this.payloadAuthorityCurrent(payload) || !this.isLiveRegion(region)) return false;
        await region.setFlag(FLAG_SCOPE, FLAG_KEY, payload);
        return true;
      } catch (error) {
        // A manually deleted Region can disappear between the live-document
        // check and Foundry receiving the update. Its state no longer needs
        // persistence, so treat that lifecycle race as a completed write.
        if (staleRegionError(error)) return false;
        throw error;
      }
    },

    /** Retains roll and save history only while an unanswered save can still consume it. */
    pruneRuntimeHistory(payload) {
      const state = payload?.state;
      if (!state) return false;
      let changed = false;
      const pendingEntries = Object.entries(state.pendingSaves ?? {})
        .filter(([, entry]) => entry && typeof entry === "object");
      const pending = pendingEntries.map(([, entry]) => entry);
      const pendingById = new Map(pendingEntries);
      const damageKeys = new Set();
      const healingKeys = new Set();
      const hasUnscopedPending = pending.some((entry) => !entry.blockId || !entry.batchId);
      for (const entry of pending) {
        if (!entry.blockId || !entry.batchId) continue;
        damageKeys.add(stateKey("damage", entry.blockId, entry.batchId));
        healingKeys.add(stateKey("healing", entry.blockId, entry.batchId));
      }

      for (const key of Object.keys(state.damageRolls ?? {})) {
        if (hasUnscopedPending || damageKeys.has(key)) continue;
        delete state.damageRolls[key];
        changed = true;
      }
      for (const key of Object.keys(state.healingRolls ?? {})) {
        if (hasUnscopedPending || healingKeys.has(key)) continue;
        delete state.healingRolls[key];
        changed = true;
      }
      for (const [pendingId, record] of Object.entries(state.resolvedSaves ?? {})) {
        const unresolved = pendingById.get(pendingId);
        if (unresolved?.identifier === record?.identifier) continue;
        delete state.resolvedSaves[pendingId];
        changed = true;
      }
      return changed;
    },

    /** Defers outward side effects until their state record is safely persisted. */
    queueAfterCommit(payload, callback) {
      if (!payload || typeof callback !== "function") return;
      if (!Object.prototype.hasOwnProperty.call(payload, "__pf2eZoneAfterCommit")) {
        Object.defineProperty(payload, "__pf2eZoneAfterCommit", {
          value: [],
          enumerable: false,
          configurable: true,
          writable: false
        });
      }
      payload.__pf2eZoneAfterCommit.push(callback);
    },

    /** Serializes updates to one Region so simultaneous hooks cannot overwrite each other. */
    async withState(region, callback, lease = this.captureAuthorityLease()) {
      if (!region?.uuid || !this.authorityLeaseCurrent(lease)) return null;
      const key = region.uuid;

      // endZone waits for work that was already accepted, but must not start
      // another Region update once deletion has begun.
      if (this.endingZones.has(key)) return null;

      const prior = this.locks.get(key) ?? Promise.resolve();
      /** Chains work after an earlier state update even if that earlier update failed. */
      const next = prior.catch(() => undefined).then(async () => {
        if (!this.authorityLeaseCurrent(lease) || !this.isLiveRegion(region)) return null;
        const payload = this.bindAuthorityLease(this.readPayload(region), lease);
        if (!payload) return null;

        const result = await callback(payload);
        const afterCommit = [...(payload.__pf2eZoneAfterCommit ?? [])];

        // Commit the Region state first. Anything that exposes user actions
        // (notably a clickable save request) runs only after this completes,
        // so a fast click cannot be overwritten by the originating event's
        // stale payload snapshot.
        if (!this.authorityLeaseCurrent(lease)) return null;
        if (!this.isLiveRegion(region)) return result;
        const persisted = await this.writePayload(region, payload);
        if (!this.authorityLeaseCurrent(lease)) return null;
        if (!persisted || !this.isLiveRegion(region)) return result;

        for (const action of afterCommit) {
          if (!this.authorityLeaseCurrent(lease)) return null;
          try {
            await action();
          } catch (error) {
            console.error("PF2e Zone: post-commit action failed", error);
          }
        }

        return this.authorityLeaseCurrent(lease) ? result : null;
      });
      this.locks.set(key, next);
      try {
        return await next;
      } finally {
        if (this.locks.get(key) === next) this.locks.delete(key);
      }
    },

    /** Limits scans to Regions created by this module instead of inspecting unrelated Scene automation. */
    allZones() {
      const scenes = game.scenes?.contents ?? game.scenes ?? [];
      return Array.from(scenes).flatMap((scene) =>
        Array.from(scene.regions?.values?.() ?? scene.regions ?? [])
          .filter((region) => Boolean(region?.getFlag?.(FLAG_SCOPE, FLAG_KEY)))
      );
    },

    /** Reads hidden world state while retaining a no-setting fallback for tests and startup edges. */
    readSharedImmunities() {
      let stored = {};
      try {
        const value = game.settings?.get?.(MODULE_ID, SHARED_IMMUNITIES_SETTING);
        if (value && typeof value === "object" && !Array.isArray(value)) stored = clone(value);
      } catch (_error) { /* setting is not registered in lightweight test contexts */ }
      return { ...stored, ...clone(this.sharedImmunityCache ?? {}) };
    },

    /** Serializes world-setting replacement so two Regions cannot overwrite each other's grants. */
    async mutateSharedImmunities(mutator, lease = this.captureAuthorityLease()) {
      const prior = this.sharedImmunityWrite ?? Promise.resolve();
      const next = prior.catch(() => undefined).then(async () => {
        if (!this.authorityLeaseCurrent(lease)) return null;
        const records = this.readSharedImmunities();
        const before = dataSignature(records);
        const result = await mutator(records);
        if (!this.authorityLeaseCurrent(lease)) return null;
        const changed = before !== dataSignature(records);
        if (changed && game.settings?.set) {
          await game.settings.set(MODULE_ID, SHARED_IMMUNITIES_SETTING, records);
        }
        if (!this.authorityLeaseCurrent(lease)) return null;
        this.sharedImmunityCache = clone(records);
        return result;
      });
      this.sharedImmunityWrite = next;
      try {
        return await next;
      } finally {
        if (this.sharedImmunityWrite === next) this.sharedImmunityWrite = null;
      }
    },

    /** Prevents concurrent save outcomes for one Actor/group from passing each other. */
    async withSharedResolutionLock(key, callback) {
      if (!key) return await callback();
      const prior = this.sharedResolutionLocks.get(key) ?? Promise.resolve();
      const next = prior.catch(() => undefined).then(callback);
      this.sharedResolutionLocks.set(key, next);
      try {
        return await next;
      } finally {
        if (this.sharedResolutionLocks.get(key) === next) this.sharedResolutionLocks.delete(key);
      }
    },
  };
}
