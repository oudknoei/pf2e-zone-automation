import { escapeHtml as escHtml, randomId, titleCase as titleCaseLocal } from "./utils.js";
import { FLAG_SCOPE, FLAG_KEY } from "./runtime-constants.js";
import { stateKey } from "./runtime-helpers.js";

/** Owns zone-applied Items, conditions, rolls, and outcome application on the composed runtime. */
export function createZoneEffectService(AUTHORITY_LEASE) {
  const fu = foundry.utils;

  return {
    deletingItems: new Set(),

    itemDeletePromises: new Map(),

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
    async deleteOwnedItem(item, context = "zone cleanup", lease = null) {
      if (!this.authorityLeaseCurrent(lease)) return false;
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
      if (!this.payloadAuthorityCurrent(payload)) return false;

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
      if (!this.payloadAuthorityCurrent(payload)) return false;

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
      if (!this.payloadAuthorityCurrent(payload)) return false;

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

      if (!this.payloadAuthorityCurrent(payload)) return false;
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
          if (!this.payloadAuthorityCurrent(payload)) return false;

          await this.deleteOwnedItem(expired, "expired zone Effect replacement", payload[AUTHORITY_LEASE]);
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
        if (!this.payloadAuthorityCurrent(payload)) return false;

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
      if (!this.payloadAuthorityCurrent(payload)) return null;

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
      if (!this.payloadAuthorityCurrent(payload) || !block.damage.enabled || !(Number(multiplier) > 0)) return false;

      try {
        const { roll: baseRoll } = await this.baseDamageRoll(payload, block, batchId);
        const adjusted = Number(multiplier) === 1 ? baseRoll : baseRoll.alter(Number(multiplier), 0);
        const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);

        if (!this.payloadAuthorityCurrent(payload)) return false;

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
      if (!this.payloadAuthorityCurrent(payload)) return null;

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
      if (!this.payloadAuthorityCurrent(payload) || !block.healing?.enabled || !(Number(multiplier) > 0)) return false;

      try {
        const { roll: baseRoll } = await this.baseHealingRoll(payload, block, batchId);
        const adjusted = Number(multiplier) === 1 ? baseRoll : baseRoll.alter(Number(multiplier), 0);
        const { token: sourceToken, actor: sourceActor } = await this.resolveSource(payload);

        if (!this.payloadAuthorityCurrent(payload)) return false;

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
      if (!this.payloadAuthorityCurrent(payload)) return false;

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
        && watcher.itemId === item.id)) return;

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
    applyImmunityStarts(payload, block, token, outcomeKey, affected, hadSave, application = null, region = null) {
      const starts = block.immunity?.starts ?? [];
      let startNow = false;

      if (hadSave && starts.includes("after-save")) startNow = true;
      if (hadSave && starts.includes("success-or-better") && this.outcomeIsSuccessOrBetter(outcomeKey)) startNow = true;
      if (hadSave && starts.includes("critical-success-only") && outcomeKey === "criticalSuccess") startNow = true;
      if (hadSave && starts.includes("failure-or-worse") && this.outcomeIsFailureOrWorse(outcomeKey)) startNow = true;
      if (starts.includes("affected") && affected) startNow = true;
      if (startNow) this.setImmunity(payload, token.uuid, block, token.actor?.uuid ?? null, region?.uuid ?? null);

      this.registerRecoveryWatcher(payload, block, token, outcomeKey, application);
    },

    /** Retains the cleanup record for real Item failures but completes when the target no longer exists. */
    async deleteAppliedRecord(payload, recordId) {
      if (!this.payloadAuthorityCurrent(payload)) return;

      const record = payload.state.applied[recordId];

      if (!record) return;

      const { actor } = await this.resolveTarget(record);

      if (!this.payloadAuthorityCurrent(payload)) return;
      if (!actor) {
        delete payload.state.applied[recordId];

        return;
      }
      if (!actor.items?.get) {
        throw new Error(`PF2e Zone: target Actor for Item '${record.itemId}' is unavailable; cleanup can be retried.`);
      }

      const item = actor.items.get(record.itemId);

      if (item) await this.deleteOwnedItem(item, "zone-owned Item cleanup", payload[AUTHORITY_LEASE]);

      delete payload.state.applied[recordId];
    }
    ,
  };
}
