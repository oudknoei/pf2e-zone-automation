import { highestClassOrSpellDc } from "./dc.js";
import { combatDurationDeadline } from "./duration-clock.js";
import { sweptAreaIntersectsToken, tokenBounds, translatedAreaShapes } from "./area-shape.js";

// Zone runtime extracted from PF2e Zone Builder v0.5.15.
/** Provides one module runtime that both Foundry hooks and existing Region behaviors can call after updates. */
export async function zoneRuntimeEntrypoint(explicitContext = null) {

    const VERSION = "0.5.16";
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
        chatAlertBatches: new Set(),
        regionReconcileTimers: new Map(),
        areaBoundaryBefore: new Map(),
        areaBoundarySuppression: new Map(),

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
          payload.state.resolvedSaves ??= {};
          payload.state.repeat ??= {};
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
          payload.state.activationFinalizeScheduled ??= false;
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

        /** Checks current geometry because a save may resolve after its target has left. */
        isTokenInside(region, tokenUuid) {
          return this.tokensInside(region).some((candidate) => candidate.uuid === tokenUuid);
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

        /** Applies targeting rules in one place so every trigger treats allies, enemies, and the source consistently. */
        async eligible(payload, token) {
          const targetActor = token?.actor;
          if (!targetActor?.isOfType?.("creature")) return false;
          const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
          if (!sourceActor) return false;

          const isSource = token.uuid === sourceToken?.uuid || targetActor.uuid === sourceActor.uuid;
          if (isSource) return Boolean(payload.config?.targeting?.includeSelf);

          switch (payload.config?.targeting?.affects) {
            case "allies":
              return Boolean(targetActor.isAllyOf?.(sourceActor));
            case "enemies":
              return Boolean(targetActor.isEnemyOf?.(sourceActor));
            case "both":
              // Keep the stored "both" value's existing unrestricted behavior for older zones.
              return true;
            case "none":
              return false;
            default:
              return false;
          }
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

        /** Records both combat and world-time limits so temporary immunity behaves across combat transitions. */
        makeExpiry(duration) {
          const rounds = duration === "1-round" ? 1
            : duration === "1-minute" ? 10
            : duration === "10-minutes" ? 100
            : null;
          if (!rounds) return null;
          const combat = game.combat;
          return {
            rounds,
            worldExpires: nowWorld() + rounds * 6,
            combatId: combat?.id ?? null,
            startRound: Number(combat?.round ?? 0),
            startTurn: Number(combat?.turn ?? 0)
          };
        },

        /** Lets immunity checks make one consistent decision regardless of how the duration was measured. */
        expiryActive(expiry) {
          if (!expiry) return false;
          const combat = game.combat;
          if (expiry.combatId && combat?.id === expiry.combatId) {
            const roundDelta = Number(combat.round ?? 0) - Number(expiry.startRound ?? 0);
            if (roundDelta < expiry.rounds) return true;
            if (roundDelta > expiry.rounds) return false;
            return Number(combat.turn ?? 0) < Number(expiry.startTurn ?? 0);
          }
          return nowWorld() < Number(expiry.worldExpires ?? 0);
        },

        /** Keeps round-based immunity from expiring early when combat state changes. */
        syncImmunityCombatClock(payload) {
          const combat = game.combat;
          if (!combat?.id) return;

          for (const record of Object.values(payload.state.immunities ?? {})) {
            const expiry = record?.expiry;
            if (!expiry || expiry.combatId) continue;

            // If world time really advanced past the immunity, leave it
            // expired rather than attaching it to a new encounter.
            if (nowWorld() >= Number(expiry.worldExpires ?? Infinity)) continue;

            // Immunities created before initiative started otherwise have no
            // encounter clock, and Foundry does not automatically advance
            // worldTime as rounds pass. Anchor them when combat becomes active.
            expiry.combatId = combat.id;
            expiry.startRound = Number(combat.round ?? 0);
            expiry.startTurn = Number(combat.turn ?? 0);
            expiry.anchoredFromWorldTime = true;
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
          const active = this.expiryActive(record.expiry);
          const combat = game.combat;
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
          let removed = 0;
          for (const [key, record] of Object.entries(payload.state.immunities ?? {})) {
            if (this.expiryActive(record?.expiry)) continue;
            delete payload.state.immunities[key];
            removed++;
          }
          if (removed) {
            console.info("PF2e Zone expired immunities pruned", {
              zone: payload.config.name,
              removed,
              combatRound: Number(game.combat?.round ?? 0),
              combatTurn: Number(game.combat?.turn ?? 0)
            });
          }
          return removed;
        },

        /** Records a temporary exclusion immediately after the outcome that should grant it. */
        setImmunity(payload, tokenUuid, block) {
          if (!block?.immunity || block.immunity.duration === "none") return;
          const expiry = this.makeExpiry(block.immunity.duration);
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
        roundStamp() {
          const combat = game.combat;
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
          return record?.round === this.roundStamp();
        },

        /** Records an accepted application so later hooks observe the configured frequency limit. */
        markRepeat(payload, tokenUuid, block) {
          const policy = block.repeat === "once-per-activation" ? "once-per-zone" : block.repeat;
          if (policy === "every") return;
          const key = this.repeatKey(tokenUuid, block.id);
          payload.state.repeat[key] ??= {};
          if (policy === "once-per-zone") payload.state.repeat[key].zone = true;
          else if (policy === "once-per-round") payload.state.repeat[key].round = this.roundStamp();
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

        /** Treats only an authorized completed save as final so forged chat cannot clear a pending request. */
        async completedOutcomeForPending(pending) {
          const token = await fromUuid(pending.tokenUuid);
          if (!token?.actor) return null;
          const messages = [...game.messages.contents].reverse();
          for (const message of messages) {
            const outcome = this.saveResultFromMessage(message, pending, token);
            if (outcome) return outcome;
          }
          return null;
        },

        /** Prevents a second save request while a creature still needs to choose or roll the first one. */
        async hasPending(payload, tokenUuid, blockId) {
          for (const [pendingId, pending] of Object.entries(payload.state.pendingSaves ?? {})) {
            if (pending.tokenUuid !== tokenUuid || pending.blockId !== blockId) continue;

            const tombstone = payload.state.resolvedSaves?.[pendingId];
            if (tombstone?.identifier === pending.identifier) {
              delete payload.state.pendingSaves[pendingId];
              console.info("PF2e Zone cleared resolved pending save", {
                zone: payload.config.name,
                pendingId,
                tokenUuid,
                blockId,
                completedOutcome: tombstone.outcome
              });
              continue;
            }

            const completedOutcome = await this.completedOutcomeForPending(pending);
            if (completedOutcome) {
              delete payload.state.pendingSaves[pendingId];
              console.info("PF2e Zone cleared stale pending save", {
                zone: payload.config.name,
                pendingId,
                tokenUuid,
                blockId,
                completedOutcome
              });
              continue;
            }

            return true;
          }
          return false;
        },

        /** Uses the source statistic at resolution time while protecting combined Class-or-Spell DCs from PF2e fallback data. */
        resolveDC(payload, block, sourceActor) {
          if (block.save.dc.mode === "custom") return Number(block.save.dc.value) || 0;
          if (block.save.dc.statistic === "class-spell") return highestClassOrSpellDc(sourceActor);
          const statistic = sourceActor?.getStatistic?.(block.save.dc.statistic);
          const value = statistic?.dc?.value ?? statistic?.dc ?? null;
          return Number.isFinite(Number(value)) ? Number(value) : null;
        },

        /** Identifies linked conditions so recovery watchers only observe outcomes this block can create. */
        inflictedSlugs(block) {
          const slugs = new Set();
          for (const outcome of Object.values(block.outcomes ?? {})) {
            for (const condition of outcome?.conditions ?? []) slugs.add(condition.slug);
          }
          return [...slugs];
        },

        /** Creates a single clear chat choice so the affected player can resolve the required save. */
        async postSaveRequest(region, payload, pending) {
          const buttons = pending.saveTypes.map((saveType) =>
            `<button type="button" data-pf2e-zone-save data-scene-id="${escHtml(region.parent.id)}" data-region-id="${escHtml(region.id)}" data-pending-id="${escHtml(pending.id)}" data-save-type="${escHtml(saveType)}"><i class="fa-solid fa-dice-d20"></i> ${escHtml(titleCaseLocal(saveType))}</button>`
          ).join(" ");

          const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
          const target = await fromUuid(pending.tokenUuid);
          const choiceText = pending.saveTypes.length > 1
            ? `<p><b>${escHtml(target?.name ?? "Target")}</b>: choose a save before rolling.</p>`
            : `<p><b>${escHtml(target?.name ?? "Target")}</b>: roll ${escHtml(titleCaseLocal(pending.saveTypes[0]))}.</p>`;

          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken }),
            content: `<div class="pf2e-zone-save-request"><h4>${escHtml(payload.config.name)} — ${escHtml(pending.blockName)}</h4>${choiceText}<p><b>DC ${pending.dc}</b></p><div class="message-buttons">${buttons}</div><p style="opacity:.7;font-size:.9em">PF2e Zone Automation save request</p></div>`,
            flags: { world: { pf2eZoneSaveRequest: { identifier: pending.identifier } } }
          });
        },

        /** Records a pending save before chat output so late or duplicate clicks remain safe to handle. */
        async requestSave(region, payload, block, token, trigger, batchId, eventContext = {}) {
          if (await this.hasPending(payload, token.uuid, block.id)) {
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
            createdWorldTime: nowWorld()
          };
          payload.state.pendingSaves[id] = pending;
          this.markRepeat(payload, token.uuid, block);

          // Do not expose a clickable save button until the enclosing Region
          // state transaction has committed the pending record.
          this.queueAfterCommit(payload, async () => {
            const liveRegion = region.parent?.regions?.get?.(region.id);
            if (!liveRegion) return;

            const committed = this.readPayload(liveRegion);
            const committedPending = committed?.state?.pendingSaves?.[id];
            if (!committedPending || committedPending.identifier !== identifier) return;

            await this.postSaveRequest(liveRegion, committed, committedPending);
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

        /** Serializes item deletion so linked cleanup does not create Foundry collection errors. */
        async deleteOwnedItem(item, context = "zone cleanup") {
          if (!item?.parent) return;
          const key = this.itemDeleteKey(item);
          if (this.deletingItems.has(key)) return;

          this.deletingItems.add(key);
          try {
            // Re-resolve from the actor collection so a stale Item document
            // cannot issue a second embedded delete after another cleanup path
            // already removed it.
            const live = item.parent?.items?.get?.(item.id);
            if (live) await live.delete();
          } catch (error) {
            if (!/does not exist|undefined id/i.test(String(error?.message ?? error))) {
              console.warn(`PF2e Zone: ${context} failed`, item, error);
            }
          } finally {
            // deleteItem hooks run during the document operation. Keep the
            // suppression key alive through the next task so those hooks do not
            // immediately recurse into dependency reconciliation.
            setTimeout(() => this.deletingItems.delete(key), 50);
          }
        },

        /** Gives each zone result its own Condition Item so cleanup cannot affect another source. */
        async addOwnedCondition(region, payload, block, token, condition) {
          const actor = token.actor;
          if (!actor) return false;

          const duplicate = actor.items.find((item) => {
            const flag = this.zoneItemFlag(item);
            return item.type === "condition" && flag?.zoneUuid === region.uuid && flag?.blockId === block.id && flag?.slug === condition.slug && flag?.removal === condition.removal;
          });
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

        /** Copies Effect Items with cleanup metadata so their removal follows the zone configuration. */
        async addEffectItem(region, payload, block, token, effect) {
          const actor = token.actor;
          if (!actor) return false;

          const duplicate = actor.items.find((item) => {
            const flag = this.zoneItemFlag(item);
            return flag?.kind === "effect" && flag?.zoneUuid === region.uuid && flag?.blockId === block.id && flag?.originalUuid === effect.uuid;
          });
          if (duplicate) return true;

          const template = await fromUuid(effect.uuid);
          if (!template || template.documentName !== "Item" || template.type !== "effect") {
            ui.notifications.error(`PF2e Zone: PF2e Effect Item not found: ${effect.uuid}`);
            return false;
          }
          const source = template.toObject();
          delete source._id;
          delete source.folder;

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
            removal: effect.removal
          });

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
            removal: effect.removal
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
        async applyOutcome(region, payload, block, token, outcomeKey, batchId, eventContext = {}, { maintainedOnly = false } = {}) {
          const outcome = block.outcomes?.[outcomeKey];
          if (!outcome) return false;
          let affected = false;
          let exitBoundAffected = false;

          for (const condition of outcome.conditions ?? []) {
            if (condition.removal === "on-exit" && !this.isTokenInside(region, token.uuid)) continue;
            const applied = await this.addCondition(region, payload, block, token, condition);
            if (condition.removal === "on-exit") exitBoundAffected = applied || exitBoundAffected;
            else affected = applied || affected;
          }
          for (const effect of outcome.effects ?? []) {
            if (effect.removal === "on-exit" && !this.isTokenInside(region, token.uuid)) continue;
            const applied = await this.addEffectItem(region, payload, block, token, effect);
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
          if (this.isTokenInside(region, token.uuid)) affected = exitBoundAffected || affected;
          else await this.cleanupTokenOnExitUnlocked(payload, token.uuid);
          // Chat alerts are emitted once per trigger event by processBlock(),
          // independently of whether this outcome affects one or many targets.
          return affected;
        },

        /** Tracks conditions that must end before a zone grants temporary immunity. */
        registerRecoveryWatcher(payload, block, token) {
          if (!block.immunity?.starts?.includes("condition-recovery")) return;
          const condition = block.immunity.recoveryCondition;
          if (!condition) return;
          const key = randomId();
          payload.state.recoveryWatchers[key] = {
            tokenUuid: token.uuid,
            actorUuid: token.actor?.uuid ?? null,
            blockId: block.id,
            condition,
            duration: block.immunity.duration
          };
        },

        /** Applies immunity only for the selected outcome conditions rather than whenever a block runs. */
        applyImmunityStarts(payload, block, token, outcomeKey, affected, hadSave) {
          const starts = block.immunity?.starts ?? [];
          let startNow = false;
          if (hadSave && starts.includes("after-save")) startNow = true;
          if (hadSave && starts.includes("success-or-better") && this.outcomeIsSuccessOrBetter(outcomeKey)) startNow = true;
          if (hadSave && starts.includes("failure-or-worse") && this.outcomeIsFailureOrWorse(outcomeKey)) startNow = true;
          if (starts.includes("affected") && affected) startNow = true;
          if (startNow) this.setImmunity(payload, token.uuid, block);
          if (affected) this.registerRecoveryWatcher(payload, block, token);
        },

        /** Coordinates eligibility, frequency, saves, and results so every trigger follows the same safeguards. */
        async processBlock(region, payload, block, token, trigger, batchId, { continuous = false, eventContext = {}, skipEligibility = false } = {}) {
          const resolvedEventContext = { trigger, ...(eventContext ?? {}) };
          if (!skipEligibility && !(await this.eligible(payload, token))) {
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
            const affected = await this.applyOutcome(region, payload, block, token, "noSave", batchId, resolvedEventContext);
            this.applyImmunityStarts(payload, block, token, "noSave", affected, false);
            return;
          }

          if (block.save.enabled) {
            await this.requestSave(region, payload, block, token, trigger, batchId, resolvedEventContext);
            return;
          }

          this.markRepeat(payload, token.uuid, block);
          const affected = await this.applyOutcome(region, payload, block, token, "noSave", batchId, resolvedEventContext);
          this.applyImmunityStarts(payload, block, token, "noSave", affected, false);
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
        combatTurnKey(combat = game.combat) {
          const active = combat?.combatant ?? null;
          return combat?.id && active
            ? `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${active.id}`
            : null;
        },

        /** Processes occupant turn effects inside an existing state lock to prevent duplicate applications. */
        async processTurnStartUnlocked(region, payload, token, batchPrefix = "turnStart") {
          if (!(await this.eligible(payload, token))) return;

          // Region reshaping can transiently drop and re-add token membership.
          // Both Foundry's Region behavior and our combat-hook fallback can
          // therefore observe the same turn start. Persist one key per token so
          // the trigger is processed only once for the active combat turn.
          const turnKey = this.combatTurnKey();
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
            `${batchPrefix}:${token.uuid}:${turnKey ?? this.roundStamp()}:${randomId()}`
          );
        },

        /** Handles the current combatant once even if Foundry announces the turn through multiple hooks. */
        async processActiveTurnStart(region) {
          if (!this.isAuthority() || !this.isLiveRegion(region)) return;
          const combat = game.combat;
          const active = combat?.combatant ?? null;
          const token = active?.token ?? null;
          if (!combat || !active || !token || token.parent?.id !== region.parent?.id) return;

          // Geometry is authoritative here. This intentionally does not rely on
          // RegionDocument.tokens because moving/resizing a Region can make that
          // membership collection transiently stale.
          if (!this.tokensInside(region).some((candidate) => candidate.uuid === token.uuid)) return;

          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload)) return;
            if (!(payload.config.effects ?? []).some((block) => block.triggers?.turnStart)) return;
            await this.processTurnStartUnlocked(region, payload, token, "combatTurnStart");
          });
        },

        /** Catches up active zones after combat state changes that skip an individual turn hook. */
        async processAllActiveTurnStarts() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.processActiveTurnStart(region);
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

        /** Removes the stored cleanup reference only after its item or condition is no longer relevant. */
        async deleteAppliedRecord(payload, recordId) {
          const record = payload.state.applied[recordId];
          if (!record) return;
          const { actor } = await this.resolveTarget(record);
          const item = actor?.items?.get(record.itemId);
          if (item) await this.deleteOwnedItem(item, "failed to delete owned item");
          delete payload.state.applied[recordId];
        },

        /** Removes only exit-bound effects when a creature leaves while preserving other zone results. */
        async cleanupTokenOnExitUnlocked(payload, tokenUuid) {
          const records = Object.entries(payload.state.applied)
            .filter(([, record]) => record.tokenUuid === tokenUuid && record.removal === "on-exit");
          for (const [recordId] of records) await this.deleteAppliedRecord(payload, recordId);
        },

        /** Collects all remaining zone-owned changes when a Region ends. */
        async cleanupZoneUnlocked(payload) {
          const records = Object.entries(payload.state.applied)
            .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
          for (const [recordId] of records) await this.deleteAppliedRecord(payload, recordId);
          payload.state.pendingSaves = {};
          payload.state.recoveryWatchers = {};
          payload.state.deactivated = true;
        },

        /** Saves deactivation before deleting owned effects so later events see an inactive zone. */
        async deactivateRegion(region) {
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

        /** Finishes cleanup when Foundry deletes a Region outside the normal end-zone path. */
        async cleanupDeletedRegion(region, payload) {
          const records = Object.entries(payload?.state?.applied ?? {})
            .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
          for (const [, record] of records) {
            const { actor } = await this.resolveTarget(record);
            const item = actor?.items?.get(record.itemId);
            if (item) await this.deleteOwnedItem(item, "cleanup after Region deletion");
          }
        },

        /** Aligns maintained effects with current occupants after missed or reordered Region events. */
        async reconcileContinuousUnlocked(region, payload) {
          const insideTokens = this.tokensInside(region);
          const inside = new Set(insideTokens.map((t) => t.uuid));

          // Remove on-exit zone-owned data from tokens that are no longer both
          // inside and eligible. This also catches alliance changes on a later reconcile.
          for (const [recordId, record] of Object.entries(payload.state.applied)) {
            if (record.removal !== "on-exit") continue;
            const token = record.tokenUuid ? await fromUuid(record.tokenUuid) : null;
            const eligible = token && inside.has(record.tokenUuid) && await this.eligible(payload, token);
            if (!eligible) await this.deleteAppliedRecord(payload, recordId);
          }

          const eligibleTokens = [];
          for (const token of insideTokens) {
            if (await this.eligible(payload, token)) eligibleTokens.push(token);
          }
          const batch = `continuous:${this.roundStamp()}:${randomId()}`;
          const count = eligibleTokens.length;
          for (const token of eligibleTokens) {
            await this.processContinuousUnlocked(region, payload, token, batch, { count });
          }
        },

        /** Remembers the old footprint so a later Region update can find creatures crossed by a drag. */
        captureAreaBoundary(region) {
          const payload = this.readPayload(region);
          if (!this.isOperational(region, payload) || payload.config?.mode !== "area") return;
          this.areaBoundaryBefore.set(region.uuid, {
            shapes: [...region.shapes].map((shape) => shape.toObject?.() ?? clone(shape)),
            occupants: new Set(this.tokensInside(region).map((token) => token.uuid))
          });
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
          const afterShapes = [...region.shapes].map((shape) => shape.toObject?.() ?? clone(shape));
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
              if (!(await this.eligible(payload, token))) continue;
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
          if (!(await this.eligible(payload, token))) return;

          for (const block of payload.config.effects ?? []) {
            if (!block.triggers?.activation) continue;
            const key = stateKey("activation", block.id, token.uuid);
            if (payload.state.activationTargets[key]) continue;

            // Mark only after the block successfully begins processing. For saves,
            // requestSave() creates the pending workflow before returning.
            let count = 0;
            for (const candidate of this.tokensInside(region)) {
              if (!(await this.eligible(payload, candidate))) continue;
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

        /** Initializes a newly created Region before delayed hooks can process its occupants. */
        async activateRegion(region) {
          if (!this.isAuthority() || !this.isRuntimeBehaviorActive(region)) return;

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
          let scheduleFinalize = false;

          await this.withState(region, async (payload) => {
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

              if (!payload.state.activationFinalizeScheduled) {
                payload.state.activationFinalizeScheduled = true;
                scheduleFinalize = true;
              }
            }

            payload.state.deactivated = false;
            await this.reconcileContinuousUnlocked(region, payload);
          });

          if (scheduleFinalize) {
            setTimeout(async () => {
              if (!region?.parent || !this.isAuthority()) return;
              try {
                await this.withState(region, async (payload) => {
                  if (!this.isOperational(region, payload) || payload.state.activationProcessed) return;

                  // Final sweep after Region membership has had time to settle.
                  const batchSeed = randomId();
                  for (const token of region.tokens) {
                    await this.processActivationTokenUnlocked(region, payload, token, batchSeed);
                  }

                  payload.state.activationProcessed = true;
                  payload.state.activationPending = false;
                  payload.state.activationFinalizeScheduled = false;
                  payload.state.initialOccupants = {};
                });
              } catch (error) {
                console.error("PF2e Zone: activation finalization failed", error);
              }
            }, 1000);
          }
        },

        /** Resolves the source against the current roster so a removed combatant cannot hold a stale turn clock. */
        combatantForSource(combat, sourceToken, sourceActor, recordedId) {
          const roster = Array.isArray(combat?.turns) && combat.turns.length
            ? combat.turns
            : Array.from(combat?.combatants?.contents ?? combat?.combatants ?? []);
          return roster.find((entry) => entry.token?.uuid === sourceToken?.uuid)
            ?? roster.find((entry) => entry.id === recordedId && (!sourceActor || entry.actor?.uuid === sourceActor.uuid))
            ?? roster.find((entry) => entry.actor?.uuid === sourceActor?.uuid)
            ?? null;
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

            const combat = game.combat;
            if (!combat?.id) {
              shouldEnd = worldExpired;
              return;
            }

            const sourceCombatant = this.combatantForSource(combat, sourceToken, sourceActor, d.sourceCombatantId);
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
        async processSourceTurnStart(region) {
          if (!this.isAuthority() || !this.isLiveRegion(region)) return;

          await this.withState(region, async (payload) => {
            if (!this.isOperational(region, payload)) return;
            if (!(payload.config.effects ?? []).some((block) => block.triggers?.sourceTurnStart)) return;

            const combat = game.combat;
            const active = combat?.combatant ?? null;
            if (!combat || !active) return;

            const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
            if (!sourceToken || !sourceActor) return;

            const sourceCombatant = combat.combatants?.find?.((combatant) =>
              combatant?.token?.uuid === sourceToken.uuid || combatant?.actor?.uuid === sourceActor.uuid
            ) ?? sourceActor.combatant ?? null;
            if (!sourceCombatant || active.id !== sourceCombatant.id) return;

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
        async processAllSourceTurnStarts() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.processSourceTurnStart(region);
        },

        /** Uses one orderly end path so Region deletion always cleans linked conditions and Effect Items. */
        async endZone(region, reason = "ended") {
          const scene = region?.parent;
          const regionId = region?.id;
          if (!scene || !regionId) return;

          // Always resolve the currently embedded Region document. A stale
          // Region object may retain its parent after another hook has already
          // deleted it from the Scene collection.
          const liveRegion = scene.regions?.get?.(regionId);
          if (!liveRegion) return;

          const key = liveRegion.uuid;
          if (this.endingZones.has(key)) return;
          this.endingZones.add(key);

          const reconcileTimer = this.regionReconcileTimers.get(key);
          if (reconcileTimer) clearTimeout(reconcileTimer);
          this.regionReconcileTimers.delete(key);

          try {
            // Allow already accepted state work to commit before deleting the
            // Region. New work is rejected by withState while endingZones holds
            // this key, so no late update can target the deleted document.
            const pending = this.locks.get(key);
            if (pending) await pending.catch(() => undefined);

            // The Region is about to be deleted, so cleanup only needs to remove
            // owned effects and pending workflows. Writing the modified payload
            // back first creates an unnecessary embedded-document update race.
            const regionForCleanup = scene.regions?.get?.(regionId);
            const payload = regionForCleanup ? this.readPayload(regionForCleanup) : null;
            if (payload) await this.cleanupZoneUnlocked(payload);

            // Re-resolve after cleanup in case another concurrent lifecycle
            // event removed the Region while cleanup awaited embedded updates.
            const stillLive = scene.regions?.get?.(regionId);
            if (stillLive) await stillLive.delete();
          } catch (error) {
            // Deletion is intentionally idempotent. If Foundry reports that a
            // concurrent caller already removed it, there is nothing left to do.
            if (/does not exist/i.test(String(error?.message ?? error))) return;
            console.error(`PF2e Zone: failed to end zone (${reason})`, liveRegion, error);
            ui.notifications.error(`PF2e Zone: failed to end '${liveRegion.name}'. See console.`);
          } finally {
            this.endingZones.delete(key);
          }
        },

        /** Accepts a save result once and applies its outcome only after authorization and state checks pass. */
        async resolvePendingSave(region, pendingId, identifier, outcome, rollerActorUuid = null, message = null) {
          if (!this.isAuthority()) return false;
          if (!["criticalSuccess", "success", "failure", "criticalFailure"].includes(outcome)) return false;

          let resolved = false;
          await this.withState(region, async (payload) => {
            if (payload.state.resolvedSaves?.[pendingId]?.identifier === identifier) {
              delete payload.state.pendingSaves[pendingId];
              return;
            }

            if (!this.isOperational(region, payload)) return;
            const pending = payload.state.pendingSaves[pendingId];
            if (!pending || pending.identifier !== identifier) return;

            const block = payload.config.effects?.find((b) => b.id === pending.blockId);
            const token = await fromUuid(pending.tokenUuid);
            if (!block || !token?.actor) {
              delete payload.state.pendingSaves[pendingId];
              return;
            }

            if (rollerActorUuid !== token.actor.uuid) return;
            if (pending.actorUuid && pending.actorUuid !== token.actor.uuid) return;
            if (message && this.saveResultFromMessage(message, pending, token) !== outcome) return;

            // Delete before applying the result. Keep a small persistent
            // tombstone as well, so a duplicated resolver cannot apply the same
            // save twice even if an older pending snapshot resurfaces.
            delete payload.state.pendingSaves[pendingId];
            payload.state.resolvedSaves[pendingId] = {
              identifier,
              outcome,
              resolvedWorldTime: nowWorld()
            };

            const affected = await this.applyOutcome(
              region,
              payload,
              block,
              token,
              outcome,
              pending.batchId,
              pending.eventContext ?? { trigger: pending.trigger }
            );
            this.applyImmunityStarts(payload, block, token, outcome, affected, true);
            resolved = true;

            console.info("PF2e Zone save resolved", {
              zone: payload.config.name,
              regionUuid: region.uuid,
              block: block.name,
              token: token.name,
              pendingId,
              outcome
            });
          });

          if (resolved && this.isLiveRegion(region)) {
            const persisted = this.readPayload(region);
            const persistedPending = persisted?.state?.pendingSaves?.[pendingId] ?? null;
            const resolvedRecord = persisted?.state?.resolvedSaves?.[pendingId] ?? null;
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
              resolvedRecordPresent: Boolean(resolvedRecord),
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
            await this.withState(region, async (payload) => {
              if (!this.isOperational(region, payload)) return;
              for (const [key, watcher] of Object.entries(payload.state.recoveryWatchers)) {
                if (watcher.actorUuid !== actor.uuid) continue;
                const remaining = actor.conditions?.bySlug?.(watcher.condition, { active: true }) ?? [];
                if (remaining.length) continue;
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
            count: values.count
          };
          return String(template ?? "").replace(/\{(zone|block|creature|item|source|trait|trigger|count)\}/gi, (_match, key) => {
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
            trigger: trigger ? titleCaseLocal(trigger) : "",
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
          this.areaBoundaryBefore.clear();
          for (const entry of this.areaBoundarySuppression.values()) clearTimeout(entry.timer);
          this.areaBoundarySuppression.clear();

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
          on("updateItem", itemChanged);
          on("deleteItem", itemChanged);

          on("updateCombat", async () => {
            try {
              await runtime.checkAllDurations();
              await runtime.processAllSourceTurnStarts();
              await runtime.processAllActiveTurnStarts();
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

          on("deleteToken", (token) => {
            if (!runtime.isAuthority()) return;
            for (const region of runtime.allZones()) {
              const payload = runtime.readPayload(region);
              if (payload?.config?.mode === "emanation" && payload.state.sourceTokenUuid === token.uuid) {
                runtime.endZone(region, "source token deleted").catch((e) => console.error("PF2e Zone source cleanup", e));
              }
            }
          });

          on("preUpdateRegion", (region, changes) => {
            if (!runtime.isAuthority()) return;
            if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "shapes")) return;
            runtime.captureAreaBoundary(region);
          });

          on("updateRegion", (region, changes) => {
            if (!runtime.isAuthority()) return;
            if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "shapes")) return;
            const before = runtime.areaBoundaryBefore.get(region.uuid);
            runtime.areaBoundaryBefore.delete(region.uuid);
            if (!runtime.isOperational(region)) return;

            // Foundry reports destination entry, but a dragged area can pass
            // over a token that is outside again at the end of the move.
            if (before) runtime.processAreaBoundaryChange(region, before)
              .catch((e) => console.error("PF2e Zone area movement", e));

            // Resizing can also emit transient exits. Reconcile maintained
            // effects after membership has settled.
            runtime.scheduleRegionReconcile(region, 100);
          });

          on("deleteRegion", (region) => {
            runtime.areaBoundaryBefore.delete(region.uuid);
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

          /** Handles save buttons centrally so chat interactions remain GM-authoritative. */
          const clickHandler = async (event) => {
            const button = event.target?.closest?.("button[data-pf2e-zone-save]");
            if (!button) return;
            event.preventDefault();

            const sceneId = button.dataset.sceneId;
            const regionId = button.dataset.regionId;
            const pendingId = button.dataset.pendingId;
            const saveType = button.dataset.saveType;
            const region = game.scenes.get(sceneId)?.regions.get(regionId);
            const payload = region ? runtime.readPayload(region) : null;
            const pending = payload?.state?.pendingSaves?.[pendingId];
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

          // Catch any linked-condition records left from a zone that ended earlier.
          setTimeout(() =>
            this.reconcileAllLinkedConditions()
              .catch((e) => console.error("PF2e Zone initial condition reconcile", e)), 0
          );

          // Recover disabled behavior state and overdue zones after a GM reconnect.
          setTimeout(async () => {
            try {
              await this.reconcileDisabledZones();
              await this.checkAllDurations();
            } catch (error) {
              console.error("PF2e Zone initial zone reconcile", error);
            }
          }, 0);
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
            console.info("PF2e Zone Region event", {
              event: name,
              zone: region.name,
              regionUuid: region.uuid,
              token: token?.name ?? null,
              tokenUuid: token?.uuid ?? null,
              combatRound: Number(game.combat?.round ?? 0),
              combatTurn: Number(game.combat?.turn ?? 0)
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
                this.areaBoundarySuppression.get(region.uuid)?.tokens.has(token.uuid)
              )) break;
              await this.withState(region, async (payload) => {
                if (!this.isOperational(region, payload) || !(await this.eligible(payload, token))) return;
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
                if (!this.isOperational(region, payload) || !(await this.eligible(payload, token))) return;
                await this.processTriggerUnlocked(region, payload, token, "turnEnd", `turnEnd:${token.uuid}:${this.roundStamp()}:${randomId()}`);
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

