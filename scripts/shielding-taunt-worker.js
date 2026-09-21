const TAUNT_ACTION_UUID = "Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb";
const TAUNT_EFFECT_UUID = "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function itemSlug(item) {
  return String(item?.slug ?? item?.system?.slug ?? "").trim().toLowerCase();
}

async function resolveToken(tokenUuid, label) {
  const token = await fromUuid(String(tokenUuid ?? ""));
  if (token?.documentName !== "Token" || !token.actor) {
    throw new Error(`${label} must be a token with an Actor.`);
  }
  return token;
}

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

function previousTauntsFrom(guardian) {
  const prior = [];
  for (const actor of allActors()) {
    const ids = (actor.itemTypes?.effect ?? [])
      .filter((effect) => (
        effect.sourceId === TAUNT_EFFECT_UUID
        && effect.system?.context?.origin?.actor === guardian.uuid
      ))
      .map((effect) => effect.id);
    if (ids.length) prior.push({ actor, ids });
  }
  return prior;
}

function measureTauntRange(sourceToken, targetToken) {
  if (sourceToken.parent?.id !== targetToken.parent?.id) {
    throw new Error("The Guardian and target must be on the same Scene.");
  }
  if (canvas?.scene?.id !== sourceToken.parent?.id || !sourceToken.object || !targetToken.object) {
    throw new Error("Shielding Taunt requires the active GM to have the encounter Scene open.");
  }
  const distance = Number(canvas.grid?.measurePath?.([
    sourceToken.object.center,
    targetToken.object.center
  ])?.distance);
  if (!Number.isFinite(distance)) throw new Error("The distance to the Taunt target could not be measured.");
  return distance;
}

/** Execute Shielding Taunt as the active GM after player authorization. */
export async function executeShieldingTaunt({ sourceTokenUuid, targetTokenUuid } = {}) {
  if (!game.user?.isGM) throw new Error("Shielding Taunt must execute on an active GM client.");

  const [sourceToken, targetToken, tauntAction, tauntEffect] = await Promise.all([
    resolveToken(sourceTokenUuid, "The Guardian"),
    resolveToken(targetTokenUuid, "The Taunt target"),
    fromUuid(TAUNT_ACTION_UUID),
    fromUuid(TAUNT_EFFECT_UUID)
  ]);
  const guardian = sourceToken.actor;
  const target = targetToken.actor;

  if (guardian === target) throw new Error("The Guardian cannot Taunt themself.");

  const shieldingTaunt = guardian.items?.find((item) => (
    itemSlug(item) === "shielding-taunt" || item.name === "Shielding Taunt"
  ));
  if (!shieldingTaunt) throw new Error(`${guardian.name} does not have Shielding Taunt.`);

  const shield = guardian.heldShield;
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

  // Keep the old Taunt until its replacement has been applied successfully.
  const previousTaunts = previousTauntsFrom(guardian);

  // PF2e's Raise a Shield action toggles its effect off when called again, so
  // invoke it only while the Guardian's shield is not already raised.
  if (!guardian.system?.attributes?.shield?.raised) {
    await game.pf2e.actions.raiseAShield({ actors: [guardian] });
  }
  if (!guardian.system?.attributes?.shield?.raised) {
    throw new Error("Raise a Shield was not successfully applied.");
  }

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

  const created = await target.createEmbeddedDocuments("Item", [effectSource]);
  if (!created?.length) throw new Error("The Taunt effect could not be applied.");

  // A Guardian can have only one Taunt active at a time.
  for (const previous of previousTaunts) {
    await previous.actor.deleteEmbeddedDocuments("Item", previous.ids);
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: guardian, token: sourceToken.object }),
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    content: `<p><strong>Shielding Taunt</strong>: ${escapeHtml(guardian.name)} raises ${escapeHtml(shield.name)} and taunts <strong>${escapeHtml(targetToken.name)}</strong>.</p><p><em>The Taunt has the auditory trait.</em></p>`
  });

  return {
    action: "shielding-taunt",
    guardian: guardian.name,
    target: targetToken.name,
    distance,
    maximumRange
  };
}
