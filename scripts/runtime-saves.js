import { actorStatisticDc } from "./dc.js";
import { cloneData as clone, escapeHtml as escHtml, randomId, titleCase as titleCaseLocal } from "./utils.js";
import { SAVE_PREFIX } from "./runtime-constants.js";
import { nowWorld } from "./runtime-helpers.js";

/** Owns pending-save cards, delivery recovery, and authorized resolution on the composed runtime. */
export function createZoneSaveService(AUTHORITY_LEASE) {
  return {
    saveDeliveryRecovery: null,

    saveDeliveryRecoveryLease: null,

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
      if (!this.payloadAuthorityCurrent(payload)) return null;

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
      if (!this.payloadAuthorityCurrent(payload)) return false;
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

    /** Retires a request that became unnecessary after another matching aura granted immunity. */
    async cancelSaveRequestCard(pending, zoneName, reason = "Temporarily immune.", lease = this.captureAuthorityLease()) {
      const card = this.saveRequestMessageForPending(pending);
      if (!card?.update) return false;
      const flag = card.flags?.world?.pf2eZoneSaveRequest ?? {};
      if (["completed", "cancelled"].includes(flag.status)) return false;
      const target = flag.targetName ?? (await fromUuid(pending.tokenUuid))?.name ?? "Target";
      const content = `<div class="pf2e-zone-save-request"><h4>${escHtml(zoneName)} — ${escHtml(pending.blockName)}</h4><p><b>${escHtml(target)}</b>: <strong>${escHtml(reason)}</strong></p><p style="opacity:.7;font-size:.9em">PF2e Zone Automation save request</p></div>`;
      if (!this.authorityLeaseCurrent(lease)) return false;
      await card.update({
        content,
        "flags.world.pf2eZoneSaveRequest": {
          ...flag,
          identifier: pending.identifier,
          tokenUuid: pending.tokenUuid,
          targetName: target,
          status: "cancelled",
          reason: "shared-immunity"
        }
      });
      return true;
    },

    /** Removes unanswered saves from every zone that uses the newly granted Actor/group immunity. */
    async cancelSharedPendingSaves(sharedRecord, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease) || !this.sharedImmunityActive(sharedRecord)) return 0;
      let cancelled = 0;
      for (const region of this.allZones()) {
        await this.withState(region, async (payload) => {
          if (!this.isOperational(region, payload)) return;
          const retired = [];
          for (const [pendingId, pending] of Object.entries(payload.state.pendingSaves ?? {})) {
            const block = payload.config.effects?.find((entry) => entry.id === pending.blockId);
            if (this.sharedImmunityGroup(block) !== sharedRecord.group) continue;
            const targetUuid = this.sharedImmunityTarget(pending.actorUuid, pending.tokenUuid);
            if (targetUuid !== sharedRecord.targetUuid) continue;
            delete payload.state.pendingSaves[pendingId];
            delete payload.state.repeat[this.repeatKey(pending.tokenUuid, pending.blockId)];
            retired.push(pending);
            cancelled++;
          }
          if (retired.length) {
            this.queueAfterCommit(payload, async () => {
              for (const pending of retired) {
                await this.cancelSaveRequestCard(pending, payload.config.name, "Temporarily immune.", payload[AUTHORITY_LEASE]);
              }
            });
          }
        }, lease);
      }
      return cancelled;
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
      if (!this.payloadAuthorityCurrent(payload)) return { status: "not-authority", changed: false, pending: null };
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
        if (!this.payloadAuthorityCurrent(payload)) return { status: "not-authority", changed: false, pending: null };
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
    async deliverPendingSave(region, pendingId, identifier, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return { status: "not-authority", changed: false, pending: null };
      let result = { status: "missing", changed: false, pending: null };
      try {
        await this.withState(region, async (payload) => {
          result = await this.deliverPendingSaveUnlocked(region, payload, pendingId, identifier);
        }, lease);
      } catch (error) {
        this.reportSaveDeliveryFailure(region, result);
        throw error;
      }
      if (!this.authorityLeaseCurrent(lease)) return { status: "not-authority", changed: false, pending: null };
      this.reportSaveDeliveryFailure(region, result);
      return result;
    },

    /** Recovers every request whose card is absent, coalescing duplicate startup and handoff hooks. */
    async reconcileUndeliveredSaveRequests(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
      if (this.saveDeliveryRecovery && this.authorityLeaseCurrent(this.saveDeliveryRecoveryLease)) return await this.saveDeliveryRecovery;

      const recovery = (async () => {
        for (const region of this.allZones()) {
          const payload = this.readPayload(region);
          if (!this.isOperational(region, payload)) continue;
          for (const [pendingId, pending] of Object.entries(payload.state.pendingSaves ?? {})) {
            if (payload.state.resolvedSaves?.[pendingId]?.identifier === pending.identifier) continue;
            if (pending.delivery?.status === "delivered" && this.saveRequestMessageForPending(pending)) continue;
            try {
              await this.deliverPendingSave(region, pendingId, pending.identifier, lease);
            } catch (error) {
              console.error("PF2e Zone: save request delivery recovery failed", region, pendingId, error);
            }
          }
        }
      })();
      this.saveDeliveryRecovery = recovery;
      this.saveDeliveryRecoveryLease = lease;
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
      if (this.isImmuneFor(payload, token, block)) return false;
      const { actor: sourceActor } = await this.resolveSource(payload);
      if (!this.payloadAuthorityCurrent(payload)) return false;
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

        const committed = this.bindAuthorityLease(this.readPayload(liveRegion), payload[AUTHORITY_LEASE]);
        if (!this.isOperational(liveRegion, committed)) return;
        if (this.isImmuneFor(committed, token, block)) {
          delete committed.state.pendingSaves[id];
          delete committed.state.repeat[this.repeatKey(token.uuid, block.id)];
          await this.writePayload(liveRegion, committed);
          return;
        }
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

    /** Applies an authorized save while the Region state lock is already held. */
    async resolvePendingSaveUnlocked(region, payload, pendingId, identifier, outcome, rollerActorUuid = null, message = null) {
      if (!this.isAuthority() || !this.payloadAuthorityCurrent(payload)) return false;
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

      // Another aura can grant the same shared immunity while this request
      // is still visible. Retire the stale request without applying its roll.
      if (this.isImmuneFor(payload, token, block)) {
        delete payload.state.pendingSaves[pendingId];
        delete payload.state.repeat[this.repeatKey(pending.tokenUuid, pending.blockId)];
        this.queueAfterCommit(payload, () =>
          this.cancelSaveRequestCard(pending, payload.config.name, "Temporarily immune.", payload[AUTHORITY_LEASE])
        );
        return false;
      }

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
      this.applyImmunityStarts(payload, block, token, outcome, affected, true, application, region);

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
    async cancelPendingSave(region, pendingId, identifier, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) throw new Error("Only the active GM can cancel a PF2e Zone save request.");
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
      }, lease);
    },

    /** Serializes live chat and recovery through the same save resolution path. */
    async resolvePendingSave(region, pendingId, identifier, outcome, rollerActorUuid = null, message = null, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return false;
      if (!["criticalSuccess", "success", "failure", "criticalFailure"].includes(outcome)) return false;
      let resolved = false;
      const snapshot = this.readPayload(region);
      const pending = snapshot?.state?.pendingSaves?.[pendingId];
      const block = snapshot?.config?.effects?.find((entry) => entry.id === pending?.blockId);
      const group = this.sharedImmunityGroup(block);
      const targetUuid = this.sharedImmunityTarget(pending?.actorUuid ?? rollerActorUuid, pending?.tokenUuid);
      const sharedLockKey = group && targetUuid ? `${targetUuid}::${group}` : null;
      await this.withSharedResolutionLock(sharedLockKey, async () => {
        await this.withState(region, async (payload) => {
          resolved = await this.resolvePendingSaveUnlocked(
            region, payload, pendingId, identifier, outcome, rollerActorUuid, message
          );
        }, lease);
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

      return this.authorityLeaseCurrent(lease) && resolved;
    },

    /** Recognizes this module's chat result messages without interfering with ordinary PF2e rolls. */
    async handleSaveResult(message, lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
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
      , lease);
    },

    /** Replays authorized saves whose chat messages arrived while the GM hook was unavailable. */
    async reconcileCompletedSaves(lease = this.captureAuthorityLease()) {
      if (!this.authorityLeaseCurrent(lease)) return;
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
            , lease);
          } catch (error) {
            console.error("PF2e Zone: completed save recovery failed", region, pendingId, error);
          }
        }
      }
    },
  };
}
