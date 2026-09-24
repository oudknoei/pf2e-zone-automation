import { combatDurationDeadline } from "./duration-clock.js";
import { resolveDurationRounds } from "./duration.js";
import { postFormulaDurationMessage } from "./duration-chat.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { normalizeConfig, validateConfig } from "./zone-config.js";

const RUNTIME_VERSION = "0.5.16";
const FLAG_SCOPE = "world";
const FLAG_KEY = "pf2eZone";

/** Stops either creation path from persisting a configuration the builder would reject. */
export function requireValidConfig(raw, sourceActor) {
  const config = normalizeConfig(raw, { strict: true });
  const validation = validateConfig(config, { sourceActor });
  if (validation.errors.length) throw new Error(validation.errors[0]);
  return config;
}

/** Keeps the Region border visible against its fill for both GM and player requests. */
function lightenZoneColor(value, amount = 0.1) {
  const raw = String(value ?? "#999999").trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  const hex = full?.[1] ?? (short ? short[1].split("").map((c) => `${c}${c}`).join("") : null);
  if (!hex) return raw || "#999999";
  const t = Math.clamp(Number(amount) || 0, 0, 1);
  const channels = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * t));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Keeps Region behavior creation compatible with Foundry's changing internal type names. */
function executeScriptBehaviorType() {
  const match = Object.entries(CONFIG.RegionBehavior?.dataModels ?? {})
    .find(([, cls]) => cls?.name === "ExecuteScriptRegionBehaviorType");
  return match?.[0] ?? "executeScript";
}

/** Makes created Regions call the installed module runtime after future updates. */
function regionBehaviorData() {
  return {
    name: "PF2e Zone Runtime",
    type: executeScriptBehaviorType(),
    system: {
      events: [
        "behaviorActivated", "behaviorDeactivated", "behaviorViewed",
        "tokenEnter", "tokenExit", "tokenTurnStart", "tokenTurnEnd"
      ],
      source: `
const api = game.modules.get("pf2e-zone-automation")?.api;
if (!api?.handleRegionEvent) throw new Error("PF2e Zone Automation module is not active.");
await api.handleRegionEvent({ behavior, event, region, scene: typeof scene !== "undefined" ? scene : region?.parent });
`
    },
    disabled: false,
    flags: {}
  };
}

/** Gives finite zones the same duration metadata regardless of who created them. */
function initialRuntimeState({ sourceActor, sourceToken, requester, savedPresetId, chosenDamageType, durationResolution }) {
  const combat = game.combat;
  const sourceCombatant = sourceActor.combatant ?? null;
  const rounds = durationResolution?.rounds ?? null;
  const currentIsSource = Boolean(combat && sourceCombatant && combat.combatant?.id === sourceCombatant.id);
  const currentTurnKey = currentIsSource
    ? `${combat.id}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}:${sourceCombatant.id}`
    : null;
  return {
    createdWorldTime: Number(game.time?.worldTime ?? 0),
    createdBy: { userId: requester.id, name: requester.name },
    savedPresetId: savedPresetId ?? null,
    sourceActorUuid: sourceActor.uuid,
    sourceTokenUuid: sourceToken.uuid,
    activation: { damageType: chosenDamageType ?? null },
    activationProcessed: false,
    activationPending: true,
    activationFinalizeScheduled: false,
    activationTargets: {},
    initialOccupants: {},
    deactivated: false,
    pendingSaves: {},
    resolvedSaves: {},
    repeat: {},
    immunities: {},
    applied: {},
    damageRolls: {},
    healingRolls: {},
    recoveryWatchers: {},
    turnStartEvents: {},
    lastSourceTriggerTurnKey: currentTurnKey,
    duration: rounds ? {
      rounds,
      formula: durationResolution?.formula ?? null,
      worldExpires: Number(game.time?.worldTime ?? 0) + rounds * 6,
      combatId: combat?.id ?? null,
      sourceCombatantId: sourceCombatant?.id ?? null,
      sourceTurnsElapsed: 0,
      lastSourceTurnKey: currentTurnKey,
      ...combatDurationDeadline(combat, sourceCombatant, rounds)
    } : {}
  };
}

/** Shares validation, payload, activation, and duration handling while allowing each client to place an area in its own UI. */
export async function createZoneDocument({ rawConfig, scene, sourceActor, sourceToken, requester, savedPresetId = null, chosenDamageType = null, color, placeArea }) {
  if (!scene || sourceToken?.parent?.id !== scene.id) throw new Error("Source Token is not on the requested Scene.");
  const config = requireValidConfig(rawConfig, sourceActor);
  const choice = config.activationChoices?.damageType;
  if (choice?.enabled && !choice.options.includes(chosenDamageType)) {
    throw new Error("Choose an allowed shared damage type before creating this zone.");
  }
  const durationResolution = await resolveDurationRounds(config.duration);
  const payload = {
    runtimeVersion: RUNTIME_VERSION,
    config,
    state: initialRuntimeState({ sourceActor, sourceToken, requester, savedPresetId, chosenDamageType, durationResolution })
  };
  const regionData = {
    name: config.name,
    color: lightenZoneColor(color ?? requester.color ?? game.user.color),
    visibility: config.visibility === "creator"
      ? (CONST.REGION_VISIBILITY?.OBSERVER ?? 3)
      : (CONST.REGION_VISIBILITY?.ALWAYS ?? 2),
    ownership: config.visibility === "creator"
      ? {
          default: CONST.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0,
          [requester.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2
        }
      : undefined,
    behaviors: [regionBehaviorData()],
    flags: { [FLAG_SCOPE]: { [FLAG_KEY]: payload } }
  };

  let region;
  if (config.mode === "emanation") {
    const RegionDocument = CONFIG.Region.documentClass;
    if (typeof RegionDocument?.createTokenEmanation !== "function") {
      throw new Error("Foundry V14 RegionDocument.createTokenEmanation is unavailable.");
    }
    region = await RegionDocument.createTokenEmanation(sourceToken, config.radius, regionData);
  } else {
    if (typeof placeArea !== "function") throw new Error("Area placement is unavailable.");
    region = await placeArea(regionData, config);
  }
  if (!region) return { region: null, durationResolution: null };

  const runtime = await zoneRuntimeEntrypoint();
  await runtime.activateRegion(region);
  await postFormulaDurationMessage({
    zoneName: config.name,
    duration: durationResolution,
    visibility: config.visibility,
    creatorUserId: requester.id,
    actor: sourceActor,
    token: sourceToken
  });
  return { region, durationResolution };
}
