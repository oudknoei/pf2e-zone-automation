const TAUNT_ACTION_UUID = "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb";
const TAUNT_EFFECT_UUID = "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW";
const FLAG_SCOPE = "world";
const EFFECT_FLAG_KEY = "pf2eZoneShieldingTaunt";
const CHAT_FLAG_KEY = "pf2eZoneShieldingTauntMessage";

const guardianTauntTails = new Map();

/** Gives each Guardian one ordered Taunt transaction so concurrent requests see the latest effect. */
async function serializeGuardianTaunt(guardianUuid, operation) {
  const previous = guardianTauntTails.get(guardianUuid) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  guardianTauntTails.set(guardianUuid, tail);
  try {
    return await result;
  } finally {
    if (guardianTauntTails.get(guardianUuid) === tail) guardianTauntTails.delete(guardianUuid);
  }
}

/** Keeps chat text safe when actor and target names come from world data. */
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

/** Uses a consistent item identity so rules checks survive display-name changes. */
function itemSlug(item) {
  return String(item?.slug ?? item?.system?.slug ?? "").trim().toLowerCase();
}

/** Fails early with a useful message when the requested combatants are no longer on a scene. */
async function resolveToken(tokenUuid, label) {
  const token = await fromUuid(String(tokenUuid ?? ""));
  if (token?.documentName !== "Token" || !token.actor) {
    throw new Error(`${label} must be a token with an Actor.`);
  }
  return token;
}

/** Includes synthetic and scene actors so prior Taunts can be found across the active world. */
function allActors() {
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, actor);
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actor) actors.set(token.actor.uuid, token.actor);
    }
  }
  return actors.values();
}

/** Finds only this Guardian's Taunts so replacements never disturb another Guardian's effect. */
function previousTauntsFrom(guardian) {
  const prior = [];
  for (const actor of allActors()) {
    const effects = (actor.itemTypes?.effect ?? [])
      .filter((effect) => (
        effect.sourceId === TAUNT_EFFECT_UUID
        && effect.system?.context?.origin?.actor === guardian.uuid
      ));
    if (effects.length) prior.push({ actor, effects });
  }
  return prior;
}

/** Reads operation metadata from either a live Item or a source-shaped test document. */
function tauntOperation(effect) {
  return effect?.getFlag?.(FLAG_SCOPE, EFFECT_FLAG_KEY)
    ?? effect?.flags?.[FLAG_SCOPE]?.[EFFECT_FLAG_KEY]
    ?? null;
}

/** Reads operation metadata from a chat document without depending on Collection internals. */
function chatOperation(message) {
  return message?.getFlag?.(FLAG_SCOPE, CHAT_FLAG_KEY)
    ?? message?.flags?.[FLAG_SCOPE]?.[CHAT_FLAG_KEY]
    ?? null;
}

/** Returns all messages regardless of whether Foundry exposes a Collection or a plain test array. */
function allMessages() {
  if (Array.isArray(game.messages?.contents)) return game.messages.contents;
  if (typeof game.messages?.values === "function") return game.messages.values();
  return game.messages ?? [];
}

/** Finds a completed operation marker, which prevents a late retry from reverting a newer Taunt. */
function completedOperation(operationId) {
  if (!operationId) return null;
  for (const message of allMessages()) {
    const operation = chatOperation(message);
    if (operation?.operationId === operationId) return operation;
  }
  return null;
}

/** Finds a replacement left by interrupted cleanup so the same operation can resume it. */
function replacementsForOperation(operationId) {
  if (!operationId) return [];
  const replacements = [];
  for (const actor of allActors()) {
    for (const effect of actor.itemTypes?.effect ?? []) {
      const operation = tauntOperation(effect);
      if (effect.sourceId === TAUNT_EFFECT_UUID && operation?.operationId === operationId) {
        replacements.push({ actor, effect, operation });
      }
    }
  }
  return replacements;
}

