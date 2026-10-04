import { actorStatisticDc } from "./dc.js";
import { combatDurationDeadline } from "./duration-clock.js";
import { combatForZone, combatForZoneState, recordedCombatForZoneState } from "./scene-combat.js";
import { sweptAreaIntersectsToken, tokenBounds, translatedAreaShapes } from "./area-shape.js";
import { actorHitPoints, crossedHpThreshold } from "./hp-threshold.js";
import { hasLineOfEffect, tokenCenter, zoneOrigin } from "./line-of-effect.js";

// Zone runtime extracted from PF2e Zone Builder v0.5.15.
/** Provides one module runtime that both Foundry hooks and existing Region behaviors can call after updates. */
export async function zoneRuntimeEntrypoint(explicitContext = null) {

    const VERSION = "0.5.19";
    const FLAG_SCOPE = "world";
    const FLAG_KEY = "pf2eZone";
    const SAVE_PREFIX = "pf2e-zone";
    const fu = foundry.utils;

    /** Prevents reads of persisted zone flags from mutating the data that Foundry still owns. */
    const clone = (obj) => {
      if (globalThis.structuredClone) return structuredClone(obj);
      return JSON.parse(JSON.stringify(obj));
    };

    /** Keeps actor, item, and zone text from changing chat card markup. */
    const escHtml = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    /** Makes stored slugs readable in player-facing alerts without changing their data identity. */
    const titleCaseLocal = (slug) => String(slug ?? "")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());

    /** Creates durable keys when Foundry does not supply an identifier for a runtime event. */
    const randomId = () => fu.randomID?.(12) ?? crypto.randomUUID().slice(0, 12);
    /** Uses shared world time so duration decisions remain consistent across connected clients. */
    const nowWorld = () => Number(game.time?.worldTime ?? 0);
    /** Builds safe flag keys from document identifiers that may contain punctuation. */
    const stateKey = (...parts) => parts
      .map((part) => String(part ?? "").replace(/[^A-Za-z0-9_-]/g, "_"))
      .join("__");

    /** Produces an order-independent signature for JSON-compatible persisted flag data. */
    const dataSignature = (value) => JSON.stringify(value, (_key, nested) => {
      if (!nested || Array.isArray(nested) || typeof nested !== "object") return nested;
      return Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]));
    });

    /** Allows saved zones to be migrated safely when runtime behavior changes between releases. */
    const compareVersions = (a, b) => {
      const pa = String(a ?? "0").split(".").map((n) => Number(n) || 0);
      const pb = String(b ?? "0").split(".").map((n) => Number(n) || 0);
      const length = Math.max(pa.length, pb.length);
      for (let i = 0; i < length; i++) {
        const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (delta) return Math.sign(delta);
      }
      return 0;
    };

    /** Keeps all transient locks and hooks together so one client runtime can manage a scene coherently. */
    function createRuntime() {
      const rt = {
        version: VERSION,
        locks: new Map(),
        hooksInstalled: false,
        endingZones: new Set(),
        deletingItems: new Set(),
        itemDeletePromises: new Map(),
        endZonePromises: new Map(),
        chatAlertBatches: new Set(),
        regionReconcileTimers: new Map(),
        activationFinalizeTimers: new Map(),
        areaBoundaryBefore: new Map(),
        areaBoundarySnapshots: new Map(),
        areaBoundarySuppression: new Map(),
        effectiveOccupants: new Map(),
        saveDeliveryRecovery: null,
        authorityRecovery: null,
        authorityRecoveryTimer: null,

        /** Ensures only one active GM applies effects when every client receives the same Foundry event. */
        isAuthority() {
          const activeGM = game.users?.activeGM ?? null;
          return activeGM ? activeGM.id === game.user.id : Boolean(game.user?.isGM);
        },

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

        /** Avoids persisting cleanup state to a Region that was deleted during an asynchronous action. */
        isLiveRegion(region) {
          const scene = region?.parent;
          return Boolean(scene?.regions?.get?.(region.id));
        },

        /** Replaces runtime state atomically so removed saves, immunities, and effects do not reappear after a merge. */
        async writePayload(region, payload) {
          if (!this.isLiveRegion(region)) return false;

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
            if (!this.isLiveRegion(region)) return false;
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
        async withState(region, callback) {
          if (!region?.uuid) return null;
          const key = region.uuid;

          // endZone waits for work that was already accepted, but must not start
          // another Region update once deletion has begun.
          if (this.endingZones.has(key)) return null;

          const prior = this.locks.get(key) ?? Promise.resolve();
          /** Chains work after an earlier state update even if that earlier update failed. */
          const next = prior.catch(() => undefined).then(async () => {
            if (!this.isLiveRegion(region)) return null;
            const payload = this.readPayload(region);
            if (!payload) return null;

            const result = await callback(payload);
            const afterCommit = [...(payload.__pf2eZoneAfterCommit ?? [])];

            // Commit the Region state first. Anything that exposes user actions
            // (notably a clickable save request) runs only after this completes,
            // so a fast click cannot be overwritten by the originating event's
            // stale payload snapshot.
            if (!this.isLiveRegion(region)) return result;
            const persisted = await this.writePayload(region, payload);
            if (!persisted || !this.isLiveRegion(region)) return result;

            for (const action of afterCommit) {
              try {
                await action();
              } catch (error) {
                console.error("PF2e Zone: post-commit action failed", error);
              }
            }

            return result;
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

        /** Uses Region membership as the source of truth for occupants instead of token geometry guesses. */
        tokensInside(region) {
          const scene = region?.parent;
          if (!scene?.tokens) return [...(region?.tokens ?? [])];

          const inside = [];
          for (const token of scene.tokens) {
            try {
              // Foundry V14's authoritative Token/Region containment test.
              // This is preferable to waiting for RegionDocument.tokens to
              // finish synchronizing immediately after Region creation.
              if (typeof token.testInsideRegion === "function" && token.testInsideRegion(region)) {
                inside.push(token);
              } else if (region.tokens?.has?.(token)) {
                inside.push(token);
              }
            } catch (error) {
              console.warn("PF2e Zone: Region containment test failed", token?.name, error);
              if (region.tokens?.has?.(token)) inside.push(token);
            }
          }
          return inside;
        },

        /** Records current HP without firing when a creature first becomes an occupant. */
        seedHpBaseline(payload, token, { replace = false } = {}) {
          const hp = actorHitPoints(token?.actor);
          if (hp === null || !token?.uuid) return;
          const key = stateKey("hp", token.uuid);
          if (replace || !Number.isFinite(payload.state.hpObserved[key])) payload.state.hpObserved[key] = hp;
        },

        /** Removes stale baselines so leaving and re-entering starts a new crossing watch. */
        reconcileHpBaselinesUnlocked(region, payload, { replace = false } = {}) {
          if (!(payload.config.effects ?? []).some((block) => block.triggers?.hpThreshold)) return;
          const inside = this.tokensInside(region);
          const keys = new Set(inside.map((token) => stateKey("hp", token.uuid)));
          for (const key of Object.keys(payload.state.hpObserved)) {
            if (!keys.has(key)) delete payload.state.hpObserved[key];
          }
          for (const token of inside) this.seedHpBaseline(payload, token, { replace });
        },

        /** Refreshes HP threshold baselines for every operational zone after authority changes. */
        async reconcileAllHpBaselines() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) {
            if (!this.isOperational(region)) continue;
            await this.withState(region, (payload) =>
              this.reconcileHpBaselinesUnlocked(region, payload, { replace: true })
            );
          }
        },

        /** Checks current geometry because a save may resolve after its target has left. */
        isTokenInside(region, tokenUuid) {
          return this.tokensInside(region).some((candidate) => candidate.uuid === tokenUuid);
        },

        /** Treats a wall-blocked occupant as outside for exit-bound result handling. */
        async isTokenEffectivelyInside(region, payload, token) {
          return this.isTokenInside(region, token?.uuid) && await this.lineOfEffectAllows(payload, token, region);
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
        async reconcileRuntimeHistory() {
          if (!this.isAuthority()) return;
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
            });
          }
        },

        /** Removes one deleted embedded Item from its owning Region's cleanup ledger. */
        async forgetDeletedAppliedItem(item) {
          if (!this.isAuthority() || !item?.id) return;
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
          });
        },

        /** Applies targeting and line-of-effect rules consistently for every zone trigger. */
        async eligible(payload, token, region = null) {
          const targetActor = token?.actor;
          if (!targetActor?.isOfType?.("creature")) return false;
          const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
          if (!sourceActor) return false;

          const isSource = token.uuid === sourceToken?.uuid || targetActor.uuid === sourceActor.uuid;
          if (isSource) return Boolean(payload.config?.targeting?.includeSelf);

          let matchesTargeting = false;
          switch (payload.config?.targeting?.affects) {
            case "allies":
              matchesTargeting = Boolean(targetActor.isAllyOf?.(sourceActor));
              break;
            case "enemies":
              matchesTargeting = Boolean(targetActor.isEnemyOf?.(sourceActor));
              break;
            case "both":
              // Keep the stored "both" value's existing unrestricted behavior for older zones.
              matchesTargeting = true;
              break;
            case "none":
              break;
            default:
              break;
          }
          if (!matchesTargeting) return false;
          return this.lineOfEffectAllows(payload, token, region, sourceToken);
        },

        /** Checks only the physical path so delayed exit-bound results do not depend on source or alliance state. */
        async lineOfEffectAllows(payload, token, region, knownSourceToken = null) {
          if (payload.config?.targeting?.lineOfEffect === "ignore") return true;
          const sourceToken = knownSourceToken ?? (await this.resolveSource(payload)).token;
          const scene = region?.parent ?? token?.parent ?? sourceToken?.parent;
          const origin = zoneOrigin(region, payload, sourceToken);
          return hasLineOfEffect(scene, origin, tokenCenter(token));
        },

        /** Replaces the transient effective-occupant snapshot without producing Entry triggers. */
        async rememberEffectiveOccupants(region, payload = this.readPayload(region)) {
          if (!this.isOperational(region, payload)) {
            this.effectiveOccupants.delete(region?.uuid);
            return;
          }
          const occupants = new Set();
          for (const token of this.tokensInside(region)) {
            if (await this.eligible(payload, token, region)) occupants.add(token.uuid);
          }
          this.effectiveOccupants.set(region.uuid, occupants);
        },

        /** Updates one Region snapshot after Foundry reports a geometric enter or exit. */
        noteEffectiveOccupant(region, token, inside) {
          if (!region?.uuid || !token?.uuid) return;
          const occupants = this.effectiveOccupants.get(region.uuid) ?? new Set();
          if (inside) occupants.add(token.uuid);
          else occupants.delete(token.uuid);
          this.effectiveOccupants.set(region.uuid, occupants);
        },

        /** Prefers the creation-time duration result so dice formulas never reroll during later checks. */
        durationRounds(config, state) {
          const resolved = Number(state?.duration?.rounds);
          if (Number.isSafeInteger(resolved) && resolved > 0) return resolved;

          switch (config?.duration?.type) {
            case "1-round": return 1;
            case "custom-rounds": {
              const configured = Number(config.duration.rounds);
              return Number.isSafeInteger(configured) && configured > 0 ? configured : null;
            }
            case "1-minute": return 10;
            case "10-minutes": return 100;
            default: return null;
          }
        },

        /** Uses the saved source token to keep every zone clock on its own Scene. */
        combatForPayload(payload, recordedCombatId = null) {
          return combatForZoneState(payload?.state, recordedCombatId);
        },

        /** Records both combat and world-time limits so temporary immunity behaves across combat transitions. */
        makeExpiry(duration, payload) {
          const rounds = duration === "1-round" ? 1
            : duration === "1-minute" ? 10
            : duration === "10-minutes" ? 100
            : null;
          if (!rounds) return null;
          const combat = this.combatForPayload(payload)?.combat;
          return {
            rounds,
            remainingRounds: rounds,
            worldExpires: nowWorld() + rounds * 6,
            combatId: combat?.id ?? null,
            startRound: Number(combat?.round ?? 0),
            startTurn: Number(combat?.turn ?? 0)
          };
        },

        /** Counts a partial combat round so a switch cannot restore time already spent in initiative. */
        immunityCombatRemaining(expiry, combat) {
          const rounds = Math.max(0, Number(expiry.rounds) || 0);
          const roundDelta = Number(combat.round ?? 0) - Number(expiry.startRound ?? 0);
          const partialRound = Number(combat.turn ?? 0) < Number(expiry.startTurn ?? 0) ? 1 : 0;
          return Math.max(0, Math.min(rounds, rounds - roundDelta + partialRound));
        },

        /** Lets immunity checks make one consistent decision regardless of how the duration was measured. */
        expiryActive(expiry, payload) {
          const worldExpires = Number(expiry?.worldExpires);
          if (!Number.isFinite(worldExpires) || nowWorld() >= worldExpires) return false;
          const combat = this.combatForPayload(payload, expiry.combatId)?.combat;
          if (expiry.combatId && combat?.id === expiry.combatId) {
            return this.immunityCombatRemaining(expiry, combat) > 0;
          }
          return true;
        },

        /** Carries only unused immunity time into a new encounter or back to world time. */
        syncImmunityCombatClock(payload) {
          const combat = this.combatForPayload(payload)?.combat;

          for (const record of Object.values(payload.state.immunities ?? {})) {
            const expiry = record?.expiry;
            if (!expiry) continue;
            const worldExpires = Number(expiry.worldExpires);
            const worldRemaining = Number.isFinite(worldExpires)
              ? Math.max(0, Math.ceil((worldExpires - nowWorld()) / 6))
              : 0;
            let storedRemaining = Number.isSafeInteger(expiry.remainingRounds)
              ? Math.max(0, expiry.remainingRounds)
              : Math.max(0, Number(expiry.rounds) || 0);

            if (expiry.combatId && combat?.id !== expiry.combatId) {
              const previousCombat = recordedCombatForZoneState(payload.state, expiry.combatId);
              if (previousCombat) {
                storedRemaining = Math.min(storedRemaining, this.immunityCombatRemaining(expiry, previousCombat));
              }
            }

            if (expiry.combatId && combat?.id === expiry.combatId) {
              expiry.remainingRounds = Math.min(storedRemaining, this.immunityCombatRemaining(expiry, combat));
              continue;
            }

            const remaining = Math.min(worldRemaining, storedRemaining);
            if (expiry.combatId) {
              // Foundry can change encounters without advancing world time.
              // Carry observed combat progress into the world-time deadline.
              expiry.worldExpires = Number.isFinite(worldExpires)
                ? Math.min(worldExpires, nowWorld() + remaining * 6)
                : nowWorld();
              expiry.combatId = null;
              expiry.startRound = 0;
              expiry.startTurn = 0;
            }
            expiry.remainingRounds = remaining;
            if (!combat?.id || remaining <= 0) continue;

            expiry.combatId = combat.id;
            expiry.rounds = remaining;
            expiry.startRound = Number(combat.round ?? 0);
            expiry.startTurn = Number(combat.turn ?? 0);
          }
        },

        /** Finds the relevant record without making individual effect handlers understand storage details. */
        findImmunityEntry(payload, tokenUuid, blockId) {
          for (const [storageId, record] of Object.entries(payload.state.immunities ?? {})) {
            const recordMatches =
              record?.tokenUuid === tokenUuid &&
              record?.blockId === blockId;
            const legacyMatches = storageId === `${tokenUuid}::${blockId}`;
            if (recordMatches || legacyMatches) return { storageId, record };
          }
          return null;
        },

        /** Prevents a repeat trigger from reapplying an effect during its configured immunity period. */
        isImmune(payload, tokenUuid, blockId) {
          this.syncImmunityCombatClock(payload);
          const entry = this.findImmunityEntry(payload, tokenUuid, blockId);
          if (!entry) {
            console.info("PF2e Zone immunity lookup", {
              zone: payload.config.name,
              tokenUuid,
              blockId,
              found: false,
              storedRecords: Object.values(payload.state.immunities ?? {}).map((r) => ({
                tokenUuid: r?.tokenUuid ?? null,
                blockId: r?.blockId ?? null,
                duration: r?.duration ?? null
              }))
            });
            return false;
          }

          const { storageId, record } = entry;
          const active = this.expiryActive(record.expiry, payload);
          const combat = this.combatForPayload(payload, record.expiry?.combatId)?.combat;
          console.info("PF2e Zone immunity check", {
            zone: payload.config.name,
            tokenUuid,
            blockId,
            storageId,
            active,
            currentCombat: combat?.id ?? null,
            currentRound: Number(combat?.round ?? 0),
            currentTurn: Number(combat?.turn ?? 0),
            expiryCombat: record.expiry?.combatId ?? null,
            expiryStartRound: Number(record.expiry?.startRound ?? 0),
            expiryStartTurn: Number(record.expiry?.startTurn ?? 0),
            expiryRounds: Number(record.expiry?.rounds ?? 0),
            expiryWorldTime: Number(record.expiry?.worldExpires ?? 0)
          });

          if (active) return true;
          delete payload.state.immunities[storageId];
          console.info("PF2e Zone temporary immunity expired", {
            zone: payload.config.name,
            tokenUuid,
            blockId,
            storageId
          });
          return false;
        },

        /** Keeps persisted state small and prevents expired entries from influencing later triggers. */
        pruneExpiredImmunities(payload) {
          this.syncImmunityCombatClock(payload);
          let removed = 0;
          for (const [key, record] of Object.entries(payload.state.immunities ?? {})) {
            if (this.expiryActive(record?.expiry, payload)) continue;
            delete payload.state.immunities[key];
            removed++;
          }
          if (removed) {
            console.info("PF2e Zone expired immunities pruned", {
              zone: payload.config.name,
              removed,
              combatRound: Number(this.combatForPayload(payload)?.combat?.round ?? 0),
              combatTurn: Number(this.combatForPayload(payload)?.combat?.turn ?? 0)
            });
          }
          return removed;
        },

        /** Records a temporary exclusion immediately after the outcome that should grant it. */
        setImmunity(payload, tokenUuid, block) {
          if (!block?.immunity || block.immunity.duration === "none") return;
          const expiry = this.makeExpiry(block.immunity.duration, payload);
          if (!expiry) return;

          for (const [storageId, record] of Object.entries(payload.state.immunities ?? {})) {
            const sameRecord =
              (record?.tokenUuid === tokenUuid && record?.blockId === block.id) ||
              storageId === `${tokenUuid}::${block.id}`;
            if (sameRecord) delete payload.state.immunities[storageId];
          }

          const storageId = randomId();
          payload.state.immunities[storageId] = {
            tokenUuid,
            blockId: block.id,
            expiry,
            duration: block.immunity.duration,
            createdWorldTime: nowWorld()
          };
          console.info("PF2e Zone temporary immunity started", {
            zone: payload.config.name,
            tokenUuid,
            blockId: block.id,
            storageId,
            duration: block.immunity.duration,
            combatId: expiry.combatId,
            startRound: expiry.startRound,
            startTurn: expiry.startTurn,
            rounds: expiry.rounds,
            worldExpires: expiry.worldExpires
          });
        },

        /** Uses a stable identity so repeat limits are scoped to one creature and Effect Block. */
        repeatKey(tokenUuid, blockId) {
          return stateKey("repeat", tokenUuid, blockId);
        },

        /** Creates a shared round marker so once-per-round effects cannot fire twice on one turn cycle. */
        roundStamp(payload) {
          const combat = this.combatForPayload(payload)?.combat;
          return combat?.id
            ? `${combat.id}:${Number(combat.round ?? 0)}`
            : `world:${Math.floor(nowWorld() / 6)}`;
        },

        /** Checks frequency limits before costly saves, rolls, and embedded-item changes are created. */
        repeatBlocked(payload, tokenUuid, block) {
          const policy = block.repeat === "once-per-activation" ? "once-per-zone" : block.repeat;
          if (policy === "every") return false;
          const key = this.repeatKey(tokenUuid, block.id);
          const record = payload.state.repeat[key];
          if (policy === "once-per-zone") return Boolean(record?.zone);
          return record?.round === this.roundStamp(payload);
        },

        /** Records an accepted application so later hooks observe the configured frequency limit. */
        markRepeat(payload, tokenUuid, block) {
          const policy = block.repeat === "once-per-activation" ? "once-per-zone" : block.repeat;
          if (policy === "every") return;
          const key = this.repeatKey(tokenUuid, block.id);
          payload.state.repeat[key] ??= {};
          if (policy === "once-per-zone") payload.state.repeat[key].zone = true;
          else if (policy === "once-per-round") payload.state.repeat[key].round = this.roundStamp(payload);
        },

        /** Translates only actual PF2e roll degrees into stored outcome keys. */
        outcomeFromDegree(degree) {
          if (!Number.isInteger(degree)) return null;
          return ["criticalFailure", "failure", "success", "criticalSuccess"][degree] ?? null;
        },

        /** Accepts only the target's PF2e save from a GM or an owner before trusting a chat outcome. */
        saveResultFromMessage(message, pending, token) {
          const actor = token?.actor;
          const context = message?.flags?.pf2e?.context;
          const authorId = message?.author?.id;
          const author = authorId ? game.users?.get?.(authorId) : null;
          if (!actor || !context || !author) return null;
          if (!author.isGM && !actor.testUserPermission?.(author, "OWNER")) return null;
          if (context.type !== "saving-throw" || context.identifier !== pending.identifier) return null;
          if (pending.actorUuid && pending.actorUuid !== actor.uuid) return null;
          if (message.actor?.uuid !== actor.uuid || context.actor !== actor.id) return null;
          if (context.token != null && context.token !== token.id) return null;
          if (message.token && message.token.uuid !== token.uuid) return null;
          if (!Number.isFinite(Number(pending.dc)) || Number(context.dc?.value) !== Number(pending.dc)) return null;
          if (!Array.isArray(context.domains) ||
              !pending.saveTypes?.some((saveType) => context.domains.includes(saveType))) return null;

          for (const roll of message.rolls ?? []) {
            if (roll?.options?.type !== "saving-throw" || roll.options.identifier !== pending.identifier) continue;
            const roller = game.users.get(roll.options.rollerId);
            if (!roller || (!roller.isGM && !actor.testUserPermission?.(roller, "OWNER"))) continue;
            const outcome = this.outcomeFromDegree(roll.degreeOfSuccess ?? roll.options.degreeOfSuccess);
            if (!outcome || (context.outcome && context.outcome !== outcome)) continue;
            return outcome;
          }
          return null;
        },

        /** Finds an authorized saved chat result without treating an unrelated roll as completion. */
        async completedMessageForPending(pending) {
          const token = await fromUuid(pending.tokenUuid);
          if (!token?.actor) return null;
          const messages = [...(game.messages?.contents ?? [])].reverse();
          for (const message of messages) {
            const outcome = this.saveResultFromMessage(message, pending, token);
            if (outcome) return { message, outcome, token };
          }
          return null;
        },

        /** Finds an existing request card so a retry after an uncertain write cannot post a duplicate. */
        saveRequestMessageForPending(pending) {
          /** Restricts recovery to the chat card for this exact pending-save identifier. */
          const matches = (message) =>
            Boolean(message?.author?.isGM)
            && message.flags?.world?.pf2eZoneSaveRequest?.identifier === pending?.identifier;
          const messageId = pending?.delivery?.messageId;
          if (messageId) {
            const byId = game.messages?.get?.(messageId)
              ?? (game.messages?.contents ?? []).find((message) => message?.id === messageId);
            if (matches(byId)) return byId;
          }
          return [...(game.messages?.contents ?? [])].reverse().find(matches) ?? null;
        },

        /** Replays a missed result before deciding whether the creature still has an unanswered save. */
        async hasPending(region, payload, tokenUuid, blockId) {
          let hasUnansweredSave = false;
          for (const [pendingId, pending] of Object.entries(payload.state.pendingSaves ?? {})) {
            if (pending.tokenUuid !== tokenUuid || pending.blockId !== blockId) continue;

            const tombstone = payload.state.resolvedSaves?.[pendingId];
            if (tombstone?.identifier === pending.identifier) {
              delete payload.state.pendingSaves[pendingId];
              continue;
            }

            const completed = await this.completedMessageForPending(pending);
            if (completed) {
              const resolved = await this.resolvePendingSaveUnlocked(
                region, payload, pendingId, pending.identifier,
                completed.outcome, completed.token.actor.uuid, completed.message
              );
              if (resolved || !payload.state.pendingSaves[pendingId]) continue;
            }

            hasUnansweredSave = true;
          }
          return hasUnansweredSave;
        },

        /** Uses the source statistic at resolution time while protecting combined Class-or-Spell DCs from PF2e fallback data. */
        resolveDC(payload, block, sourceActor) {
          if (block.save.dc.mode === "custom") return Number(block.save.dc.value) || 0;
          return actorStatisticDc(sourceActor, block.save.dc.statistic);
        },

        /** Identifies linked conditions so recovery watchers only observe outcomes this block can create. */
        inflictedSlugs(block) {
          const slugs = new Set();
          for (const outcome of Object.values(block.outcomes ?? {})) {
            for (const condition of outcome?.conditions ?? []) slugs.add(condition.slug);
          }
          return [...slugs];
        },

        /** Renders the same card before and after a confirmed save, retaining its Token ping. */
        saveRequestCardContent(region, payload, pending, targetName, completed = false) {
          const buttons = completed ? "" : pending.saveTypes.map((saveType) =>
            `<button type="button" data-pf2e-zone-save data-scene-id="${escHtml(region.parent.id)}" data-region-id="${escHtml(region.id)}" data-pending-id="${escHtml(pending.id)}" data-save-type="${escHtml(saveType)}"><i class="fa-solid fa-dice-d20"></i> ${escHtml(titleCaseLocal(saveType))}</button>`
          ).join(" ");
          const pingButton = `<button type="button" data-pf2e-zone-ping data-scene-id="${escHtml(region.parent.id)}" data-region-id="${escHtml(region.id)}" data-pending-id="${escHtml(pending.id)}" title="Ping this target for everyone viewing the Scene"><i class="fa-solid fa-bullseye"></i> Ping target</button>`;
          const name = escHtml(targetName);
          const choiceText = completed
            ? `<p><b>${name}</b>: <strong>Save completed.</strong></p>`
            : pending.saveTypes.length > 1
              ? `<p><b>${name}</b>: choose a save before rolling.</p>`
              : `<p><b>${name}</b>: roll ${escHtml(titleCaseLocal(pending.saveTypes[0]))}.</p>`;
          const controls = buttons ? `${buttons} ${pingButton}` : pingButton;
          return `<div class="pf2e-zone-save-request"><h4>${escHtml(payload.config.name)} — ${escHtml(pending.blockName)}</h4>${choiceText}<p><b>DC ${pending.dc}</b></p><div class="message-buttons">${controls}</div><p style="opacity:.7;font-size:.9em">PF2e Zone Automation save request</p></div>`;
        },

        /** Creates a single clear chat choice so the affected player can resolve the required save. */
        async postSaveRequest(region, payload, pending) {
          const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
          const target = await fromUuid(pending.tokenUuid);
          const targetName = target?.name ?? "Target";

          return await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken }),
            content: this.saveRequestCardContent(region, payload, pending, targetName),
            flags: { world: { pf2eZoneSaveRequest: {
              identifier: pending.identifier,
              tokenUuid: pending.tokenUuid,
              targetName,
              status: "pending"
            } } }
          });
        },

        /** Updates the original request card only after the matching save has committed. */
        async completeSaveRequestCard(region, payload, pending) {
          const card = this.saveRequestMessageForPending(pending);
          if (!card?.update) return false;
          const flag = card.flags?.world?.pf2eZoneSaveRequest ?? {};
          if (flag.status === "completed") return false;
          const target = flag.targetName ?? (await fromUuid(pending.tokenUuid))?.name ?? "Target";
          await card.update({
            content: this.saveRequestCardContent(region, payload, pending, target, true),
            "flags.world.pf2eZoneSaveRequest": {
              ...flag,
              identifier: pending.identifier,
              tokenUuid: pending.tokenUuid,
              targetName: target,
              status: "completed"
            }
          });
          return true;
        },

        /** Uses Foundry's ordinary shared ping at the pending save's current Token position. */
        async pingSaveTarget(sceneId, tokenUuid) {
          if (!canvas?.ready || canvas.scene?.id !== sceneId) {
            ui.notifications.warn("View the target's Scene before pinging this save request.");
            return false;
          }

          const token = await fromUuid(tokenUuid);
          if (!token || token.parent?.id !== sceneId) {
            ui.notifications.warn("This save request's target Token no longer exists.");
            return false;
          }

          const center = canvas.tokens?.get?.(token.id)?.center;
          if (!center) {
            ui.notifications.warn("This save request's target Token is not available on the canvas.");
            return false;
          }

          await canvas.ping(center);
          return true;
        },

        /** Posts or rediscovers one pending request while its Region state lock is held. */
        async deliverPendingSaveUnlocked(region, payload, pendingId, identifier) {
          const pending = payload.state.pendingSaves?.[pendingId];
          if (!pending || pending.identifier !== identifier || !this.isOperational(region, payload)) {
            return { status: "missing", changed: false, pending: null };
          }

          const existing = this.saveRequestMessageForPending(pending);
          if (existing) {
            const messageId = existing.id ?? existing._id ?? null;
            const changed = pending.delivery?.status !== "delivered"
              || pending.delivery?.messageId !== messageId
              || pending.delivery?.lastError != null;
            pending.delivery = {
              ...(pending.delivery ?? {}),
              status: "delivered",
              messageId,
              lastError: null
            };
            return { status: "delivered", changed, pending, message: existing };
          }

          const attempts = Math.max(0, Number(pending.delivery?.attempts) || 0) + 1;
          pending.delivery = {
            ...(pending.delivery ?? {}),
            status: "undelivered",
            attempts,
            messageId: null,
            lastAttemptWorldTime: nowWorld(),
            lastError: null
          };

          try {
            const message = await this.postSaveRequest(region, payload, pending);
            pending.delivery.status = "delivered";
            pending.delivery.messageId = message?.id ?? message?._id ?? null;
            return { status: "delivered", changed: true, pending, message };
          } catch (error) {
            pending.delivery.lastError = String(error?.message ?? error).slice(0, 1000);
            return { status: "undelivered", changed: true, pending, error };
          }
        },

        /** Makes a failed request visible while retaining its durable retry record. */
        reportSaveDeliveryFailure(region, result) {
          if (result?.status !== "undelivered") return;
          console.error("PF2e Zone: save request delivery failed; it remains queued for retry", {
            region,
            pendingId: result.pending?.id ?? null,
            error: result.error ?? result.pending?.delivery?.lastError ?? null
          });
          try {
            globalThis.ui?.notifications?.error?.(
              `PF2e Zone: could not post the ${result.pending?.blockName ?? "pending"} save request in '${region.name}'. It remains queued and will retry when a GM reconnects or authority changes.`
            );
          } catch (error) {
            console.error("PF2e Zone: failed to display the save delivery warning", error);
          }
        },

        /** Retries one persisted request through the normal serialized Region state path. */
        async deliverPendingSave(region, pendingId, identifier) {
          if (!this.isAuthority()) return { status: "not-authority", changed: false, pending: null };
          let result = { status: "missing", changed: false, pending: null };
          try {
            await this.withState(region, async (payload) => {
              result = await this.deliverPendingSaveUnlocked(region, payload, pendingId, identifier);
            });
          } catch (error) {
            this.reportSaveDeliveryFailure(region, result);
            throw error;
          }
          this.reportSaveDeliveryFailure(region, result);
          return result;
        },

        /** Recovers every request whose card is absent, coalescing duplicate startup and handoff hooks. */
        async reconcileUndeliveredSaveRequests() {
          if (!this.isAuthority()) return;
          if (this.saveDeliveryRecovery) return await this.saveDeliveryRecovery;

          const recovery = (async () => {
            for (const region of this.allZones()) {
              const payload = this.readPayload(region);
              if (!this.isOperational(region, payload)) continue;
              for (const [pendingId, pending] of Object.entries(payload.state.pendingSaves ?? {})) {
                if (payload.state.resolvedSaves?.[pendingId]?.identifier === pending.identifier) continue;
                if (pending.delivery?.status === "delivered" && this.saveRequestMessageForPending(pending)) continue;
                try {
                  await this.deliverPendingSave(region, pendingId, pending.identifier);
                } catch (error) {
                  console.error("PF2e Zone: save request delivery recovery failed", region, pendingId, error);
                }
              }
            }
          })();
          this.saveDeliveryRecovery = recovery;
          try {
            return await recovery;
          } finally {
            if (this.saveDeliveryRecovery === recovery) this.saveDeliveryRecovery = null;
          }
        },

        /** Records a pending save before chat output so late or duplicate clicks remain safe to handle. */
        async requestSave(region, payload, block, token, trigger, batchId, eventContext = {}) {
          const hasUnansweredSave = await this.hasPending(region, payload, token.uuid, block.id);
          if (block.repeat !== "every" && hasUnansweredSave) {
            console.info("PF2e Zone save suppressed: pending save already exists", {
              zone: payload.config.name,
              block: block.name,
              token: token.name,
              tokenUuid: token.uuid,
              trigger
            });
            return false;
          }
          const { actor: sourceActor } = await this.resolveSource(payload);
          const dc = this.resolveDC(payload, block, sourceActor);
          if (!(dc > 0)) {
            ui.notifications.error(`PF2e Zone: could not resolve the DC for ${block.name}.`);
            return false;
          }

          const saveTypes = block.save.type === "choice"
            ? [...new Set(block.save.choices ?? [])].filter((s) => ["fortitude", "reflex", "will"].includes(s))
            : [block.save.type];
          if (!saveTypes.length) return false;

          const id = randomId();
          const identifier = `${SAVE_PREFIX}:${region.parent.id}:${region.id}:${id}`;
          const pending = {
            id,
            identifier,
            tokenUuid: token.uuid,
            actorUuid: token.actor?.uuid ?? null,
            blockId: block.id,
            blockName: block.name,
            trigger,
            batchId,
            dc,
            saveTypes,
            eventContext: clone(eventContext ?? {}),
            createdWorldTime: nowWorld(),
            delivery: {
              status: "undelivered",
              attempts: 0,
              messageId: null,
              lastAttemptWorldTime: null,
              lastError: null
            }
          };
          payload.state.pendingSaves[id] = pending;
          this.markRepeat(payload, token.uuid, block);

          // Do not expose a clickable save button until the enclosing Region
          // state transaction has committed the pending record.
          this.queueAfterCommit(payload, async () => {
            const liveRegion = region.parent?.regions?.get?.(region.id);
            if (!liveRegion) return;

            const committed = this.readPayload(liveRegion);
            if (!this.isOperational(liveRegion, committed)) return;
            const result = await this.deliverPendingSaveUnlocked(liveRegion, committed, id, identifier);
            let persistError = null;
            try {
              if (result.changed && this.isLiveRegion(liveRegion)) await this.writePayload(liveRegion, committed);
            } catch (error) {
              persistError = error;
            }
            this.reportSaveDeliveryFailure(liveRegion, result);
            if (persistError) throw persistError;
          });
          return true;
        },

        /** Keeps immunity rules expressed in plain PF2e degree categories. */
        outcomeIsSuccessOrBetter(outcome) {
          return outcome === "success" || outcome === "criticalSuccess";
        },

        /** Keeps immunity rules expressed in plain PF2e degree categories. */
        outcomeIsFailureOrWorse(outcome) {
          return outcome === "failure" || outcome === "criticalFailure";
        },

        /** Identifies items created by a zone without relying on item names or compendium provenance. */
        zoneItemFlag(item) {
          return fu.getProperty(item, `flags.${FLAG_SCOPE}.${FLAG_KEY}`) ?? null;
        },

        /** Prevents overlapping cleanup requests from trying to remove the same embedded item twice. */
        itemDeleteKey(item) {
          return `${item?.parent?.uuid ?? "Actor"}::${item?.id ?? "Item"}`;
        },

        /** Shares an in-flight delete and reports failures so cleanup records remain retryable. */
        async deleteOwnedItem(item, context = "zone cleanup") {
          if (!item?.parent) return true;
          const key = this.itemDeleteKey(item);
          const pending = this.itemDeletePromises.get(key);
          if (pending) return pending;

          // Keep condition hooks suppressed while Foundry removes the Item.
          this.deletingItems.add(key);
          const deletion = (async () => {
            const live = item.parent?.items?.get?.(item.id);
            if (!live) return true;
            try {
              await live.delete();
            } catch (error) {
              // A concurrent deletion may have completed while this request was in flight.
              if (!item.parent?.items?.get?.(item.id)) return true;
              throw new Error(`PF2e Zone: ${context} failed for Item '${item.name ?? item.id}': ${error?.message ?? error}`, { cause: error });
            }
            if (item.parent?.items?.get?.(item.id)) {
              throw new Error(`PF2e Zone: ${context} did not remove Item '${item.name ?? item.id}'.`);
            }
            return true;
          })();
          this.itemDeletePromises.set(key, deletion);
          try {
            return await deletion;
          } finally {
            this.itemDeletePromises.delete(key);
            // Item hooks can finish just after the document promise settles.
            setTimeout(() => {
              if (!this.itemDeletePromises.has(key)) this.deletingItems.delete(key);
            }, 50);
          }
        },

        /** Finds one exact zone-owned Condition so applications and recovery watches share an identity. */
        ownedConditionItem(region, block, token, condition) {
          return token.actor?.items?.find?.((item) => {
            const flag = this.zoneItemFlag(item);
            return item.type === "condition" && flag?.zoneUuid === region.uuid && flag?.blockId === block.id && flag?.slug === condition.slug && flag?.removal === condition.removal;
          }) ?? null;
        },

        /** Gives each zone result its own Condition Item so cleanup cannot affect another source. */
        async addOwnedCondition(region, payload, block, token, condition) {
          const actor = token.actor;
          if (!actor) return false;

          const duplicate = this.ownedConditionItem(region, block, token, condition);
          if (duplicate) {
            if (condition.value != null && Number(duplicate.system?.value?.value ?? 0) < Number(condition.value)) {
              await duplicate.update({ "system.value.value": Number(condition.value) });
            }
            return true;
          }

          const template = game.pf2e?.ConditionManager?.getCondition?.(condition.slug);
          if (!template) {
            ui.notifications.error(`PF2e Zone: condition '${condition.slug}' was not found.`);
            return false;
          }
          const source = template.toObject();
          delete source._id;
          delete source.folder;
          if (condition.value != null && source.system?.value?.isValued) {
            source.system.value.value = Number(condition.value);
          }
          fu.setProperty(source, `flags.${FLAG_SCOPE}.${FLAG_KEY}`, {
            kind: "condition",
            zoneUuid: region.uuid,
            blockId: block.id,
            tokenUuid: token.uuid,
            slug: condition.slug,
            removal: condition.removal,
            linkedCondition: condition.removal === "condition-end" ? condition.condition : null
          });

          let created = null;
          try {
            [created] = await actor.createEmbeddedDocuments("Item", [source]);
          } catch (error) {
            console.error("PF2e Zone: Effect/condition Item creation failed", {
              actor: actor.name,
              actorUuid: actor.uuid,
              zone: payload.config.name,
              block: block.name,
              source
            }, error);
            ui.notifications.error(`PF2e Zone: failed to create an owned Item on ${actor.name}. See console.`);
            return false;
          }
          if (!created) return false;
          // Normal conditions persist independently after the zone ends; only
          // temporary results need a Region cleanup record.
          if (condition.removal !== "normal") {
            const recordId = randomId();
            payload.state.applied[recordId] = {
              recordId,
              kind: "condition",
              actorUuid: actor.uuid,
              tokenUuid: token.uuid,
              itemId: created.id,
              blockId: block.id,
              removal: condition.removal,
              linkedCondition: condition.removal === "condition-end" ? condition.condition : null
            };
          }
          return true;
        },

        /** Applies lasting and temporary conditions without sharing another source's Item. */
        async addCondition(region, payload, block, token, condition) {
          return this.addOwnedCondition(region, payload, block, token, condition);
        },

        /** Gives pre-outcome Effect Items a durable identity without duplicating an active legacy application. */
        async adoptLegacyEffectOutcome(item, payload, outcomeKey) {
          const flag = this.zoneItemFlag(item);
          if (!flag || flag.outcomeKey) return true;
          try {
            const path = `flags.${FLAG_SCOPE}.${FLAG_KEY}.outcomeKey`;
            if (typeof item.update === "function") await item.update({ [path]: outcomeKey });
            else fu.setProperty(item, path, outcomeKey);
          } catch (error) {
            console.error("PF2e Zone: legacy Effect Item identity migration failed", item, error);
            ui.notifications.error(`PF2e Zone: failed to update an existing Effect Item on ${item.parent?.name ?? "the target"}. See console.`);
            return false;
          }
          for (const record of Object.values(payload.state.applied)) {
            if (record?.kind === "effect" && record.actorUuid === item.parent?.uuid && record.itemId === item.id) {
              record.outcomeKey = outcomeKey;
            }
          }
          return true;
        },

        /** Copies Effect Items with outcome and cleanup metadata so distinct result lifecycles cannot collide. */
        async addEffectItem(region, payload, block, token, effect, outcomeKey = "noSave") {
          const actor = token.actor;
          if (!actor) return false;

          const candidates = Array.from(actor.items.values()).filter((item) => {
            const flag = this.zoneItemFlag(item);
            return flag?.kind === "effect" && flag?.zoneUuid === region.uuid && flag?.blockId === block.id && flag?.originalUuid === effect.uuid;
          });
          const matches = candidates.filter((item) => {
            const flag = this.zoneItemFlag(item);
            return flag.removal === effect.removal && flag.outcomeKey === outcomeKey;
          });
          const legacyMatches = candidates.filter((item) => {
            const flag = this.zoneItemFlag(item);
            return flag.removal === effect.removal && !flag.outcomeKey;
          });
          // PF2e can keep expired effects on the Actor, but their rules no longer apply.
          // A live match still represents this zone result; expired matches must be replaced.
          if (matches.some((item) => item.isExpired !== true && item.system?.expired !== true)) return true;
          const liveLegacy = legacyMatches.find((item) => item.isExpired !== true && item.system?.expired !== true);
          if (liveLegacy) return this.adoptLegacyEffectOutcome(liveLegacy, payload, outcomeKey);
          const expiredMatches = matches.length ? matches : legacyMatches;

          const template = await fromUuid(effect.uuid);
          if (!template || template.documentName !== "Item" || template.type !== "effect") {
            ui.notifications.error(`PF2e Zone: PF2e Effect Item not found: ${effect.uuid}`);
            return false;
          }
          const originActorUuid = payload.state?.sourceActorUuid ?? (await this.resolveSource(payload)).actor?.uuid;
          if (!originActorUuid) {
            ui.notifications.error(`PF2e Zone: source Actor for '${payload.config.name}' is unavailable.`);
            return false;
          }
          const source = template.toObject();
          delete source._id;
          delete source.folder;
          // An Actor-sheet Effect is a template here, not a continuation of its
          // old aura, grant, caster, target, or clock.
          delete source.flags?.pf2e?.aura;
          delete source.flags?.pf2e?.grantedBy;
          delete source.flags?.pf2e?.itemGrants;
          delete source.system.start;
          delete source.system.expired;
          source.system.context = {
            origin: {
              actor: originActorUuid,
              token: payload.state?.sourceTokenUuid ?? null,
              item: null,
              spellcasting: null,
              rollOptions: []
            },
            target: { actor: actor.uuid, token: token.uuid ?? null },
            roll: null
          };

          // For zone-managed Effect Items, the zone owns the lifetime. Prevent the
          // source Effect Item's native duration from expiring it before on-exit or
          // zone-end cleanup can occur. "item-duration" deliberately preserves the
          // source item's normal PF2e duration/expiry behavior.
          if (source.type === "effect" && ["on-exit", "zone-end"].includes(effect.removal)) {
            source.system.duration = {
              ...(source.system.duration ?? {}),
              value: -1,
              unit: "unlimited",
              expiry: null,
              sustained: false
            };
          }

          fu.setProperty(source, `flags.${FLAG_SCOPE}.${FLAG_KEY}`, {
            kind: "effect",
            zoneUuid: region.uuid,
            blockId: block.id,
            tokenUuid: token.uuid,
            originalUuid: effect.uuid,
            removal: effect.removal,
            outcomeKey
          });

          for (const expired of expiredMatches) {
            try {
              await this.deleteOwnedItem(expired, "expired zone Effect replacement");
            } catch (error) {
              console.error("PF2e Zone: expired Effect Item replacement failed", expired, error);
              ui.notifications.error(`PF2e Zone: failed to replace an expired Effect Item on ${actor.name}. See console.`);
              return false;
            }
            // Only forget a prior application after its embedded Item is gone.
            for (const [recordId, record] of Object.entries(payload.state.applied)) {
              if (record?.kind === "effect" && record.actorUuid === actor.uuid && record.itemId === expired.id) {
                delete payload.state.applied[recordId];
              }
            }
          }

          let created = null;
          try {
            [created] = await actor.createEmbeddedDocuments("Item", [source]);
          } catch (error) {
            console.error("PF2e Zone: Effect Item creation failed", {
              actor: actor.name,
              actorUuid: actor.uuid,
              zone: payload.config.name,
              block: block.name,
              effectUuid: effect.uuid,
              source
            }, error);
            ui.notifications.error(`PF2e Zone: failed to create Effect Item on ${actor.name}. See console.`);
            return false;
          }
          if (!created) return false;
          const recordId = randomId();
          payload.state.applied[recordId] = {
            recordId,
            kind: "effect",
            actorUuid: actor.uuid,
            tokenUuid: token.uuid,
            itemId: created.id,
            blockId: block.id,
            originalUuid: effect.uuid,
            removal: effect.removal,
            outcomeKey
          };
          return true;
        },

        /** Uses the PF2e roll implementation when present so zone damage gets normal system behavior. */
        damageRollClass() {
          return CONFIG.Dice?.rolls?.find((cls) => cls?.name === "DamageRoll") ?? null;
        },

        /** Resolves shared activation choices centrally so every relevant block uses the same selected type. */
        damageType(payload, block) {
          if (block.damage.typeMode === "activation-choice") {
            return payload.state.activation?.damageType ?? block.damage.type ?? "untyped";
          }
          return block.damage.type ?? "untyped";
        },

        /** Caches each source roll per event so multiple targets receive one consistent damage result. */
        async baseDamageRoll(payload, block, batchId) {
          const DamageRoll = this.damageRollClass();
          if (!DamageRoll) throw new Error("PF2e DamageRoll class is unavailable.");
          const type = this.damageType(payload, block);
          const cacheKey = stateKey("damage", block.id, batchId);
          const cached = payload.state.damageRolls[cacheKey];
          if (cached?.roll) return { DamageRoll, type: cached.type, roll: DamageRoll.fromData(cached.roll) };

          const roll = await new DamageRoll(`{(${block.damage.formula})[${type}]}`).roll();
          payload.state.damageRolls[cacheKey] = { type, roll: roll.toJSON() };
          return { DamageRoll, type, roll };
        },

        /** Posts system damage cards only after a degree of success establishes the correct multiplier. */
        async postDamage(region, payload, block, token, outcomeKey, multiplier, batchId) {
          if (!block.damage.enabled || !(Number(multiplier) > 0)) return false;
          try {
            const { roll: baseRoll } = await this.baseDamageRoll(payload, block, batchId);
            const adjusted = Number(multiplier) === 1 ? baseRoll : baseRoll.alter(Number(multiplier), 0);
            const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
            const outcomeLabel = titleCaseLocal(outcomeKey);
            const adjustment = Number(multiplier) === 1 ? "" : ` — ×${Number(multiplier)}`;
            await ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken }),
              flavor: `<strong>${escHtml(payload.config.name)} — ${escHtml(block.name)}</strong><br>${escHtml(token.name)}: ${escHtml(outcomeLabel)}${escHtml(adjustment)}<br><span style="opacity:.75">Damage is already adjusted for this outcome; use the normal Apply Damage button.</span>`,
              rolls: [adjusted.toJSON()],
              flags: {
                pf2e: {
                  context: {
                    type: "damage-roll",
                    options: ["area-effect", "area-damage", ...(payload.config.traits ?? [])],
                    outcome: outcomeKey
                  }
                },
                world: { pf2eZoneDamage: { zoneUuid: region.uuid, blockId: block.id, tokenUuid: token.uuid } }
              }
            });
            return true;
          } catch (error) {
            console.error("PF2e Zone: damage roll failed", error);
            ui.notifications.error(`PF2e Zone: damage roll failed for ${block.name}. See console.`);
            return false;
          }
        },

        /** Caches each source healing roll per event so multiple targets share a consistent result. */
        async baseHealingRoll(payload, block, batchId) {
          const DamageRoll = this.damageRollClass();
          if (!DamageRoll) throw new Error("PF2e DamageRoll class is unavailable.");
          const cacheKey = stateKey("healing", block.id, batchId);
          const cached = payload.state.healingRolls[cacheKey];
          if (cached?.roll) return { DamageRoll, roll: DamageRoll.fromData(cached.roll) };

          const roll = await new DamageRoll(`{(${block.healing.formula})[healing]}`).roll();
          payload.state.healingRolls[cacheKey] = { roll: roll.toJSON() };
          return { DamageRoll, roll };
        },

        /** Posts system healing cards only after a degree of success establishes the correct multiplier. */
        async postHealing(region, payload, block, token, outcomeKey, multiplier, batchId) {
          if (!block.healing?.enabled || !(Number(multiplier) > 0)) return false;
          try {
            const { roll: baseRoll } = await this.baseHealingRoll(payload, block, batchId);
            const adjusted = Number(multiplier) === 1 ? baseRoll : baseRoll.alter(Number(multiplier), 0);
            const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
            const outcomeLabel = titleCaseLocal(outcomeKey);
            const adjustment = Number(multiplier) === 1 ? "" : ` — ×${Number(multiplier)}`;
            await ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken }),
              flavor: `<strong>${escHtml(payload.config.name)} — ${escHtml(block.name)}</strong><br>${escHtml(token.name)}: ${escHtml(outcomeLabel)}${escHtml(adjustment)}<br><span style="opacity:.75">Healing is already adjusted for this outcome; use the normal Apply Healing button.</span>`,
              rolls: [adjusted.toJSON()],
              flags: {
                pf2e: {
                  context: {
                    type: "damage-roll",
                    options: ["area-effect", ...(payload.config.traits ?? [])],
                    outcome: outcomeKey
                  }
                },
                world: { pf2eZoneHealing: { zoneUuid: region.uuid, blockId: block.id, tokenUuid: token.uuid } }
              }
            });
            return true;
          } catch (error) {
            console.error("PF2e Zone: healing roll failed", error);
            ui.notifications.error(`PF2e Zone: healing roll failed for ${block.name}. See console.`);
            return false;
          }
        },

        /** Applies results while letting continuous refreshes restore items without replaying limited rolls. */
        async applyOutcome(region, payload, block, token, outcomeKey, batchId, eventContext = {}, { maintainedOnly = false, application = null } = {}) {
          const outcome = block.outcomes?.[outcomeKey];
          if (!outcome) return false;
          let affected = false;
          let exitBoundAffected = false;
          if (application) application.conditions = [];

          for (const condition of outcome.conditions ?? []) {
            if (condition.removal === "on-exit" && !(await this.isTokenEffectivelyInside(region, payload, token))) continue;
            const applied = await this.addCondition(region, payload, block, token, condition);
            const item = applied ? this.ownedConditionItem(region, block, token, condition) : null;
            if (item && application) {
              application.conditions.push({ slug: condition.slug, itemId: item.id });
            }
            if (condition.removal === "on-exit") exitBoundAffected = applied || exitBoundAffected;
            else affected = applied || affected;
          }
          for (const effect of outcome.effects ?? []) {
            if (effect.removal === "on-exit" && !(await this.isTokenEffectivelyInside(region, payload, token))) continue;
            const applied = await this.addEffectItem(region, payload, block, token, effect, outcomeKey);
            if (effect.removal === "on-exit") exitBoundAffected = applied || exitBoundAffected;
            else affected = applied || affected;
          }
          if (!maintainedOnly && block.damage.enabled && Number(outcome.damageMultiplier) > 0) {
            affected = (await this.postDamage(region, payload, block, token, outcomeKey, outcome.damageMultiplier, batchId)) || affected;
          }
          if (!maintainedOnly && block.healing?.enabled && Number(outcome.damageMultiplier) > 0) {
            affected = (await this.postHealing(region, payload, block, token, outcomeKey, outcome.damageMultiplier, batchId)) || affected;
          }
          // Item creation and rolls can await Foundry while the token moves.
          // Exit-bound items no longer count as an effect if they are removed.
          if (await this.isTokenEffectivelyInside(region, payload, token)) affected = exitBoundAffected || affected;
          else await this.cleanupTokenOnExitUnlocked(payload, token.uuid, region);
          // Chat alerts are emitted once per trigger event by processBlock(),
          // independently of whether this outcome affects one or many targets.
          return affected;
        },

        /** Tracks the exact applied Condition that must end before a zone grants temporary immunity. */
        registerRecoveryWatcher(payload, block, token, outcomeKey, application = null) {
          if (!block.immunity?.starts?.includes("condition-recovery")) return;
          const condition = block.immunity.recoveryCondition;
          if (!condition) return;
          const outcomeHasCondition = (block.outcomes?.[outcomeKey]?.conditions ?? [])
            .some((entry) => entry.slug === condition);
          if (!outcomeHasCondition) return;
          const applied = application?.conditions?.find((entry) => entry.slug === condition);
          if (!applied?.itemId) return;
          const item = token.actor?.items?.get?.(applied.itemId)
            ?? token.actor?.items?.find?.((entry) => entry.id === applied.itemId);
          if (!item) return;
          if (Object.values(payload.state.recoveryWatchers).some((watcher) =>
            watcher.actorUuid === token.actor?.uuid
            && watcher.blockId === block.id
            && watcher.itemId === item.id
          )) return;
          const key = randomId();
          payload.state.recoveryWatchers[key] = {
            tokenUuid: token.uuid,
            actorUuid: token.actor?.uuid ?? null,
            blockId: block.id,
            condition,
            itemId: item.id,
            outcomeKey,
            duration: block.immunity.duration
          };
        },

        /** Applies immunity only for the selected outcome conditions rather than whenever a block runs. */
        applyImmunityStarts(payload, block, token, outcomeKey, affected, hadSave, application = null) {
          const starts = block.immunity?.starts ?? [];
          let startNow = false;
          if (hadSave && starts.includes("after-save")) startNow = true;
          if (hadSave && starts.includes("success-or-better") && this.outcomeIsSuccessOrBetter(outcomeKey)) startNow = true;
          if (hadSave && starts.includes("failure-or-worse") && this.outcomeIsFailureOrWorse(outcomeKey)) startNow = true;
          if (starts.includes("affected") && affected) startNow = true;
          if (startNow) this.setImmunity(payload, token.uuid, block);
          this.registerRecoveryWatcher(payload, block, token, outcomeKey, application);
        },

        /** Coordinates eligibility, frequency, saves, and results so every trigger follows the same safeguards. */
        async processBlock(region, payload, block, token, trigger, batchId, { continuous = false, eventContext = {}, skipEligibility = false } = {}) {
          const resolvedEventContext = { trigger, ...(eventContext ?? {}) };
          // Older saved zones may contain a combination now rejected by the builder.
          // Never apply its No Save result or spend its repeat limit before a save trigger runs.
          if (continuous && block.save?.enabled) return;
          if (!skipEligibility && !(await this.eligible(payload, token, region))) {
            console.info("PF2e Zone trigger blocked: ineligible target", {
              zone: payload.config.name, block: block.name, trigger, token: token?.name
            });
            return;
          }
          if (this.isImmune(payload, token.uuid, block.id)) {
            console.info("PF2e Zone trigger blocked: temporary immunity", {
              zone: payload.config.name,
              block: block.name,
              trigger,
              token: token.name,
              immunity: this.findImmunityEntry(payload, token.uuid, block.id)?.record ?? null
            });
            return;
          }
          if (this.repeatBlocked(payload, token.uuid, block)) {
            // Continuous effects still need to be restored after exit or manual
            // removal. Repeat limits only gate new chat alerts, rolls, and saves.
            if (continuous) {
              await this.applyOutcome(region, payload, block, token, "noSave", batchId, resolvedEventContext, { maintainedOnly: true });
            }
            if (!continuous) {
              console.info("PF2e Zone trigger blocked: repeat policy", {
                zone: payload.config.name, block: block.name, trigger, token: token.name, repeat: block.repeat
              });
            }
            return;
          }

          // A chat alert belongs to the trigger event, not to each affected
          // creature. Multi-target events (most notably Activation) therefore
          // produce one message with {count} describing the number of targets.
          if (block.chatAlert?.enabled) {
            await this.postChatAlertOnce(
              region,
              payload,
              block,
              token,
              batchId,
              resolvedEventContext
            );
          }

          // Continuous payloads intentionally use the no-save outcome. This is
          // the maintenance path for effects such as Courageous Anthem.
          if (continuous) {
            this.markRepeat(payload, token.uuid, block);
            const application = {};
            const affected = await this.applyOutcome(
              region, payload, block, token, "noSave", batchId, resolvedEventContext, { application }
            );
            this.applyImmunityStarts(payload, block, token, "noSave", affected, false, application);
            return;
          }

          if (block.save.enabled) {
            await this.requestSave(region, payload, block, token, trigger, batchId, resolvedEventContext);
            return;
          }

          this.markRepeat(payload, token.uuid, block);
          const application = {};
          const affected = await this.applyOutcome(
            region, payload, block, token, "noSave", batchId, resolvedEventContext, { application }
          );
          this.applyImmunityStarts(payload, block, token, "noSave", affected, false, application);
        },

        /** Runs all matching blocks while the caller already holds the Region state lock. */
        async processTriggerUnlocked(region, payload, token, trigger, batchId) {
          for (const block of payload.config.effects ?? []) {
            if (!block.triggers?.[trigger]) continue;
            await this.processBlock(
              region,
              payload,
              block,
              token,
              trigger,
              `${batchId}:${block.id}`,
              { eventContext: { count: 1 } }
            );
          }
        },

        /** Distinguishes a real combat turn from repeated Foundry hooks during that same turn. */
        combatTurnKey(combat) {
          const active = combat?.combatant ?? null;
          return combat?.id && active
            ? `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${active.id}`
            : null;
        },

        /** Resolves the master whose combat turn a linked familiar or Eidolon shares. */
        linkedTurnMaster(actor) {
          if (!actor) return null;

          // PF2e familiars expose their selected master directly.
          if (actor.master) return actor.master;

          // PF2e Toolbelt Shared Data exposes a supported API when enabled.
          const shareData = game.modules?.get?.("pf2e-toolbelt")?.api?.shareData
            ?? game.toolbelt?.shareData;
          try {
            const master = shareData?.getMasterInMemory?.(actor);
            if (master) return master;
          } catch (_error) {
            // An optional compatibility API must never stop ordinary turn processing.
          }

          // PF2e Eidolon Helper stores the linked Summoner's world Actor id.
          const summonerId = actor.getFlag?.("pf2e-eidolon-helper", "summoner")
            ?? actor.flags?.["pf2e-eidolon-helper"]?.summoner;
          return summonerId ? game.actors?.get?.(summonerId) ?? null : null;
        },

        /** Compares world and synthetic Actor documents without relying only on object identity. */
        sameActor(first, second) {
          if (!first || !second) return false;
          return first === second
            || Boolean(first.uuid && second.uuid && first.uuid === second.uuid)
            || Boolean(first.id && second.id && first.id === second.id);
        },

        /** Treats a master and its linked familiar or Eidolon as sharing one combat turn. */
        actorsShareTurn(first, second) {
          const firstAnchor = this.linkedTurnMaster(first) ?? first;
          const secondAnchor = this.linkedTurnMaster(second) ?? second;
          return this.sameActor(firstAnchor, secondAnchor);
        },

        /** Processes occupant turn effects inside an existing state lock to prevent duplicate applications. */
        async processTurnStartUnlocked(region, payload, token, batchPrefix = "turnStart") {
          if (!(await this.eligible(payload, token, region))) return;

          // Region reshaping can transiently drop and re-add token membership.
          // Both Foundry's Region behavior and our combat-hook fallback can
          // therefore observe the same turn start. Persist one key per token so
          // the trigger is processed only once for the active combat turn.
          const turnKey = this.combatTurnKey(this.combatForPayload(payload)?.combat);
          const eventKey = stateKey("turnStart", token.uuid);
          if (turnKey && payload.state.turnStartEvents?.[eventKey] === turnKey) return;
          if (turnKey) {
            payload.state.turnStartEvents ??= {};
            payload.state.turnStartEvents[eventKey] = turnKey;
          }

          await this.processTriggerUnlocked(
            region,
            payload,
            token,
            "turnStart",
            `${batchPrefix}:${token.uuid}:${turnKey ?? this.roundStamp(payload)}:${randomId()}`
          );
        },

        /** Handles the current combatant once even if Foundry announces the turn through multiple hooks. */
        async processActiveTurnStart(region, changedCombat = null) {
          if (!this.isAuthority() || !this.isLiveRegion(region)) return;
          const payload = this.readPayload(region);
          const combat = this.combatForPayload(payload)?.combat;
          if (changedCombat && combat?.id !== changedCombat.id) return;
          const active = combat?.combatant ?? null;
          const token = active?.token ?? null;
          if (!combat || !active || !token || token.parent?.id !== region.parent?.id) return;

          // Geometry is authoritative here. This intentionally does not rely on
          // RegionDocument.tokens because moving/resizing a Region can make that
          // membership collection transiently stale.
          const activeActor = active.actor ?? token.actor;
          const turnTokens = this.tokensInside(region).filter((candidate) =>
            candidate.uuid === token.uuid
            || (!this.sameActor(candidate.actor, activeActor)
              && this.actorsShareTurn(candidate.actor, activeActor))
          );
          if (!turnTokens.length) return;

          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload)) return;
            if (!(payload.config.effects ?? []).some((block) => block.triggers?.turnStart)) return;
            for (const turnToken of turnTokens) {
              await this.processTurnStartUnlocked(region, payload, turnToken, "combatTurnStart");
            }
          });
        },

        /** Catches up active zones after combat state changes that skip an individual turn hook. */
        async processAllActiveTurnStarts(changedCombat = null) {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.processActiveTurnStart(region, changedCombat);
        },

        /** Keeps source-controlled effects tied to the source combatant rather than Region occupancy. */
        async processSourceTurnStartUnlocked(region, payload, sourceToken, batchId) {
          for (const block of payload.config.effects ?? []) {
            if (!block.triggers?.sourceTurnStart) continue;
            await this.processBlock(
              region,
              payload,
              block,
              sourceToken,
              "sourceTurnStart",
              `${batchId}:${block.id}`,
              { eventContext: { count: 1 }, skipEligibility: true }
            );
          }
        },

        /** Reconciles maintained effects without treating each refresh as a new entry event. */
        async processContinuousUnlocked(region, payload, token, batchId, eventContext = {}) {
          for (const block of payload.config.effects ?? []) {
            if (!block.triggers?.continuous) continue;
            await this.processBlock(
              region,
              payload,
              block,
              token,
              "continuous",
              `${batchId}:${block.id}`,
              { continuous: true, eventContext: { count: 1, ...(eventContext ?? {}) } }
            );
          }
        },

        /** Retains the cleanup record for real Item failures but completes when the target no longer exists. */
        async deleteAppliedRecord(payload, recordId) {
          const record = payload.state.applied[recordId];
          if (!record) return;
          const { actor } = await this.resolveTarget(record);
          if (!actor) {
            delete payload.state.applied[recordId];
            return;
          }
          if (!actor.items?.get) {
            throw new Error(`PF2e Zone: target Actor for Item '${record.itemId}' is unavailable; cleanup can be retried.`);
          }
          const item = actor.items.get(record.itemId);
          if (item) await this.deleteOwnedItem(item, "zone-owned Item cleanup");
          delete payload.state.applied[recordId];
        },

        /** Reconciles effects after a Token deletion, including all records owned by an unlinked synthetic Actor. */
        async reconcileDeletedToken(token) {
          if (!this.isAuthority() || !token?.uuid) return;
          const actorIsLinked = token.actorLink === true;
          const actorUuid = token.actor?.uuid ?? null;
          const failures = [];
          for (const region of this.allZones()) {
            try {
              const snapshot = this.readPayload(region);
              if (snapshot?.config?.mode === "emanation" && snapshot.state.sourceTokenUuid === token.uuid) {
                await this.endZone(region, "source token deleted");
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
              });
            } catch (error) { failures.push(error); }
          }
          if (failures.length) {
            throw new AggregateError(failures, `PF2e Zone: deleted Token cleanup failed for ${failures.length} zone(s).`);
          }
        },

        /** Reconciles records after Actor deletion because its embedded Items have already been removed by Foundry. */
        async reconcileDeletedActor(actor) {
          if (!this.isAuthority() || !actor?.uuid) return;
          const failures = [];
          for (const region of this.allZones()) {
            try {
              const snapshot = this.readPayload(region);
              if (snapshot?.state?.sourceActorUuid === actor.uuid) {
                await this.endZone(region, "source actor deleted");
                continue;
              }
              if (!Object.values(snapshot?.state?.applied ?? {}).some((record) => record.actorUuid === actor.uuid)) {
                continue;
              }
              await this.withState(region, (payload) => {
                for (const [recordId, record] of Object.entries(payload.state.applied)) {
                  if (record.actorUuid === actor.uuid) delete payload.state.applied[recordId];
                }
              });
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
        async deactivateRegion(region) {
          const timer = this.activationFinalizeTimers.get(region.uuid);
          if (timer) clearTimeout(timer);
          this.activationFinalizeTimers.delete(region.uuid);
          await this.withState(region, (payload) => {
            payload.state.deactivated = true;
            payload.state.pendingSaves = {};
            payload.state.recoveryWatchers = {};
          });
          await this.withState(region, async (payload) => {
            // A rapid reactivation may have queued between these writes.
            if (payload.state.deactivated) await this.cleanupZoneUnlocked(payload);
          });
        },

        /** Repairs disabled zones created before deactivation was persisted. */
        async reconcileDisabledZones() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) {
            if (!this.isRuntimeBehaviorActive(region)) await this.deactivateRegion(region);
          }
        },

        /** Retries dismissals whose Region and cleanup records survived an earlier failure. */
        async reconcileUnfinishedZoneEnds() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) {
            if (!this.readPayload(region)?.state?.endRequested) continue;
            try {
              await this.endZone(region, "retry unfinished cleanup");
            } catch (_error) {
              // endZone retains the Region and reports the failure; another GM
              // startup or a manual dismissal can try again later.
            }
          }
        },

        /** Retries exit-bound Item removal after a missed or failed movement cleanup. */
        async reconcileUnfinishedExitCleanup() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) {
            const snapshot = this.readPayload(region);
            if (!this.isOperational(region, snapshot)) continue;
            if (!Object.values(snapshot.state.applied).some((record) => record.removal === "on-exit")) continue;
            try {
              await this.withState(region, async (payload) => {
                if (this.isOperational(region, payload)) await this.cleanupExitedItemsUnlocked(region, payload);
              });
            } catch (error) {
              console.error("PF2e Zone: exit cleanup retry failed", region, error);
              ui.notifications.error(`PF2e Zone: failed to remove an exited effect from '${region.name}'. See console.`);
            }
          }
        },

        /** Finishes cleanup when Foundry deletes a Region outside the normal end-zone path. */
        async cleanupDeletedRegion(region, payload) {
          const records = Object.entries(payload?.state?.applied ?? {})
            .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
          const failures = [];
          for (const [, record] of records) {
            try {
              const { actor } = await this.resolveTarget(record);
              const item = actor?.items?.get(record.itemId);
              if (item) await this.deleteOwnedItem(item, "cleanup after Region deletion");
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

        /** Aligns maintained effects with current occupants after missed or reordered Region events. */
        async reconcileContinuousUnlocked(region, payload) {
          this.reconcileHpBaselinesUnlocked(region, payload);
          const insideTokens = this.tokensInside(region);
          await this.cleanupExitedItemsUnlocked(region, payload, insideTokens);

          const eligibleTokens = [];
          for (const token of insideTokens) {
            if (await this.eligible(payload, token, region)) eligibleTokens.push(token);
          }
          const previousOccupants = this.effectiveOccupants.get(region.uuid);
          const currentOccupants = new Set(eligibleTokens.map((token) => token.uuid));
          this.effectiveOccupants.set(region.uuid, currentOccupants);

          const batch = `continuous:${this.roundStamp(payload)}:${randomId()}`;
          const count = eligibleTokens.length;
          for (const token of eligibleTokens) {
            await this.processContinuousUnlocked(region, payload, token, batch, { count });
          }

          // A wall or closed door can end or restore the effective zone without
          // changing Foundry's geometric Region membership. Treat only the
          // blocked -> clear transition as Entry, and seed the first snapshot
          // silently during activation or startup.
          if (!previousOccupants) return;
          for (const token of eligibleTokens) {
            if (previousOccupants.has(token.uuid)) continue;
            this.seedHpBaseline(payload, token, { replace: true });
            await this.processTriggerUnlocked(region, payload, token, "enter", `lineOfEffectEnter:${token.uuid}:${randomId()}`);
          }
        },

        /** Keeps a stable geometry signature so a remote boundary event can wait for the full sweep. */
        areaBoundaryShapes(region) {
          return [...region.shapes].map((shape) => shape.toObject?.() ?? clone(shape));
        },

        /** Captures both geometry and membership before the next area update arrives. */
        areaBoundarySnapshot(region) {
          const payload = this.readPayload(region);
          if (!this.isOperational(region, payload) || payload.config?.mode !== "area"
            || !region.shapes?.[Symbol.iterator]) return null;
          const shapes = this.areaBoundaryShapes(region);
          return {
            shapes,
            signature: JSON.stringify(shapes),
            occupants: new Set(this.tokensInside(region).map((token) => token.uuid))
          };
        },

        /** Gives every client the last known footprint, including a GM who did not initiate the update. */
        rememberAreaBoundary(region) {
          const snapshot = this.areaBoundarySnapshot(region);
          if (snapshot) this.areaBoundarySnapshots.set(region.uuid, snapshot);
          else this.areaBoundarySnapshots.delete(region.uuid);
        },

        /** Preserves the initiating client's pre-update membership if Foundry delivers an early boundary event. */
        captureAreaBoundary(region) {
          const snapshot = this.areaBoundarySnapshot(region);
          if (snapshot) this.areaBoundaryBefore.set(region.uuid, snapshot);
        },

        /** Detects a remote drag before the shared post-update hook can run. */
        areaBoundaryChangedSinceSnapshot(region) {
          const snapshot = this.areaBoundarySnapshots.get(region.uuid);
          return Boolean(snapshot && snapshot.signature !== JSON.stringify(this.areaBoundaryShapes(region)));
        },

        /** Keeps resize comparisons current when a creature moves without moving the area. */
        noteAreaBoundaryOccupant(region, token, inside, movement) {
          const snapshot = this.areaBoundarySnapshots.get(region.uuid);
          if (!snapshot || !token || this.areaBoundaryBefore.has(region.uuid)
            || this.areaBoundaryChangedSinceSnapshot(region)
            || (movement == null && this.areaBoundarySuppression.has(region.uuid))) return;
          if (inside) snapshot.occupants.add(token.uuid);
          else snapshot.occupants.delete(token.uuid);
        },

        /** Prevents Foundry boundary events from applying a moved-area entry twice. */
        suppressAreaBoundaryEntries(region, tokens) {
          const prior = this.areaBoundarySuppression.get(region.uuid);
          if (prior) clearTimeout(prior.timer);
          const entry = { tokens: new Set([...(prior?.tokens ?? []), ...tokens.map((token) => token.uuid)]), timer: null };
          entry.timer = setTimeout(() => {
            if (this.areaBoundarySuppression.get(region.uuid) === entry) this.areaBoundarySuppression.delete(region.uuid);
          }, 1000);
          this.areaBoundarySuppression.set(region.uuid, entry);
        },

        /** Applies Entry to creatures reached anywhere along a fixed area drag. */
        async processAreaBoundaryChange(region, before) {
          if (!before || !this.isAuthority()) return;
          const afterShapes = this.areaBoundaryShapes(region);
          const translation = translatedAreaShapes(before.shapes, afterShapes);
          const affected = translation
            ? [...(region.parent?.tokens ?? [])].filter((token) => sweptAreaIntersectsToken(translation, tokenBounds(token)))
            : this.tokensInside(region).filter((token) => !before.occupants.has(token.uuid));
          this.suppressAreaBoundaryEntries(region, affected);
          if (!affected.length) return;
          const batch = "areaMove:" + region.uuid + ":" + randomId();
          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload)) return;
            for (const token of affected) {
              if (this.isTokenInside(region, token.uuid)) this.seedHpBaseline(payload, token, { replace: true });
              if (!(await this.eligible(payload, token, region))) continue;
              if (this.isTokenInside(region, token.uuid)) this.noteEffectiveOccupant(region, token, true);
              await this.processTriggerUnlocked(region, payload, token, "enter", batch + ":" + token.uuid);
            }
          });
        },

        /** Coalesces rapid Foundry updates so occupancy reconciliation does not run repeatedly for one change. */
        scheduleRegionReconcile(region, delay = 100) {
          if (!region?.parent?.id || !region?.id) return;
          const key = region.uuid;
          const prior = this.regionReconcileTimers.get(key);
          if (prior) clearTimeout(prior);

          const sceneId = region.parent.id;
          const regionId = region.id;
          const timer = setTimeout(async () => {
            this.regionReconcileTimers.delete(key);
            if (!this.isAuthority()) return;
            const liveRegion = game.scenes.get(sceneId)?.regions.get(regionId);
            if (!liveRegion) return;
            try {
              await this.withState(liveRegion, async (payload) => {
                if (!this.isOperational(liveRegion, payload)) return;
                await this.reconcileContinuousUnlocked(liveRegion, payload);
              });
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
              if (this.isImmune(payload, candidate.uuid, block.id)) continue;
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
        scheduleActivationFinalization(region, deadline) {
          if (!this.isAuthority() || !this.isLiveRegion(region) || this.activationFinalizeTimers.has(region.uuid)) return;
          const delay = Math.max(0, Number(deadline) - Date.now());
          const timer = setTimeout(async () => {
            this.activationFinalizeTimers.delete(region.uuid);
            if (!this.isAuthority() || !this.isLiveRegion(region)) return;
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
              });
            } catch (error) {
              console.error("PF2e Zone: activation finalization failed", error);
            }
          }, Number.isFinite(delay) ? delay : 0);
          this.activationFinalizeTimers.set(region.uuid, timer);
        },

        /** Rebuilds lost activation timers after startup or a change of authoritative GM. */
        async reconcileUnfinishedActivations() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) {
            const payload = this.readPayload(region);
            if (!this.isOperational(region, payload) || payload.state.activationProcessed) continue;
            await this.activateRegion(region);
          }
        },

        /** Initializes a newly created Region before delayed hooks can process its occupants. */
        async activateRegion(region) {
          if (!this.isAuthority() || !this.isRuntimeBehaviorActive(region)) return;
          if (!this.areaBoundarySnapshots.has(region.uuid)) this.rememberAreaBoundary(region);

          // A behavior may be re-enabled after its old deadline passed. Check
          // expiration before maintained effects are applied again.
          if (this.readPayload(region)?.state?.deactivated) {
            await this.withState(region, (payload) => { payload.state.deactivated = false; });
            await this.checkSourceAndDuration(region);
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
          });

          if (finalizationAt != null) this.scheduleActivationFinalization(region, finalizationAt);
        },

        /** Ends a finite zone at its stored combat deadline even when intermediate turn hooks were missed. */
        async checkSourceAndDuration(region) {
          if (!this.isAuthority()) return;
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
          });
          if (shouldEnd && this.isOperational(region)) await this.endZone(region, "duration/source");
        },

        /** Lets world-time and combat changes reevaluate every active finite zone. */
        async checkAllDurations() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.checkSourceAndDuration(region);
        },

        /** Provides a locked entry point for source-turn hooks that may arrive concurrently. */
        async processSourceTurnStart(region, changedCombat = null) {
          if (!this.isAuthority() || !this.isLiveRegion(region)) return;
          if (changedCombat && this.combatForPayload(this.readPayload(region))?.combat?.id !== changedCombat.id) return;

          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload)) return;
            if (!(payload.config.effects ?? []).some((block) => block.triggers?.sourceTurnStart)) return;

            const { combat = null, sourceCombatant = null } = this.combatForPayload(payload) ?? {};
            const active = combat?.combatant ?? null;
            if (!sourceCombatant || !active || active.id !== sourceCombatant.id) return;

            const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
            if (!sourceToken || !sourceActor) return;

            const turnKey = `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${active.id}`;
            if (payload.state.lastSourceTriggerTurnKey === turnKey) return;
            payload.state.lastSourceTriggerTurnKey = turnKey;

            await this.processSourceTurnStartUnlocked(
              region,
              payload,
              sourceToken,
              `sourceTurnStart:${sourceToken.uuid}:${turnKey}`
            );
          });
        },

        /** Catches up source-turn effects after combat updates that do not name one Region. */
        async processAllSourceTurnStarts(changedCombat = null) {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.processSourceTurnStart(region, changedCombat);
        },

        /** Leaves a retryable Region when owned Items or Region deletion fails. */
        async endZone(region, reason = "ended") {
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

              const current = scene.regions?.get?.(regionId);
              if (!current) return;
              cleanupPayload = this.readPayload(current);
              if (cleanupPayload) {
                cleanupPayload.state.deactivated = true;
                cleanupPayload.state.endRequested = true;
                cleanupPayload.state.pendingSaves = {};
                cleanupPayload.state.recoveryWatchers = {};
                // Persist the retry marker before any Item deletion. If cleanup
                // stops halfway, the Region stays quiet and startup can retry.
                await this.writePayload(current, cleanupPayload);
                await this.cleanupZoneUnlocked(cleanupPayload);
              }
              cleanupComplete = true;

              const stillLive = scene.regions?.get?.(regionId);
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

        /** Applies an authorized save while the Region state lock is already held. */
        async resolvePendingSaveUnlocked(region, payload, pendingId, identifier, outcome, rollerActorUuid = null, message = null) {
          if (!this.isAuthority()) return false;
          if (!["criticalSuccess", "success", "failure", "criticalFailure"].includes(outcome)) return false;
          if (payload.state.resolvedSaves?.[pendingId]?.identifier === identifier) {
            delete payload.state.pendingSaves[pendingId];
            return false;
          }

          if (!this.isOperational(region, payload)) return false;
          const pending = payload.state.pendingSaves[pendingId];
          if (!pending || pending.identifier !== identifier) return false;

          const block = payload.config.effects?.find((b) => b.id === pending.blockId);
          const token = await fromUuid(pending.tokenUuid);
          if (!block || !token?.actor) {
            delete payload.state.pendingSaves[pendingId];
            return false;
          }

          if (rollerActorUuid !== token.actor.uuid) return false;
          if (pending.actorUuid && pending.actorUuid !== token.actor.uuid) return false;
          if (message && this.saveResultFromMessage(message, pending, token) !== outcome) return false;

          // A transaction-local tombstone protects overlapping resolution work.
          // Persistence prunes it once the matching pending request is gone.
          delete payload.state.pendingSaves[pendingId];
          payload.state.resolvedSaves[pendingId] = {
            identifier,
            outcome,
            resolvedWorldTime: nowWorld()
          };

          const application = {};
          const affected = await this.applyOutcome(
            region,
            payload,
            block,
            token,
            outcome,
            pending.batchId,
            pending.eventContext ?? { trigger: pending.trigger },
            { application }
          );
          this.applyImmunityStarts(payload, block, token, outcome, affected, true, application);

          this.queueAfterCommit(payload, () => this.completeSaveRequestCard(region, payload, pending));

          console.info("PF2e Zone save resolved", {
            zone: payload.config.name,
            regionUuid: region.uuid,
            block: block.name,
            token: token.name,
            pendingId,
            outcome
          });
          return true;
        },

        /** Lets the authoritative GM discard an unanswered request without consuming its repeat allowance. */
        async cancelPendingSave(region, pendingId, identifier) {
          if (!this.isAuthority()) throw new Error("Only the active GM can cancel a PF2e Zone save request.");
          if (!this.readPayload(region)) throw new Error("The PF2e Zone no longer exists.");

          return await this.withState(region, async (payload) => {
            const pending = payload.state.pendingSaves?.[pendingId];
            if (!pending || pending.identifier !== identifier) return { status: "missing" };
            if (payload.state.resolvedSaves?.[pendingId]?.identifier === identifier) {
              delete payload.state.pendingSaves[pendingId];
              return { status: "resolved" };
            }

            // A valid roll may already be in chat even if its hook was missed.
            // Resolve that result rather than discarding a creature's completed save.
            const completed = this.isOperational(region, payload)
              ? await this.completedMessageForPending(pending) : null;
            if (completed) {
              const resolved = await this.resolvePendingSaveUnlocked(
                region, payload, pendingId, identifier,
                completed.outcome, completed.token.actor.uuid, completed.message
              );
              if (!resolved && payload.state.pendingSaves?.[pendingId]) {
                throw new Error("A completed save was found but could not be resolved.");
              }
              return { status: resolved ? "resolved" : "missing" };
            }

            delete payload.state.pendingSaves[pendingId];
            delete payload.state.repeat[this.repeatKey(pending.tokenUuid, pending.blockId)];
            return { status: "cancelled" };
          });
        },

        /** Serializes live chat and recovery through the same save resolution path. */
        async resolvePendingSave(region, pendingId, identifier, outcome, rollerActorUuid = null, message = null) {
          if (!this.isAuthority()) return false;
          if (!["criticalSuccess", "success", "failure", "criticalFailure"].includes(outcome)) return false;
          let resolved = false;
          await this.withState(region, async (payload) => {
            resolved = await this.resolvePendingSaveUnlocked(
              region, payload, pendingId, identifier, outcome, rollerActorUuid, message
            );
          });

          if (resolved && this.isLiveRegion(region)) {
            const persisted = this.readPayload(region);
            const persistedPending = persisted?.state?.pendingSaves?.[pendingId] ?? null;
            const immunityRecords = Object.entries(persisted?.state?.immunities ?? {}).map(
              ([storageId, record]) => ({
                storageId,
                tokenUuid: record?.tokenUuid ?? null,
                blockId: record?.blockId ?? null,
                duration: record?.duration ?? null,
                startRound: record?.expiry?.startRound ?? null,
                startTurn: record?.expiry?.startTurn ?? null,
                rounds: record?.expiry?.rounds ?? null
              })
            );

            console.info("PF2e Zone save state committed", {
              zone: persisted?.config?.name ?? region.name,
              regionUuid: region.uuid,
              pendingId,
              pendingStillPresent: Boolean(persistedPending),
              immunityRecords
            });
          }

          return resolved;
        },

        /** Recognizes this module's chat result messages without interfering with ordinary PF2e rolls. */
        async handleSaveResult(message) {
          if (!this.isAuthority()) return;
          const context = message.flags?.pf2e?.context;
          const identifier = context?.identifier;
          if (typeof identifier !== "string" || !identifier.startsWith(`${SAVE_PREFIX}:`)) return;

          const parts = identifier.split(":");
          if (parts.length !== 4) return;
          const [, sceneId, regionId, pendingId] = parts;
          const region = game.scenes.get(sceneId)?.regions.get(regionId);
          if (!region) return;

          const pending = this.readPayload(region)?.state?.pendingSaves?.[pendingId];
          if (!pending || pending.identifier !== identifier) return;
          const token = await fromUuid(pending.tokenUuid);
          const outcome = this.saveResultFromMessage(message, pending, token);
          if (!outcome) return;

          await this.resolvePendingSave(
            region,
            pendingId,
            identifier,
            outcome,
            token.actor.uuid,
            message
          );
        },

        /** Replays authorized saves whose chat messages arrived while the GM hook was unavailable. */
        async reconcileCompletedSaves() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) {
            const payload = this.readPayload(region);
            if (!this.isOperational(region, payload)) continue;
            for (const [pendingId, pending] of Object.entries(payload.state.pendingSaves ?? {})) {
              if (payload.state.resolvedSaves?.[pendingId]?.identifier === pending.identifier) continue;
              try {
                const completed = await this.completedMessageForPending(pending);
                if (!completed) continue;
                await this.resolvePendingSave(
                  region, pendingId, pending.identifier, completed.outcome,
                  completed.token.actor.uuid, completed.message
                );
              } catch (error) {
                console.error("PF2e Zone: completed save recovery failed", region, pendingId, error);
              }
            }
          }
        },

        /** Ends condition-linked cleanup watches when actors change outside a zone event. */
        async reconcileActorDependencies(actor) {
          if (!this.isAuthority() || !actor) return;

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
            await this.deleteOwnedItem(item, "linked-condition cleanup");
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
                if (block) this.setImmunity(payload, watcher.tokenUuid, block);
                delete payload.state.recoveryWatchers[key];
              }
            });
          }
        },


        /** Extracts only attributable PF2e ability use so zones do not react to unrelated chat cards. */
        async traitUseInfoFromMessage(message) {
          if (!message) return null;
          const pf2e = message.flags?.pf2e ?? {};
          const origin = pf2e.origin;
          if (!origin || typeof origin !== "object") return null;

          // PF2e repeats a spell's origin on damage and other roll cards.
          // Those cards are consequences of the cast, not another use of its traits.
          const contextType = pf2e.context?.type;
          if (origin.type === "spell" && (
            (contextType && contextType !== "spell-cast")
            || (Array.isArray(message.rolls) && message.rolls.length > 0)
            || message.isRoll === true
            || Boolean(pf2e.damageRoll)
          )) return null;

          const rollOptions = [
            ...(Array.isArray(origin.rollOptions) ? origin.rollOptions : []),
            ...(Array.isArray(pf2e.context?.options) ? pf2e.context.options : [])
          ].map((option) => String(option));

          // No-defense spells such as Detect Magic do not create PF2e's
          // spell-cast context or action roll option. Their spell origin is
          // still the durable record that a spell was cast, and lets trait
          // detection continue to the originating Item.
          const isSpellCast = origin.type === "spell"
            || pf2e.context?.type === "spell-cast"
            || rollOptions.includes("action:cast-a-spell");

          let actor = null;
          try {
            actor = origin.actor ? await fromUuid(origin.actor) : null;
          } catch (_error) { /* unresolved origin actor */ }

          const speaker = message.speaker ?? {};
          let token = speaker.scene && speaker.token
            ? (game.scenes.get(speaker.scene)?.tokens.get(speaker.token) ?? null)
            : null;

          if (!token && message.token) {
            token = message.token.document ?? message.token;
          }

          // A chat message must be attributable to a specific Token to decide
          // whether the user was actually inside a Region. Only use a fallback
          // when exactly one active token matches the Actor.
          if (!token && actor) {
            const candidates = [];
            for (const scene of game.scenes) {
              for (const candidate of scene.tokens) {
                const candidateActor = candidate.actor;
                if (!candidateActor) continue;
                if (candidateActor.uuid === actor.uuid || candidateActor.id === actor.id) {
                  candidates.push(candidate);
                }
              }
            }
            if (candidates.length === 1) token = candidates[0];
          }

          actor ??= token?.actor ?? null;
          if (!actor || !token) return null;

          let item = null;
          try {
            item = origin.uuid ? await fromUuid(origin.uuid) : null;
          } catch (_error) { /* unresolved origin item */ }

          const traits = new Set();
          for (const option of rollOptions) {
            const marker = ":trait:";
            const index = option.lastIndexOf(marker);
            if (index >= 0) {
              const trait = option.slice(index + marker.length).trim().toLowerCase();
              if (trait) traits.add(trait);
            }
          }

          // PF2e can include a spell's traits as unprefixed roll options on its
          // cast card. The originating Item remains the fallback for no-defense
          // spells whose card contains no roll options.
          if (origin.type === "spell") {
            for (const option of rollOptions) {
              const trait = option.trim().toLowerCase();
              if (/^[a-z][a-z0-9-]*$/.test(trait)) traits.add(trait);
            }
          }

          for (const trait of item?.system?.traits?.value ?? []) {
            const slug = String(trait ?? "").trim().toLowerCase();
            if (slug) traits.add(slug);
          }

          const embeddedSpell = pf2e.casting?.embeddedSpell;
          for (const trait of embeddedSpell?.system?.traits?.value ?? []) {
            const slug = String(trait ?? "").trim().toLowerCase();
            if (slug) traits.add(slug);
          }

          return {
            actor,
            token,
            itemName: String(item?.name ?? embeddedSpell?.name ?? "an ability"),
            itemUuid: origin.uuid ?? null,
            isSpellCast,
            traits
          };
        },

        /** Supports old and new trait-use data while ensuring each selected slug can be matched consistently. */
        watchedTraitsForBlock(block) {
          const selected = Array.isArray(block?.traitUse?.traits)
            ? block.traitUse.traits
            : [];
          const legacy = block?.traitUse?.trait ?? "";
          return [...new Set([...selected, legacy]
            .flatMap((trait) => String(trait ?? "").split(","))
            .map((trait) => trait.trim().toLowerCase().replace(/\s+/g, "-"))
            .filter(Boolean))];
        },

        /** Lets configuration text use safe, named placeholders instead of executing arbitrary chat content. */
        formatChatAlert(template, values) {
          const replacements = {
            zone: values.zone,
            block: values.block,
            creature: values.creature,
            item: values.item,
            source: values.source,
            trait: values.trait,
            trigger: values.trigger,
            count: values.count,
            hp: values.hp,
            previoushp: values.previousHp,
            threshold: values.threshold
          };
          return String(template ?? "").replace(/\{(zone|block|creature|item|source|trait|trigger|count|hp|previousHp|threshold)\}/gi, (_match, key) => {
            return String(replacements[String(key).toLowerCase()] ?? "");
          });
        },

        /** Treats one multi-target event as one alert so activation reconciliation does not spam chat. */
        chatAlertBatchKey(region, block, batchId, eventContext = {}) {
          const trigger = String(eventContext?.trigger ?? "").trim();
          // Activation is a single zone-creation event even though Foundry can
          // discover initial occupants in more than one pass during the grace
          // window. Use a stable activation key so the final sweep cannot
          // duplicate the reminder.
          const stableBatch = trigger === "activation"
            ? "activation"
            : String(batchId ?? trigger ?? "event");
          return `${region.uuid}::${block.id}::${stableBatch}`;
        },

        /** Suppresses duplicate alerts while Foundry finishes reporting a single trigger event. */
        async postChatAlertOnce(region, payload, block, token, batchId, eventContext = {}) {
          if (!block.chatAlert?.enabled) return;
          const key = this.chatAlertBatchKey(region, block, batchId, eventContext);
          if (this.chatAlertBatches.has(key)) return;

          this.chatAlertBatches.add(key);
          // Keep the key long enough to cover activation's delayed membership
          // finalization, then discard it so this transient runtime set cannot
          // grow for the life of the world.
          setTimeout(() => this.chatAlertBatches.delete(key), 5000);

          await this.postChatAlert(region, payload, block, token, eventContext);
        },

        /** Posts an auditable explanation of a configured effect without revealing unescaped world data. */
        async postChatAlert(region, payload, block, token, eventContext = {}) {
          if (!block.chatAlert?.enabled) return;
          const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
          const sourceName = sourceToken?.name ?? sourceActor?.name ?? region.name ?? "Zone source";
          const trait = String(eventContext?.trait ?? "").trim();
          const trigger = String(eventContext?.trigger ?? "").trim();
          const count = Math.max(1, Number(eventContext?.count ?? 1) || 1);
          const creature = count === 1
            ? (token?.actor?.name ?? token?.name ?? "Creature")
            : "affected creatures";
          const template = block.chatAlert?.text
            || "{zone}: {creature} triggered {block}.";
          const text = this.formatChatAlert(template, {
            zone: payload.config.name,
            block: block.name,
            creature,
            item: eventContext?.itemName ?? "",
            source: sourceName,
            trait,
            trigger: trigger === "hpThreshold" ? "HP threshold" : trigger ? titleCaseLocal(trigger) : "",
            hp: eventContext?.hp ?? "",
            previousHp: eventContext?.previousHp ?? "",
            threshold: eventContext?.threshold ?? "",
            count
          });

          const messageData = {
            speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken }),
            content: `<div class="pf2e-zone-chat-alert"><h4>${escHtml(payload.config.name)} — ${escHtml(block.name)}</h4><p>${escHtml(text)}</p><p style="opacity:.7;font-size:.9em">PF2e Zone Automation chat alert</p></div>`,
            flags: {
              [FLAG_SCOPE]: {
                pf2eZoneChatAlert: {
                  regionUuid: region.uuid,
                  blockId: block.id,
                  tokenUuid: token?.uuid ?? null,
                  trigger: eventContext?.trigger ?? null,
                  sourceMessageId: eventContext?.sourceMessageId ?? null
                }
              }
            }
          };
          const visibility = payload.config?.visibility;
          const creatorUserId = String(payload.state?.createdBy?.userId ?? "").trim();
          if (visibility === "creator" && creatorUserId) {
            messageData.whisper = [creatorUserId];
          } else if (visibility === "gm" && typeof ChatMessage.getWhisperRecipients === "function") {
            messageData.whisper = Array.from(ChatMessage.getWhisperRecipients("GM") ?? [])
              .map((user) => user?.id)
              .filter(Boolean);
          }

          await ChatMessage.create(messageData);
        },

        /** Watches authoritative actor HP changes and applies each crossed threshold to occupants. */
        async handleActorHitPointUpdate(actor) {
          if (!this.isAuthority() || !actor?.uuid) return;
          const currentHp = actorHitPoints(actor);
          if (currentHp === null) return;

          const candidateZones = this.allZones().filter((region) => {
            const payload = this.readPayload(region);
            return this.isOperational(region, payload)
              && (payload.config.effects ?? []).some((block) => block.triggers?.hpThreshold);
          });
          for (const region of candidateZones) {
            const occupants = this.tokensInside(region);
            const matching = occupants.filter((token) => token.actor?.uuid === actor.uuid);
            if (!matching.length) continue;
            const observed = this.readPayload(region)?.state?.hpObserved ?? {};
            if (matching.every((token) => observed[stateKey("hp", token.uuid)] === currentHp)) continue;

            await this.withState(region, async (payload) => {
              if (!this.isOperational(region, payload)) return;
              const troopGroup = actor.system?.traits?.value?.includes?.("troop")
                ? new Set([actor.uuid, ...(actor.otherSegments ?? []).map((segment) => segment?.uuid).filter(Boolean)])
                : null;
              let representative = null;
              if (troopGroup?.size > 1) {
                const eligibleSegments = [];
                for (const token of occupants) {
                  if (troopGroup.has(token.actor?.uuid) && await this.eligible(payload, token, region)) eligibleSegments.push(token);
                }
                representative = eligibleSegments.sort((a, b) => a.uuid.localeCompare(b.uuid))[0] ?? null;
              }

              for (const token of matching) {
                const key = stateKey("hp", token.uuid);
                const previousHp = payload.state.hpObserved[key];
                payload.state.hpObserved[key] = currentHp;
                if (!Number.isFinite(previousHp) || previousHp === currentHp) continue;
                if (troopGroup?.size > 1 && token.uuid !== representative?.uuid) continue;
                if (!(await this.eligible(payload, token, region))) continue;

                for (const block of payload.config.effects ?? []) {
                  if (!block.triggers?.hpThreshold) continue;
                  const threshold = block.hitPoints?.threshold;
                  if (!crossedHpThreshold(previousHp, currentHp, threshold)) continue;
                  await this.processBlock(
                    region, payload, block, token, "hpThreshold",
                    `hpThreshold:${token.uuid}:${previousHp}:${currentHp}:${block.id}:${randomId()}`,
                    { eventContext: { trigger: "hpThreshold", hp: currentHp, previousHp, threshold, count: 1 } }
                  );
                }
              }
            });
          }
        },

        /** Dispatches chat-card actions only to zones that observe the caster's location and the action that was actually used. */
        async handleTraitUseMessage(message) {
          if (!this.isAuthority()) return;

          const candidateZones = this.allZones().filter((region) => {
            const payload = this.readPayload(region);
            return this.isOperational(region, payload)
              && (payload.config.effects ?? []).some((block) => block.triggers?.traitUse || block.triggers?.spellCast);
          });
          if (!candidateZones.length) return;

          const info = await this.traitUseInfoFromMessage(message);
          if (!info?.token || (!info.traits?.size && !info.isSpellCast)) return;

          for (const region of candidateZones) {
            if (region.parent?.id !== info.token.parent?.id) continue;
            const inside = this.tokensInside(region).some((token) => token.uuid === info.token.uuid);
            if (!inside) continue;

            await this.withState(region, async (payload) => {
              if (!this.isOperational(region, payload)) return;

              for (const block of payload.config.effects ?? []) {
                const trait = block.triggers?.traitUse
                  ? this.watchedTraitsForBlock(block).find((candidate) => info.traits.has(candidate))
                  : null;
                const matchesTraitUse = Boolean(trait);
                const matchesSpellCast = Boolean(block.triggers?.spellCast && info.isSpellCast);
                if (!matchesTraitUse && !matchesSpellCast) continue;

                // A spell can also have a watched trait. Treat one chat card as
                // one event for each Effect Block so choosing both triggers does
                // not apply the same result twice.
                const trigger = matchesTraitUse ? "traitUse" : "spellCast";
                await this.processBlock(
                  region,
                  payload,
                  block,
                  info.token,
                  trigger,
                  `${trigger}:${message.id ?? randomId()}:${block.id}`,
                  {
                    eventContext: {
                      trigger,
                      ...(matchesTraitUse ? { trait } : {}),
                      itemName: info.itemName,
                      itemUuid: info.itemUuid,
                      sourceMessageId: message.id ?? null,
                      count: 1
                    }
                  }
                );
              }
            });
          }
        },

        /** Repairs condition-based cleanup after reloads or broad actor updates. */
        async reconcileAllLinkedConditions() {
          if (!this.isAuthority()) return;
          const actors = new Set(game.actors.contents);
          for (const scene of game.scenes?.contents ?? game.scenes ?? []) {
            for (const token of scene.tokens ?? []) if (token.actor) actors.add(token.actor);
          }
          for (const actor of actors) {
            if (actor.items.some((i) => this.zoneItemFlag(i)?.removal === "condition-end")) {
              await this.reconcileActorDependencies(actor);
            }
          }
        },

        /** Repairs temporary owned Items after an externally deleted Region lost its cleanup record. */
        async reconcileOrphanedZoneItems() {
          if (!this.isAuthority()) return;
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
                await this.deleteOwnedItem(item, "orphaned zone Item cleanup");
              } catch (error) {
                console.error("PF2e Zone: orphaned Item cleanup failed", item, error);
                ui.notifications.error(`PF2e Zone: failed to remove an orphaned effect from ${actor.name}. See console.`);
              }
            }
          }
        },

        /** Runs the complete startup repair set once for concurrent active-GM handoff signals. */
        async reconcileAuthorityState(reason = "authority recovery") {
          if (!this.isAuthority()) return;
          if (this.authorityRecovery) return await this.authorityRecovery;

          const recovery = Promise.resolve().then(async () => {
            const steps = [
              ["linked conditions", () => this.reconcileAllLinkedConditions()],
              ["orphaned Items", () => this.reconcileOrphanedZoneItems()],
              ["runtime history", () => this.reconcileRuntimeHistory()],
              ["unfinished zone ends", () => this.reconcileUnfinishedZoneEnds()],
              ["disabled zones", () => this.reconcileDisabledZones()],
              ["unfinished exit cleanup", () => this.reconcileUnfinishedExitCleanup()],
              ["completed saves", () => this.reconcileCompletedSaves()],
              ["save delivery", () => this.reconcileUndeliveredSaveRequests()],
              ["durations", () => this.checkAllDurations()],
              ["unfinished activations", () => this.reconcileUnfinishedActivations()],
              ["HP baselines", () => this.reconcileAllHpBaselines()]
            ];

            for (const [label, run] of steps) {
              if (!this.isAuthority()) return;
              try {
                await run();
              } catch (error) {
                console.error(`PF2e Zone: ${reason} ${label} failed`, error);
              }
            }
          });
          this.authorityRecovery = recovery;
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

        /** Releases hooks and timers so a replaced runtime cannot process events twice. */
        teardownHooks() {
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
            try {
              await runtime.checkAllDurations();
              await runtime.processAllSourceTurnStarts(combat);
              await runtime.processAllActiveTurnStarts(combat);
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
          const resumeAuthorityWork = () => runtime.scheduleAuthorityRecovery("active-GM handoff");
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
                setTimeout(async () => {
                  try {
                    const liveRegion = region.parent?.regions?.get?.(region.id);
                    const fresh = liveRegion ? runtime.readPayload(liveRegion) : null;
                    const stillPending = fresh?.state?.pendingSaves?.[pending.id];
                    if (!runtime.isOperational(liveRegion, fresh) || !stillPending || stillPending.identifier !== pending.identifier) return;

                    await runtime.resolvePendingSave(
                      liveRegion,
                      pending.id,
                      pending.identifier,
                      outcome,
                      actor.uuid
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

        /** Receives Region behavior events through the module API so existing zones use updated runtime code. */
        async handleRegionEvent({ event, region }) {
          this.installHooks();
          if (!this.isAuthority() || !region) return;
          const name = event?.name;
          if (!["behaviorActivated", "behaviorViewed", "behaviorDeactivated"].includes(name)
            && !this.isOperational(region)) return;
          const token = event?.data?.token ?? null;

          if (name === "tokenEnter" || name === "tokenExit") {
            const combat = this.combatForPayload(this.readPayload(region))?.combat;
            console.info("PF2e Zone Region event", {
              event: name,
              zone: region.name,
              regionUuid: region.uuid,
              token: token?.name ?? null,
              tokenUuid: token?.uuid ?? null,
              combatRound: Number(combat?.round ?? 0),
              combatTurn: Number(combat?.turn ?? 0)
            });
          }

          switch (name) {
            case "behaviorActivated":
              await this.activateRegion(region);
              break;
            case "behaviorViewed":
              await this.activateRegion(region);
              await this.checkSourceAndDuration(region);
              break;
            case "behaviorDeactivated":
              // Region deletion deactivates the embedded behavior as part of
              // removing it. Do not write flags back into a Region whose
              // embedded behavior collection is already being torn down.
              if (this.endingZones.has(region.uuid)) break;
              await this.deactivateRegion(region);
              break;
            case "tokenEnter":
              if (!token) break;
              // Boundary changes have no Token movement. The area-update sweep
              // handles these entries once, including creatures along the path.
              if (event?.data?.movement == null && (
                this.areaBoundaryBefore.has(region.uuid) ||
                this.areaBoundaryChangedSinceSnapshot(region) ||
                this.areaBoundarySuppression.get(region.uuid)?.tokens.has(token.uuid)
              )) break;
              this.noteAreaBoundaryOccupant(region, token, true, event?.data?.movement);
              await this.withState(region, async (payload) => {
                if (!this.isOperational(region, payload)) return;
                if (!this.effectiveOccupants.has(region.uuid)) await this.rememberEffectiveOccupants(region, payload);
                this.seedHpBaseline(payload, token, { replace: true });
                if (!(await this.eligible(payload, token, region))) {
                  this.noteEffectiveOccupant(region, token, false);
                  return;
                }
                this.noteEffectiveOccupant(region, token, true);
                const batch = `enter:${token.uuid}:${randomId()}`;
                const initialKey = stateKey("initial", token.uuid);
                const isInitialOccupant =
                  payload.state.activationPending &&
                  !payload.state.activationProcessed &&
                  Boolean(payload.state.initialOccupants?.[initialKey]);

                if (isInitialOccupant) {
                  // Region creation can emit tokenEnter for tokens that were
                  // already standing in the area. That is NOT an Entry trigger.
                  // Existing occupants are handled only by Activation and/or
                  // Continuous While Inside.
                  await this.processActivationTokenUnlocked(region, payload, token, batch);
                  await this.processContinuousUnlocked(region, payload, token, batch);
                  console.info("PF2e Zone initial occupant ignored for Entry", {
                    zone: payload.config.name,
                    token: token.name,
                    tokenUuid: token.uuid
                  });
                  return;
                }

                // This is a genuine outside -> inside transition after creation.
                await this.processContinuousUnlocked(region, payload, token, batch);
                await this.processTriggerUnlocked(region, payload, token, "enter", batch);
              });
              break;
            case "tokenExit":
              if (!token) break;
              this.noteAreaBoundaryOccupant(region, token, false, event?.data?.movement);
              this.noteEffectiveOccupant(region, token, false);
              // Do not delete on-exit state immediately. Region moves/resizes
              // can report a transient exit for a token that is still inside the
              // new geometry. The deferred reconcile removes true exits and
              // preserves/reapplies effects for tokens that remain inside.
              this.scheduleRegionReconcile(region, 100);
              break;
            case "tokenTurnStart":
              if (!token) break;
              await this.withState(region, async (payload) => {
                if (!this.isOperational(region, payload)) return;
                await this.processTurnStartUnlocked(region, payload, token, "regionTurnStart");
              });
              break;
            case "tokenTurnEnd":
              if (!token) break;
              await this.withState(region, async (payload) => {
                if (!this.isOperational(region, payload) || !(await this.eligible(payload, token, region))) return;
                await this.processTriggerUnlocked(region, payload, token, "turnEnd", `turnEnd:${token.uuid}:${this.roundStamp(payload)}:${randomId()}`);
              });
              break;
          }
        }
      };
      return rt;
    }

    let runtime = globalThis.PF2EZoneRuntime;
    const versionOrder = runtime ? compareVersions(runtime.version, VERSION) : -1;

    if (!runtime || versionOrder < 0) {
      if (runtime?.hooksInstalled && typeof runtime.teardownHooks !== "function") {
        // Pre-v0.3.4 runtimes did not retain their hook IDs, so they cannot be
        // safely unregistered in-place. A single browser refresh clears them.
        globalThis.PF2EZoneRuntimeLegacyHooksDetected = true;
      }
      try { runtime?.teardownHooks?.(); }
      catch (error) { console.warn("PF2e Zone: runtime teardown failed", error); }

      runtime = createRuntime();
      globalThis.PF2EZoneRuntime = runtime;
    }

    // If this embedded script is older than the already-loaded runtime, use the
    // newer singleton rather than downgrading it.
    runtime.installHooks();

    const context = explicitContext;
    if (context) await runtime.handleRegionEvent(context);
    return runtime;
  }

