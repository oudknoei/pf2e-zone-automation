// Zone runtime extracted from PF2e Zone Builder v0.5.13.
export async function zoneRuntimeEntrypoint(explicitContext = null) {

    const VERSION = "0.5.13";
    const FLAG_SCOPE = "world";
    const FLAG_KEY = "pf2eZone";
    const SAVE_PREFIX = "pf2e-zone";
    const fu = foundry.utils;

    const clone = (obj) => {
      if (globalThis.structuredClone) return structuredClone(obj);
      return JSON.parse(JSON.stringify(obj));
    };

    const escHtml = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    const titleCaseLocal = (slug) => String(slug ?? "")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());

    const randomId = () => fu.randomID?.(12) ?? crypto.randomUUID().slice(0, 12);
    const nowWorld = () => Number(game.time?.worldTime ?? 0);
    const stateKey = (...parts) => parts
      .map((part) => String(part ?? "").replace(/[^A-Za-z0-9_-]/g, "_"))
      .join("__");

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

    function createRuntime() {
      const rt = {
        version: VERSION,
        locks: new Map(),
        hooksInstalled: false,
        endingZones: new Set(),
        deletingItems: new Set(),
        chatAlertBatches: new Set(),
        regionReconcileTimers: new Map(),

        isAuthority() {
          const activeGM = game.users?.activeGM ?? null;
          return activeGM ? activeGM.id === game.user.id : Boolean(game.user?.isGM);
        },

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

        isLiveRegion(region) {
          const scene = region?.parent;
          return Boolean(scene?.regions?.get?.(region.id));
        },

        async writePayload(region, payload) {
          if (!this.isLiveRegion(region)) return;

          const path = `flags.${FLAG_SCOPE}.${FLAG_KEY}`;

          // Foundry document updates recursively merge objects by default.
          // That is wrong for our runtime state because deleting a pending
          // save/immunity/applied-record from the local object must also delete
          // it from the persisted Region flag. V14's _replace operator makes
          // this payload an authoritative snapshot.
          if (typeof globalThis._replace === "function") {
            await region.update({ [path]: globalThis._replace(payload) });
            return;
          }

          // Defensive fallback for an unexpected V14 build where the documented
          // global operator is unavailable. Slower, but preserves replacement
          // semantics rather than silently merging stale runtime keys.
          await region.unsetFlag(FLAG_SCOPE, FLAG_KEY);
          if (this.isLiveRegion(region)) {
            await region.setFlag(FLAG_SCOPE, FLAG_KEY, payload);
          }
        },

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

        async withState(region, callback) {
          if (!region?.uuid) return null;
          const key = region.uuid;
          const prior = this.locks.get(key) ?? Promise.resolve();
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
            if (this.isLiveRegion(region)) await this.writePayload(region, payload);

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

        allZones() {
          return game.scenes.contents.flatMap((scene) =>
            [...scene.regions].filter((region) => Boolean(region.getFlag(FLAG_SCOPE, FLAG_KEY)))
          );
        },

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

        async resolveSource(payload) {
          const token = payload?.state?.sourceTokenUuid ? await fromUuid(payload.state.sourceTokenUuid) : null;
          const actor = token?.actor ?? (payload?.state?.sourceActorUuid ? await fromUuid(payload.state.sourceActorUuid) : null);
          return { token, actor };
        },

        async resolveTarget(record) {
          const token = record?.tokenUuid ? await fromUuid(record.tokenUuid) : null;
          const actor = token?.actor ?? (record?.actorUuid ? await fromUuid(record.actorUuid) : null);
          return { token, actor };
        },

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
              // "Both" is the portable representation for unrestricted "a creature" targeting.
              return true;
            default:
              return false;
          }
        },

        durationRounds(config) {
          switch (config?.duration?.type) {
            case "1-round": return 1;
            case "custom-rounds": return Math.max(1, Number(config.duration.rounds) || 1);
            case "1-minute": return 10;
            case "10-minutes": return 100;
            default: return null;
          }
        },

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

        repeatKey(tokenUuid, blockId) {
          return stateKey("repeat", tokenUuid, blockId);
        },

        roundStamp() {
          const combat = game.combat;
          return combat?.id
            ? `${combat.id}:${Number(combat.round ?? 0)}`
            : `world:${Math.floor(nowWorld() / 6)}`;
        },

        repeatBlocked(payload, tokenUuid, block) {
          const policy = block.repeat === "once-per-activation" ? "once-per-zone" : block.repeat;
          if (policy === "every") return false;
          const key = this.repeatKey(tokenUuid, block.id);
          const record = payload.state.repeat[key];
          if (policy === "once-per-zone") return Boolean(record?.zone);
          return record?.round === this.roundStamp();
        },

        markRepeat(payload, tokenUuid, block) {
          const policy = block.repeat === "once-per-activation" ? "once-per-zone" : block.repeat;
          if (policy === "every") return;
          const key = this.repeatKey(tokenUuid, block.id);
          payload.state.repeat[key] ??= {};
          if (policy === "once-per-zone") payload.state.repeat[key].zone = true;
          else if (policy === "once-per-round") payload.state.repeat[key].round = this.roundStamp();
        },

        outcomeFromDegree(degree) {
          return ["criticalFailure", "failure", "success", "criticalSuccess"][Number(degree)] ?? null;
        },

        completedOutcomeForPending(pending) {
          const messages = [...game.messages.contents].reverse();
          for (const message of messages) {
            const context = message.flags?.pf2e?.context;
            if (context?.identifier !== pending.identifier) continue;

            if (["criticalSuccess", "success", "failure", "criticalFailure"].includes(context?.outcome)) {
              return context.outcome;
            }

            for (const roll of message.rolls ?? []) {
              const identifier = roll?.options?.identifier;
              if (identifier && identifier !== pending.identifier) continue;
              const outcome = this.outcomeFromDegree(roll?.degreeOfSuccess);
              if (outcome) return outcome;
            }
          }
          return null;
        },

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

            const completedOutcome = this.completedOutcomeForPending(pending);
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

        resolveDC(payload, block, sourceActor) {
          if (block.save.dc.mode === "custom") return Number(block.save.dc.value) || 0;
          const statistic = sourceActor?.getStatistic?.(block.save.dc.statistic);
          const value = statistic?.dc?.value ?? statistic?.dc ?? null;
          return Number.isFinite(Number(value)) ? Number(value) : null;
        },

        inflictedSlugs(block) {
          const slugs = new Set();
          for (const outcome of Object.values(block.outcomes ?? {})) {
            for (const condition of outcome?.conditions ?? []) slugs.add(condition.slug);
          }
          return [...slugs];
        },

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

        outcomeIsSuccessOrBetter(outcome) {
          return outcome === "success" || outcome === "criticalSuccess";
        },

        outcomeIsFailureOrWorse(outcome) {
          return outcome === "failure" || outcome === "criticalFailure";
        },

        async addNormalCondition(actor, condition) {
          try {
            const desired = condition.value == null ? null : Number(condition.value);
            const existing = actor.conditions?.bySlug?.(condition.slug, { active: true }) ?? [];

            // PF2e valued conditions do not add together unless an effect
            // explicitly says to increase the value. "Become frightened 4"
            // means the effective value is at least 4, not current + 4.
            if (Number.isFinite(desired)) {
              const activeValued = existing
                .filter((c) => Number.isFinite(Number(c.value)))
                .sort((a, b) => Number(b.value) - Number(a.value));
              const current = activeValued[0] ?? null;

              if (current && Number(current.value) >= desired) return current;

              if (current) {
                await game.pf2e.ConditionManager.updateConditionValue(current.id, actor, desired);
                return actor.items.get(current.id) ?? current;
              }

              return await actor.increaseCondition(condition.slug, { value: desired });
            }

            // Unvalued conditions likewise do not need duplicate applications.
            if (existing.length) return existing[0];
            return await actor.increaseCondition(condition.slug);
          } catch (error) {
            console.error("PF2e Zone: failed to apply condition", condition, actor, error);
            ui.notifications.error(`PF2e Zone: failed to apply ${condition.slug} to ${actor.name}.`);
            return null;
          }
        },

        zoneItemFlag(item) {
          return fu.getProperty(item, `flags.${FLAG_SCOPE}.${FLAG_KEY}`) ?? null;
        },

        itemDeleteKey(item) {
          return `${item?.parent?.uuid ?? "Actor"}::${item?.id ?? "Item"}`;
        },

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
          return true;
        },

        async addCondition(region, payload, block, token, condition) {
          if (condition.removal === "normal") {
            const applied = await this.addNormalCondition(token.actor, condition);
            return Boolean(applied);
          }
          return this.addOwnedCondition(region, payload, block, token, condition);
        },

        async addEffectItem(region, payload, block, token, effect) {
          const actor = token.actor;
          if (!actor) return false;

          const duplicate = actor.items.find((item) => {
            const flag = this.zoneItemFlag(item);
            return flag?.kind === "effect" && flag?.zoneUuid === region.uuid && flag?.blockId === block.id && flag?.originalUuid === effect.uuid;
          });
          if (duplicate) return true;

          const template = await fromUuid(effect.uuid);
          if (!template || template.documentName !== "Item") {
            ui.notifications.error(`PF2e Zone: Effect Item not found: ${effect.uuid}`);
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

        damageRollClass() {
          return CONFIG.Dice?.rolls?.find((cls) => cls?.name === "DamageRoll") ?? null;
        },

        damageType(payload, block) {
          if (block.damage.typeMode === "activation-choice") {
            return payload.state.activation?.damageType ?? block.damage.type ?? "untyped";
          }
          return block.damage.type ?? "untyped";
        },

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

        async applyOutcome(region, payload, block, token, outcomeKey, batchId, eventContext = {}) {
          const outcome = block.outcomes?.[outcomeKey];
          if (!outcome) return false;
          let affected = false;

          for (const condition of outcome.conditions ?? []) {
            affected = (await this.addCondition(region, payload, block, token, condition)) || affected;
          }
          for (const effect of outcome.effects ?? []) {
            affected = (await this.addEffectItem(region, payload, block, token, effect)) || affected;
          }
          if (block.damage.enabled && Number(outcome.damageMultiplier) > 0) {
            affected = (await this.postDamage(region, payload, block, token, outcomeKey, outcome.damageMultiplier, batchId)) || affected;
          }
          if (block.healing?.enabled && Number(outcome.damageMultiplier) > 0) {
            affected = (await this.postHealing(region, payload, block, token, outcomeKey, outcome.damageMultiplier, batchId)) || affected;
          }
          // Chat alerts are emitted once per trigger event by processBlock(),
          // independently of whether this outcome affects one or many targets.
          return affected;
        },

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
            console.info("PF2e Zone trigger blocked: repeat policy", {
              zone: payload.config.name, block: block.name, trigger, token: token.name, repeat: block.repeat
            });
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
              resolvedEventContext,
              block.save?.enabled ? null : "noSave"
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

        combatTurnKey(combat = game.combat) {
          const active = combat?.combatant ?? null;
          return combat?.id && active
            ? `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${active.id}`
            : null;
        },

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
            if (payload.state?.deactivated) return;
            if (!(payload.config.effects ?? []).some((block) => block.triggers?.turnStart)) return;
            await this.processTurnStartUnlocked(region, payload, token, "combatTurnStart");
          });
        },

        async processAllActiveTurnStarts() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.processActiveTurnStart(region);
        },

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

        async deleteAppliedRecord(payload, recordId) {
          const record = payload.state.applied[recordId];
          if (!record) return;
          const { actor } = await this.resolveTarget(record);
          const item = actor?.items?.get(record.itemId);
          if (item) await this.deleteOwnedItem(item, "failed to delete owned item");
          delete payload.state.applied[recordId];
        },

        async cleanupTokenOnExitUnlocked(payload, tokenUuid) {
          const records = Object.entries(payload.state.applied)
            .filter(([, record]) => record.tokenUuid === tokenUuid && record.removal === "on-exit");
          for (const [recordId] of records) await this.deleteAppliedRecord(payload, recordId);
        },

        async cleanupZoneUnlocked(payload) {
          const records = Object.entries(payload.state.applied)
            .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
          for (const [recordId] of records) await this.deleteAppliedRecord(payload, recordId);
          payload.state.pendingSaves = {};
          payload.state.recoveryWatchers = {};
          payload.state.deactivated = true;
        },

        async cleanupDeletedRegion(region, payload) {
          const records = Object.entries(payload?.state?.applied ?? {})
            .filter(([, record]) => record.removal === "on-exit" || record.removal === "zone-end");
          for (const [, record] of records) {
            const { actor } = await this.resolveTarget(record);
            const item = actor?.items?.get(record.itemId);
            if (item) await this.deleteOwnedItem(item, "cleanup after Region deletion");
          }
        },

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
                if (payload.state?.deactivated) return;
                await this.reconcileContinuousUnlocked(liveRegion, payload);
              });
            } catch (error) {
              console.error("PF2e Zone: Region movement reconcile failed", error);
            }
          }, Math.max(0, Number(delay) || 0));

          this.regionReconcileTimers.set(key, timer);
        },

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

        async activateRegion(region) {
          if (!this.isAuthority()) return;

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
                  if (payload.state.activationProcessed) return;

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

        async checkSourceAndDuration(region) {
          if (!this.isAuthority()) return;
          let shouldEnd = false;
          await this.withState(region, async (payload) => {
            this.syncImmunityCombatClock(payload);
            const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
            if (payload.config.mode === "emanation" && (!sourceToken || !sourceActor)) {
              shouldEnd = true;
              return;
            }

            const rounds = this.durationRounds(payload.config);
            if (!rounds) return;
            const d = payload.state.duration;
            d.rounds ??= rounds;
            d.worldExpires ??= Number(payload.state.createdWorldTime ?? nowWorld()) + rounds * 6;

            const combat = game.combat;
            if (combat) {
              const sourceCombatant = sourceActor?.combatant ?? null;
              if (sourceCombatant) {
                d.combatId = combat.id;
                d.sourceCombatantId = sourceCombatant.id;
              }
            }

            if (combat?.id && d.combatId === combat.id && d.sourceCombatantId) {
              const active = combat.combatant;
              if (active?.id === d.sourceCombatantId) {
                const turnKey = `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${active.id}`;
                if (turnKey !== d.lastSourceTurnKey) {
                  d.lastSourceTurnKey = turnKey;
                  d.sourceTurnsElapsed = Number(d.sourceTurnsElapsed ?? 0) + 1;
                }
                if (Number(d.sourceTurnsElapsed ?? 0) >= rounds) shouldEnd = true;
              }
            } else if (nowWorld() >= Number(d.worldExpires ?? Infinity)) {
              shouldEnd = true;
            }
          });
          if (shouldEnd) await this.endZone(region, "duration/source");
        },

        async checkAllDurations() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.checkSourceAndDuration(region);
        },

        async processSourceTurnStart(region) {
          if (!this.isAuthority() || !this.isLiveRegion(region)) return;

          await this.withState(region, async (payload) => {
            if (payload.state?.deactivated) return;
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

        async processAllSourceTurnStarts() {
          if (!this.isAuthority()) return;
          for (const region of this.allZones()) await this.processSourceTurnStart(region);
        },

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

          try {
            await this.withState(liveRegion, async (payload) => this.cleanupZoneUnlocked(payload));

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

        async resolvePendingSave(region, pendingId, identifier, outcome, rollerActorUuid = null) {
          if (!this.isAuthority()) return false;
          if (!["criticalSuccess", "success", "failure", "criticalFailure"].includes(outcome)) return false;

          let resolved = false;
          await this.withState(region, async (payload) => {
            if (payload.state.resolvedSaves?.[pendingId]?.identifier === identifier) {
              delete payload.state.pendingSaves[pendingId];
              return;
            }

            const pending = payload.state.pendingSaves[pendingId];
            if (!pending || pending.identifier !== identifier) return;

            const block = payload.config.effects?.find((b) => b.id === pending.blockId);
            const token = await fromUuid(pending.tokenUuid);
            if (!block || !token?.actor) {
              delete payload.state.pendingSaves[pendingId];
              return;
            }

            if (rollerActorUuid && rollerActorUuid !== token.actor.uuid) return;

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

          let outcome = context?.outcome;
          if (!["criticalSuccess", "success", "failure", "criticalFailure"].includes(outcome)) {
            const checkRoll = (message.rolls ?? []).find((roll) =>
              roll?.options?.identifier === identifier || roll?.options?.identifier == null
            );
            outcome = this.outcomeFromDegree(checkRoll?.degreeOfSuccess);
          }
          if (!outcome) return;

          await this.resolvePendingSave(
            region,
            pendingId,
            identifier,
            outcome,
            message.actor?.uuid ?? null
          );
        },

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


        async traitUseInfoFromMessage(message) {
          if (!message) return null;
          const pf2e = message.flags?.pf2e ?? {};
          const origin = pf2e.origin;
          if (!origin || typeof origin !== "object") return null;

          const rollOptions = [
            ...(Array.isArray(origin.rollOptions) ? origin.rollOptions : []),
            ...(Array.isArray(pf2e.context?.options) ? pf2e.context.options : [])
          ].map((option) => String(option));

          // PF2e spell casts normally mark the chat context as "spell-cast".
          // Attack rolls can instead carry action:cast-a-spell in their roll
          // options, so accept either supported marker.
          const isSpellCast = pf2e.context?.type === "spell-cast"
            || rollOptions.includes("action:cast-a-spell");
          if (origin.type === "spell" && !isSpellCast) return null;

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
            traits
          };
        },

        formatChatAlert(template, values) {
          const replacements = {
            zone: values.zone,
            block: values.block,
            creature: values.creature,
            item: values.item,
            source: values.source,
            trait: values.trait,
            trigger: values.trigger,
            outcome: values.outcome,
            count: values.count
          };
          return String(template ?? "").replace(/\{(zone|block|creature|item|source|trait|trigger|outcome|count)\}/gi, (_match, key) => {
            return String(replacements[String(key).toLowerCase()] ?? "");
          });
        },

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

        async postChatAlertOnce(region, payload, block, token, batchId, eventContext = {}, outcomeKey = null) {
          if (!block.chatAlert?.enabled) return;
          const key = this.chatAlertBatchKey(region, block, batchId, eventContext);
          if (this.chatAlertBatches.has(key)) return;

          this.chatAlertBatches.add(key);
          // Keep the key long enough to cover activation's delayed membership
          // finalization, then discard it so this transient runtime set cannot
          // grow for the life of the world.
          setTimeout(() => this.chatAlertBatches.delete(key), 5000);

          await this.postChatAlert(region, payload, block, token, outcomeKey, eventContext);
        },

        async postChatAlert(region, payload, block, token, outcomeKey, eventContext = {}) {
          if (!block.chatAlert?.enabled) return;
          const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);
          const sourceName = sourceToken?.name ?? sourceActor?.name ?? region.name ?? "Zone source";
          const watchedTrait = String(block.traitUse?.trait ?? "").trim().toLowerCase();
          const trait = String(eventContext?.trait ?? (block.triggers?.traitUse ? watchedTrait : "")).trim();
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
            outcome: outcomeKey ? titleCaseLocal(outcomeKey) : "",
            count
          });

          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: sourceActor, token: sourceToken }),
            content: `<div class="pf2e-zone-chat-alert"><h4>${escHtml(payload.config.name)} — ${escHtml(block.name)}</h4><p>${escHtml(text)}</p><p style="opacity:.7;font-size:.9em">PF2e Zone Automation chat alert</p></div>`,
            flags: {
              [FLAG_SCOPE]: {
                pf2eZoneChatAlert: {
                  regionUuid: region.uuid,
                  blockId: block.id,
                  tokenUuid: token?.uuid ?? null,
                  trigger: eventContext?.trigger ?? null,
                  outcome: outcomeKey ?? null,
                  sourceMessageId: eventContext?.sourceMessageId ?? null
                }
              }
            }
          });
        },

        async handleTraitUseMessage(message) {
          if (!this.isAuthority()) return;

          const candidateZones = this.allZones().filter((region) => {
            const payload = this.readPayload(region);
            return payload && !payload.state?.deactivated
              && (payload.config.effects ?? []).some((block) => block.triggers?.traitUse);
          });
          if (!candidateZones.length) return;

          const info = await this.traitUseInfoFromMessage(message);
          if (!info?.token || !info.traits?.size) return;

          for (const region of candidateZones) {
            if (region.parent?.id !== info.token.parent?.id) continue;
            const inside = this.tokensInside(region).some((token) => token.uuid === info.token.uuid);
            if (!inside) continue;

            await this.withState(region, async (payload) => {
              if (payload.state?.deactivated) return;

              for (const block of payload.config.effects ?? []) {
                if (!block.triggers?.traitUse) continue;
                const trait = String(block.traitUse?.trait ?? "").trim().toLowerCase();
                if (!trait || !info.traits.has(trait)) continue;

                await this.processBlock(
                  region,
                  payload,
                  block,
                  info.token,
                  "traitUse",
                  `traitUse:${message.id ?? randomId()}:${block.id}`,
                  {
                    eventContext: {
                      trigger: "traitUse",
                      trait,
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

        async reconcileAllLinkedConditions() {
          if (!this.isAuthority()) return;
          const actors = new Set(game.actors.contents);
          for (const scene of game.scenes) {
            for (const token of scene.tokens) if (token.actor) actors.add(token.actor);
          }
          for (const actor of actors) {
            if (actor.items.some((i) => this.zoneItemFlag(i)?.removal === "condition-end")) {
              await this.reconcileActorDependencies(actor);
            }
          }
        },

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

          if (registry.clickHandler) {
            document.removeEventListener("click", registry.clickHandler);
          }

          delete globalThis.PF2EZoneRuntimeHookRegistry;
          this.hooksInstalled = false;
        },

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

          on("updateRegion", (region, changes) => {
            if (!runtime.isAuthority()) return;
            if (!Object.prototype.hasOwnProperty.call(changes ?? {}, "shapes")) return;
            if (!runtime.readPayload(region)) return;

            // Dragging/resizing a fixed Area can emit transient tokenExit events
            // before Foundry's Region membership has settled. Re-evaluate using
            // current geometry after the document update completes.
            runtime.scheduleRegionReconcile(region, 100);
          });

          on("deleteRegion", (region) => {
            if (!runtime.isAuthority() || runtime.endingZones.has(region.uuid)) return;
            const payload = runtime.readPayload(region);
            if (payload) {
              runtime.cleanupDeletedRegion(region, payload)
                .catch((e) => console.error("PF2e Zone deleted-region cleanup", e));
            }
          });

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
            if (!region || !payload || !pending) {
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
              const outcome = runtime.outcomeFromDegree(roll?.degreeOfSuccess);
              if (outcome && runtime.isAuthority()) {
                setTimeout(async () => {
                  try {
                    const liveRegion = region.parent?.regions?.get?.(region.id);
                    const fresh = liveRegion ? runtime.readPayload(liveRegion) : null;
                    const stillPending = fresh?.state?.pendingSaves?.[pending.id];
                    if (!stillPending || stillPending.identifier !== pending.identifier) return;

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
        },

        async handleRegionEvent({ event, region }) {
          this.installHooks();
          if (!this.isAuthority() || !region) return;
          const name = event?.name;
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
              {
                const payload = this.readPayload(region);
                if (payload) await this.cleanupZoneUnlocked(payload);
              }
              break;
            case "tokenEnter":
              if (!token) break;
              await this.withState(region, async (payload) => {
                if (!(await this.eligible(payload, token))) return;
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
                await this.processTurnStartUnlocked(region, payload, token, "regionTurnStart");
              });
              break;
            case "tokenTurnEnd":
              if (!token) break;
              await this.withState(region, async (payload) => {
                if (!(await this.eligible(payload, token))) return;
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