/** Rejects an operation ID replayed with different request details, including after a GM reload. */
function assertSameOperation(operation, request) {
  const fields = [
    "requesterUserId", "sourceTokenUuid", "targetTokenUuid",
    "guardianActorUuid", "targetActorUuid"
  ].filter((field) => Object.hasOwn(request, field));
  if (!operation || fields.some((field) => String(operation[field] ?? "") !== String(request[field] ?? ""))) {
    throw new Error("Shielding Taunt operation ID was reused with different request details.");
  }
}

/** Builds the durable identity used to detect and finish a partially completed replacement. */
function operationMetadata(request, { guardian, target, targetName, distance, maximumRange }) {
  return {
    operationId: request.operationId,
    requesterUserId: request.requesterUserId ?? null,
    sourceTokenUuid: request.sourceTokenUuid,
    targetTokenUuid: request.targetTokenUuid,
    guardianActorUuid: guardian.uuid,
    targetActorUuid: target.uuid,
    result: {
      action: "shielding-taunt",
      guardian: guardian.name,
      target: targetName,
      distance,
      maximumRange
    }
  };
}

/** Deletes every Taunt except the selected replacement, grouping mutations by owning Actor. */
async function deleteOtherTaunts(guardian, replacement) {
  for (const previous of previousTauntsFrom(guardian)) {
    const ids = previous.effects
      .filter((effect) => !(previous.actor.uuid === replacement.actor.uuid && effect.id === replacement.effect.id))
      .map((effect) => effect.id)
      .filter(Boolean);
    if (ids.length) await previous.actor.deleteEmbeddedDocuments("Item", ids);
  }
}

/** Tests live state after a thrown delete because Foundry may have completed the mutation first. */
function otherTauntsRemain(guardian, replacement) {
  return previousTauntsFrom(guardian).some(({ actor, effects }) => effects.some((effect) => (
    actor.uuid !== replacement.actor.uuid || effect.id !== replacement.effect.id
  )));
}

/** Reads a numeric TokenDocument source value without requiring a rendered Token. */
function tokenNumber(token, property, fallback = null) {
  const value = Number(token?._source?.[property] ?? token?.[property] ?? fallback);
  return Number.isFinite(value) ? value : NaN;
}

