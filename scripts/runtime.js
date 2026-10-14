import { combatForZoneState, recordedCombatForZoneState } from "./scene-combat.js";
import { sweptAreaIntersectsToken, tokenBounds, translatedAreaShapes } from "./area-shape.js";
import { actorHitPoints, crossedHpThreshold } from "./hp-threshold.js";
import { hasLineOfEffect, tokenCenter, zoneOrigin } from "./line-of-effect.js";
import { cloneData as clone, escapeHtml as escHtml, randomId, titleCase as titleCaseLocal } from "./utils.js";
import { VERSION, FLAG_SCOPE } from "./runtime-constants.js";
import { nowWorld, stateKey, compareVersions } from "./runtime-helpers.js";
import { createRuntimeAuthorityService } from "./runtime-authority.js";
import { createRegionStateService } from "./runtime-state.js";
import { createRegionLifecycleService } from "./runtime-lifecycle.js";
import { createZoneSaveService } from "./runtime-saves.js";
import { createZoneEffectService } from "./runtime-effects.js";
import { createRuntimeHookService } from "./runtime-hooks.js";

/** Composes services on one receiver so existing runtime methods and cross-service calls remain compatible. */
function createRuntime() {
  const AUTHORITY_LEASE = Symbol("pf2eZoneAuthorityLease");
  return {
    ...createRuntimeAuthorityService(AUTHORITY_LEASE),
    ...createRegionStateService(),
    ...createRegionLifecycleService(),
    ...createZoneSaveService(AUTHORITY_LEASE),
    ...createZoneEffectService(AUTHORITY_LEASE),
    ...createRuntimeHookService(),

    version: VERSION,

    chatAlertBatches: new Set(),

    areaBoundaryBefore: new Map(),

    areaBoundarySnapshots: new Map(),

    areaBoundarySuppression: new Map(),

    effectiveOccupants: new Map(),

    sharedImmunityCancellationTimers: new Map(),

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

    /** Checks current geometry because a save may resolve after its target has left. */
    isTokenInside(region, tokenUuid) {
      return this.tokensInside(region).some((candidate) => candidate.uuid === tokenUuid);
    },

    /** Treats a wall-blocked occupant as outside for exit-bound result handling. */
    async isTokenEffectivelyInside(region, payload, token) {
      return this.isTokenInside(region, token?.uuid) && await this.lineOfEffectAllows(payload, token, region);
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
      if (!this.payloadAuthorityCurrent(payload)) return;
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

    /** Returns the explicit cross-zone key without guessing from Actor names or creature data. */
    sharedImmunityGroup(block) {
      if (block?.immunity?.scope !== "shared-group") return null;
      const group = String(block.immunity.group ?? "").trim().toLowerCase();
      return group || null;
    },

    /** Keys shared immunity to the creature rather than one of its Token documents. */
    sharedImmunityTarget(actorUuid, tokenUuid) {
      return String(actorUuid || tokenUuid || "") || null;
    },

    /** Reconstructs the original zone clock so shared records use existing duration semantics. */
    sharedImmunityClockPayload(record, fallbackPayload = null) {
      const fallback = fallbackPayload?.state ?? {};
      return {
        state: {
          sourceTokenUuid: record?.clock?.sourceTokenUuid ?? fallback.sourceTokenUuid ?? null,
          sourceActorUuid: record?.clock?.sourceActorUuid ?? fallback.sourceActorUuid ?? null,
          immunities: { shared: record }
        }
      };
    },

    /** Advances a shared record across world-time and encounter transitions before testing it. */
    sharedImmunityActive(record, fallbackPayload = null) {
      if (!record?.expiry) return false;
      const clockPayload = this.sharedImmunityClockPayload(record, fallbackPayload);
      this.syncImmunityCombatClock(clockPayload);
      return this.expiryActive(record.expiry, clockPayload);
    },

    /** Finds one active Actor/group grant regardless of which aura originally created it. */
    findSharedImmunityEntry(payload, actorUuid, tokenUuid, group) {
      const targetUuid = this.sharedImmunityTarget(actorUuid, tokenUuid);
      if (!targetUuid || !group) return null;
      for (const [storageId, record] of Object.entries(this.readSharedImmunities())) {
        if (record?.targetUuid !== targetUuid || record?.group !== group) continue;
        if (this.sharedImmunityActive(record, payload)) return { storageId, record };
      }
      return null;
    },

    /** Applies both legacy per-block immunity and the optional Actor-wide shared group. */
    isImmuneFor(payload, token, block) {
      if (this.isImmune(payload, token?.uuid, block?.id)) return true;
      const group = this.sharedImmunityGroup(block);
      if (!group) return false;
      return Boolean(this.findSharedImmunityEntry(
        payload,
        token?.actor?.uuid ?? null,
        token?.uuid ?? null,
        group
      ));
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
    setImmunity(payload, tokenUuid, block, actorUuid = null, sourceRegionUuid = null) {
      if (!block?.immunity || block.immunity.duration === "none") return;
      const expiry = this.makeExpiry(block.immunity.duration, payload);
      if (!expiry) return;
      const group = this.sharedImmunityGroup(block);
      const targetUuid = this.sharedImmunityTarget(actorUuid, tokenUuid);

      for (const [storageId, record] of Object.entries(payload.state.immunities ?? {})) {
        const sameRecord =
          (record?.tokenUuid === tokenUuid && record?.blockId === block.id) ||
          storageId === `${tokenUuid}::${block.id}`;
        if (sameRecord) delete payload.state.immunities[storageId];
      }

      const storageId = randomId();
      payload.state.immunities[storageId] = {
        tokenUuid,
        actorUuid,
        blockId: block.id,
        scope: group ? "shared-group" : "effect-block",
        group,
        expiry,
        duration: block.immunity.duration,
        createdWorldTime: nowWorld()
      };

      if (group && targetUuid) {
        const sharedRecord = {
          storageId,
          targetUuid,
          actorUuid,
          tokenUuid,
          group,
          blockId: block.id,
          sourceRegionUuid,
          expiry: clone(expiry),
          clock: {
            sourceTokenUuid: payload.state.sourceTokenUuid ?? null,
            sourceActorUuid: payload.state.sourceActorUuid ?? null
          },
          duration: block.immunity.duration,
          createdWorldTime: nowWorld()
        };
        this.queueAfterCommit(payload, async () => {
          await this.persistSharedImmunity(sharedRecord, payload[AUTHORITY_LEASE]);
          if (this.payloadAuthorityCurrent(payload)) this.scheduleSharedPendingCancellation(sharedRecord, payload[AUTHORITY_LEASE]);
        });
      }
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
      return payload.state.immunities[storageId];
    },

    /** Persists a grant independently of the aura Region that created it. */
    async persistSharedImmunity(sharedRecord, lease = this.captureAuthorityLease()) {
      if (!sharedRecord?.targetUuid || !sharedRecord?.group) return false;
      await this.mutateSharedImmunities((records) => {
        for (const [key, record] of Object.entries(records)) {
          if (!this.sharedImmunityActive(record)) {
            delete records[key];
            continue;
          }
          if (record.targetUuid === sharedRecord.targetUuid && record.group === sharedRecord.group) {
            delete records[key];
          }
        }
        records[sharedRecord.storageId] = clone(sharedRecord);
      }, lease);
      return this.authorityLeaseCurrent(lease);
    },

    /** Removes expired shared grants and retires saves that survived an authority handoff. */
    async reconcileSharedImmunities({ cancelPending = true } = {}, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      const active = [];
      await this.mutateSharedImmunities((records) => {
        for (const [key, record] of Object.entries(records)) {
          if (!this.sharedImmunityActive(record)) {
            delete records[key];
            continue;
          }
          active.push(clone(record));
        }
      }, lease);
      if (cancelPending) {
        for (const record of active) this.scheduleSharedPendingCancellation(record, lease);
      }
    },

    /** Cleans hidden shared state when its affected Actor no longer exists. */
    async removeSharedImmunitiesForActor(actorUuid, lease = this.captureAuthorityLease()) {
      if (!actorUuid || !this.authorityLeaseCurrent(lease)) return;
      await this.mutateSharedImmunities((records) => {
        for (const [key, record] of Object.entries(records)) {
          if (record?.actorUuid === actorUuid || record?.targetUuid === actorUuid) delete records[key];
        }
      }, lease);
    },

    /** Coalesces one deferred cross-Region cleanup after the granting Region releases its lock. */
    scheduleSharedPendingCancellation(record, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !record?.targetUuid || !record?.group) return;
      const key = `${record.targetUuid}::${record.group}`;
      const prior = this.sharedImmunityCancellationTimers.get(key);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        this.sharedImmunityCancellationTimers.delete(key);
        if (!this.authorityLeaseCurrent(lease)) return;
        this.cancelSharedPendingSaves(record, lease)
          .catch((error) => console.error("PF2e Zone: shared-immunity save cleanup failed", error));
      }, 0);
      this.sharedImmunityCancellationTimers.set(key, timer);
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

    /** Coordinates eligibility, frequency, saves, and results so every trigger follows the same safeguards. */
    async processBlock(region, payload, block, token, trigger, batchId, { continuous = false, eventContext = {}, skipEligibility = false } = {}) {
      if (!this.payloadAuthorityCurrent(payload)) return;
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
      if (this.isImmuneFor(payload, token, block)) {
        console.info("PF2e Zone trigger blocked: temporary immunity", {
          zone: payload.config.name,
          block: block.name,
          trigger,
          token: token.name,
          immunity: this.findImmunityEntry(payload, token.uuid, block.id)?.record
            ?? this.findSharedImmunityEntry(payload, token.actor?.uuid, token.uuid, this.sharedImmunityGroup(block))?.record
            ?? null
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
        this.applyImmunityStarts(payload, block, token, "noSave", affected, false, application, region);
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
      this.applyImmunityStarts(payload, block, token, "noSave", affected, false, application, region);
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
    async processActiveTurnStart(region, changedCombat = null, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !this.isLiveRegion(region)) return;
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
      }, lease);
    },

    /** Catches up active zones after combat state changes that skip an individual turn hook. */
    async processAllActiveTurnStarts(changedCombat = null, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) await this.processActiveTurnStart(region, changedCombat, lease);
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

    /** Aligns maintained effects with current occupants after missed or reordered Region events. */
    async reconcileContinuousUnlocked(region, payload) {
      this.reconcileHpBaselinesUnlocked(region, payload);
      const insideTokens = this.tokensInside(region);
      await this.cleanupExitedItemsUnlocked(region, payload, insideTokens);

      const eligibleTokens = [];
      for (const token of insideTokens) {
        if (await this.eligible(payload, token, region)) eligibleTokens.push(token);
      }
      if (!this.payloadAuthorityCurrent(payload)) return;
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
    async processAreaBoundaryChange(region, before, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
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
          if (!this.payloadAuthorityCurrent(payload)) return;
          if (this.isTokenInside(region, token.uuid)) this.noteEffectiveOccupant(region, token, true);
          await this.processTriggerUnlocked(region, payload, token, "enter", batch + ":" + token.uuid);
        }
      }, lease);
    },

    /** Provides a locked entry point for source-turn hooks that may arrive concurrently. */
    async processSourceTurnStart(region, changedCombat = null, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !this.isLiveRegion(region)) return;
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
      }, lease);
    },

    /** Catches up source-turn effects after combat updates that do not name one Region. */
    async processAllSourceTurnStarts(changedCombat = null, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      for (const region of this.allZones()) await this.processSourceTurnStart(region, changedCombat, lease);
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
      if (!this.payloadAuthorityCurrent(payload) || !block.chatAlert?.enabled) return;
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
      if (!this.payloadAuthorityCurrent(payload) || !block.chatAlert?.enabled) return;
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

      if (!this.payloadAuthorityCurrent(payload)) return;
      await ChatMessage.create(messageData);
    },

    /** Watches authoritative actor HP changes and applies each crossed threshold to occupants. */
    async handleActorHitPointUpdate(actor, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !actor?.uuid) return;
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
        }, lease);
      }
    },

    /** Dispatches chat-card actions only to zones that observe the caster's location and the action that was actually used. */
    async handleTraitUseMessage(message, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;

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
        }, lease);
      }
    },

    /** Receives Region behavior events through the module API so existing zones use updated runtime code. */
    async handleRegionEvent({ event, region }, lease = this.captureAuthorityLease()) {
      this.installHooks();
      if (!this.authorityLeaseCurrent(lease) || !region) return;
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
          await this.activateRegion(region, lease);
          break;
        case "behaviorViewed":
          await this.activateRegion(region, lease);
          await this.checkSourceAndDuration(region, lease);
          break;
        case "behaviorDeactivated":
          // Region deletion deactivates the embedded behavior as part of
          // removing it. Do not write flags back into a Region whose
          // embedded behavior collection is already being torn down.
          if (this.endingZones.has(region.uuid)) break;
          await this.deactivateRegion(region, lease);
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
            if (!this.payloadAuthorityCurrent(payload)) return;
            this.seedHpBaseline(payload, token, { replace: true });
            const eligible = await this.eligible(payload, token, region);
            if (!this.payloadAuthorityCurrent(payload)) return;
            if (!eligible) {
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
          }, lease);
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
          }, lease);
          break;
        case "tokenTurnEnd":
          if (!token) break;
          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload) || !(await this.eligible(payload, token, region))) return;
            await this.processTriggerUnlocked(region, payload, token, "turnEnd", `turnEnd:${token.uuid}:${this.roundStamp(payload)}:${randomId()}`);
          }, lease);
          break;
      }
    },
  };
}

/** Provides one module runtime that both Foundry hooks and existing Region behaviors can call after updates. */
export async function zoneRuntimeEntrypoint(explicitContext = null) {
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