/** Returns whether two plain rectangular bounds overlap. */
function boundsOverlap(first, second) {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

/** Snaps token bounds toward another token the same way PF2e's cuboid measurement does. */
function snapBounds(bounds, toward, gridWidth) {
  const roundX = bounds.x < toward.x ? Math.ceil : Math.floor;
  const roundY = bounds.y < toward.y ? Math.ceil : Math.floor;
  return {
    x: roundX(bounds.x / gridWidth) * gridWidth,
    y: roundY(bounds.y / gridWidth) * gridWidth,
    width: Math.ceil(bounds.width / gridWidth) * gridWidth,
    height: Math.ceil(bounds.height / gridWidth) * gridWidth,
  };
}

/** Measures the pixel separation between rectangular token bounds. */
function boundsSeparation(first, second, gridWidth) {
  if (boundsOverlap(first, second)) return { dx: 0, dy: 0 };

  const snappedFirst = snapBounds(first, second, gridWidth);
  const snappedSecond = snapBounds(second, first, gridWidth);
  const dx = Math.max(
    snappedFirst.x - (snappedSecond.x + snappedSecond.width),
    snappedSecond.x - (snappedFirst.x + snappedFirst.width),
    0,
  ) + gridWidth;
  const dy = Math.max(
    snappedFirst.y - (snappedSecond.y + snappedSecond.height),
    snappedSecond.y - (snappedFirst.y + snappedFirst.height),
    0,
  ) + gridWidth;
  return { dx, dy };
}

/** Builds PF2e-compatible mechanical bounds from a TokenDocument and its owning Scene. */
function tokenBounds(token, scene) {
  const grid = scene.grid;
  const x = tokenNumber(token, "x");
  const y = tokenNumber(token, "y");
  const widthUnits = tokenNumber(token, "width");
  const heightUnits = tokenNumber(token, "height");
  const gridWidth = Number(grid.sizeX ?? grid.size);
  const gridHeight = Number(grid.sizeY ?? grid.size);
  const bounds = {
    x,
    y,
    width: widthUnits * gridWidth,
    height: heightUnits * gridHeight,
  };

  if (widthUnits >= 1) return bounds;

  const center = {
    x: x + bounds.width / 2,
    y: y + bounds.height / 2,
  };
  const topLeft = grid.getTopLeftPoint?.(center);
  return {
    x: Number(topLeft?.x),
    y: Number(topLeft?.y),
    width: Math.max(gridWidth, bounds.width),
    height: Math.max(gridHeight, bounds.height),
  };
}

/** Measures vertical separation between creature volumes in scene pixels. */
function elevationSeparation(sourceToken, targetToken, sourceBounds, targetBounds, scene, gridWidth) {
  const sourceElevation = tokenNumber(sourceToken, "elevation", 0);
  const targetElevation = tokenNumber(targetToken, "elevation", 0);
  if (sourceElevation === targetElevation || !sourceToken.actor || !targetToken.actor) return 0;

  const sceneSize = Number(scene.dimensions?.size ?? scene.grid.size);
  const sceneDistance = Number(scene.dimensions?.distance ?? scene.grid.distance);
  const sourceHeight = Number(sourceToken.actor.dimensions?.height);
  const targetHeight = Number(targetToken.actor.dimensions?.height);
  const sourceVerticalBounds = {
    x: sourceBounds.x,
    y: Math.floor(sourceElevation / sceneDistance * sceneSize),
    width: sourceBounds.width,
    height: Math.floor(sourceHeight / sceneDistance * sceneSize),
  };
  const targetVerticalBounds = {
    x: targetBounds.x,
    y: Math.floor(targetElevation / sceneDistance * sceneSize),
    width: targetBounds.width,
    height: Math.floor(targetHeight / sceneDistance * sceneSize),
  };
  const verticalOverlap = targetVerticalBounds.y + targetVerticalBounds.height > sourceVerticalBounds.y
    && targetVerticalBounds.y < sourceVerticalBounds.y + sourceVerticalBounds.height;
  if (verticalOverlap) return 0;

  const snappedSource = snapBounds(sourceVerticalBounds, targetVerticalBounds, gridWidth);
  const snappedTarget = snapBounds(targetVerticalBounds, sourceVerticalBounds, gridWidth);
  return Math.max(
    snappedSource.y - (snappedTarget.y + snappedTarget.height),
    snappedTarget.y - (snappedSource.y + snappedSource.height),
    0,
  ) + gridWidth;
}

/** Measures Taunt range from TokenDocuments on their owning Scene, even when it is not viewed. */
function measureTauntRange(sourceToken, targetToken) {
  if (sourceToken.parent?.id !== targetToken.parent?.id) {
    throw new Error("The Guardian and target must be on the same Scene.");
  }

  const scene = sourceToken.parent;
  const grid = scene?.grid;
  const sourceElevation = tokenNumber(sourceToken, "elevation", 0);
  const targetElevation = tokenNumber(targetToken, "elevation", 0);
  const squareGridType = globalThis.CONST?.GRID_TYPES?.SQUARE ?? 1;
  let distance;

  if (grid?.type !== squareGridType) {
    const measurement = grid?.measurePath?.([
      { x: tokenNumber(sourceToken, "x"), y: tokenNumber(sourceToken, "y"), elevation: sourceElevation },
      { x: tokenNumber(targetToken, "x"), y: tokenNumber(targetToken, "y"), elevation: targetElevation },
    ]);
    distance = Math.round(measurement?.distance);
  } else {
    const gridWidth = Number(grid.sizeX ?? grid.size);
    const gridDistance = Number(scene.dimensions?.distance ?? grid.distance);
    const sourceBounds = tokenBounds(sourceToken, scene);
    const targetBounds = tokenBounds(targetToken, scene);
    const { dx, dy } = boundsSeparation(sourceBounds, targetBounds, gridWidth);
    const dz = elevationSeparation(sourceToken, targetToken, sourceBounds, targetBounds, scene, gridWidth);
    const [smallest, middle, largest] = [dx, dy, dz]
      .map((pixels) => Math.ceil(Math.abs(pixels / gridWidth)))
      .sort((first, second) => first - second);
    const doubleDiagonal = smallest;
    const diagonal = middle - smallest;
    const straight = largest - middle;
    distance = Math.floor(doubleDiagonal * 1.75 + diagonal * 1.5 + straight) * gridDistance;
  }

  if (!Number.isFinite(distance)) throw new Error("The distance to the Taunt target could not be measured.");
  return distance;
}

/** Execute Shielding Taunt as the active GM after player authorization. */
export async function executeShieldingTaunt(request = {}) {
  const { sourceTokenUuid, targetTokenUuid, requesterUserId = null } = request;
  const operationId = request.operationId ?? null;
  if (!game.user?.isGM) throw new Error("Shielding Taunt must execute on an active GM client.");
  if (operationId != null && (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(operationId))) {
    throw new Error("Shielding Taunt operation ID is invalid.");
  }

  const completed = completedOperation(operationId);
  if (completed) {
    assertSameOperation(completed, { requesterUserId, sourceTokenUuid, targetTokenUuid });
    return { ...completed.result, operationId, mechanicalSuccess: true, warnings: [] };
  }

  const [sourceToken, targetToken, tauntAction, tauntEffect] = await Promise.all([
    resolveToken(sourceTokenUuid, "The Guardian"),
    resolveToken(targetTokenUuid, "The Taunt target"),
    fromUuid(TAUNT_ACTION_UUID),
    fromUuid(TAUNT_EFFECT_UUID)
  ]);
  const guardian = sourceToken.actor;
  const target = targetToken.actor;

  return serializeGuardianTaunt(guardian.uuid, async () => {
    const completedInsideLock = completedOperation(operationId);
    if (completedInsideLock) {
      assertSameOperation(completedInsideLock, {
        requesterUserId, sourceTokenUuid, targetTokenUuid,
        guardianActorUuid: guardian.uuid, targetActorUuid: target.uuid
      });
      return { ...completedInsideLock.result, operationId, mechanicalSuccess: true, warnings: [] };
    }

    const priorReplacements = replacementsForOperation(operationId);
    for (const candidate of priorReplacements) {
      assertSameOperation(candidate.operation, {
        requesterUserId, sourceTokenUuid, targetTokenUuid,
        guardianActorUuid: guardian.uuid, targetActorUuid: target.uuid
      });
      if (
        candidate.actor.uuid !== target.uuid
        || candidate.effect.system?.context?.origin?.actor !== guardian.uuid
      ) {
        throw new Error("Shielding Taunt operation ID was reused with different request details.");
      }
    }

    let replacement = priorReplacements[0] ?? null;
    let operation = replacement?.operation ?? null;
    let shield = guardian.heldShield;

    if (!replacement) {
      if (guardian === target) throw new Error("The Guardian cannot Taunt themself.");

      const shieldingTaunt = guardian.items?.find((item) => (
        itemSlug(item) === "shielding-taunt" || item.name === "Shielding Taunt"
      ));
      if (!shieldingTaunt) throw new Error(`${guardian.name} does not have Shielding Taunt.`);

      if (!shield) throw new Error(`${guardian.name} is not wielding a shield.`);
      if (shield.isDestroyed) throw new Error(`${shield.name} is destroyed.`);
      if (shield.isBroken) throw new Error(`${shield.name} is broken.`);

      const hasLongDistanceTaunt = guardian.items?.some((item) => (
        itemSlug(item) === "long-distance-taunt" || item.name === "Long-Distance Taunt"
      ));
      const maximumRange = hasLongDistanceTaunt ? 120 : 30;
      const distance = measureTauntRange(sourceToken, targetToken);
      if (distance > maximumRange) {
        throw new Error(`${targetToken.name} is ${distance} feet away; maximum Taunt range is ${maximumRange} feet.`);
      }

      if (!tauntAction || tauntEffect?.type !== "effect") {
        throw new Error("The PF2e Taunt action or Taunt effect could not be loaded.");
      }

      // PF2e's Raise a Shield action toggles its effect off when called again, so
      // invoke it only while the Guardian's shield is not already raised.
      if (!guardian.system?.attributes?.shield?.raised) {
        await game.pf2e.actions.raiseAShield({ actors: [guardian] });
      }
      if (!guardian.system?.attributes?.shield?.raised) {
        throw new Error("Raise a Shield was not successfully applied.");
      }

      operation = operationMetadata(
        { operationId, requesterUserId, sourceTokenUuid, targetTokenUuid },
        { guardian, target, targetName: targetToken.name, distance, maximumRange }
      );
      const effectSource = tauntEffect.toObject();
      effectSource._id = null;
      effectSource.system.context = {
        origin: {
          actor: guardian.uuid,
          token: sourceToken.uuid,
          item: tauntAction.uuid,
          spellcasting: null,
          rollOptions: [
            ...(guardian.getSelfRollOptions?.("origin") ?? []),
            ...(tauntAction.getRollOptions?.("origin:item") ?? [])
          ]
        },
        target: {
          actor: target.uuid,
          token: targetToken.uuid
        },
        roll: null
      };
      // Shielding Taunt changes the official Taunt effect to auditory.
      effectSource.system.traits.value = ["auditory"];
      if (operationId) {
        effectSource.flags ??= {};
        effectSource.flags[FLAG_SCOPE] ??= {};
        effectSource.flags[FLAG_SCOPE][EFFECT_FLAG_KEY] = operation;
      }

      const created = await target.createEmbeddedDocuments("Item", [effectSource]);
      if (!created?.[0]?.id) throw new Error("The Taunt effect could not be applied.");
      replacement = { actor: target, effect: created[0], operation };
    }

    const warnings = [];
    try {
      // A Guardian can have only one Taunt active at a time. This also collapses
      // duplicate replacements left by requests that raced on different clients.
      await deleteOtherTaunts(guardian, replacement);
    } catch (cleanupError) {
      if (!otherTauntsRemain(guardian, replacement)) {
        warnings.push(`Previous Taunt cleanup reported an error after the state was reconciled: ${cleanupError?.message ?? cleanupError}`);
      } else {
        try {
          await replacement.actor.deleteEmbeddedDocuments("Item", [replacement.effect.id]);
        } catch (compensationError) {
          const partialError = new Error(
            `Previous Taunt cleanup failed (${cleanupError?.message ?? cleanupError}) and the replacement could not be rolled back (${compensationError?.message ?? compensationError}). Retry the same Shielding Taunt to finish cleanup.`
          );
          partialError.code = "PF2E_ZONE_TAUNT_CLEANUP_INCOMPLETE";
          partialError.retryable = true;
          throw partialError;
        }
        throw new Error(`The previous Taunt could not be replaced: ${cleanupError?.message ?? cleanupError}`);
      }
    }

    const result = operation?.result ?? {
      action: "shielding-taunt",
      guardian: guardian.name,
      target: targetToken.name,
      distance: measureTauntRange(sourceToken, targetToken),
      maximumRange: guardian.items?.some((item) => (
        itemSlug(item) === "long-distance-taunt" || item.name === "Long-Distance Taunt"
      )) ? 120 : 30
    };
    shield ??= guardian.heldShield;

    if (!completedOperation(operationId)) {
      try {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: guardian, scene: sourceToken.parent, token: sourceToken }),
          style: CONST.CHAT_MESSAGE_STYLES.OTHER,
          content: `<p><strong>Shielding Taunt</strong>: ${escapeHtml(result.guardian)} raises ${escapeHtml(shield?.name ?? "a shield")} and taunts <strong>${escapeHtml(result.target)}</strong>.</p><p><em>The Taunt has the auditory trait.</em></p>`,
          ...(operationId ? { flags: { [FLAG_SCOPE]: { [CHAT_FLAG_KEY]: operation } } } : {})
        });
      } catch (chatError) {
        console.warn("PF2e Zone Shielding Taunt was applied, but its chat message failed", chatError);
        warnings.push(`Shielding Taunt was applied, but its chat message could not be posted: ${chatError?.message ?? chatError}`);
      }
    }

    return { ...result, operationId, mechanicalSuccess: true, warnings };
  });
}
