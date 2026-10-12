import { localize, titleCase } from "./utils.js";

// GM Core's creature identification table, also used for creatures without NPC identification data.
const IDENTIFICATION_SKILLS = {
  aberration: ["occultism"], animal: ["nature"], astral: ["occultism"],
  beast: ["arcana", "nature"], celestial: ["religion"], construct: ["arcana", "crafting"],
  dragon: ["arcana"], dream: ["occultism"], elemental: ["arcana", "nature"],
  ethereal: ["occultism"], fey: ["nature"], fiend: ["religion"], fungus: ["nature"],
  humanoid: ["society"], monitor: ["religion"], ooze: ["occultism"], plant: ["nature"],
  shade: ["religion"], spirit: ["occultism"], time: ["occultism"], undead: ["religion"]
};
const CREATURE_TYPES = new Set([
  "aberration", "animal", "beast", "celestial", "construct", "dragon", "elemental",
  "fey", "fiend", "fungus", "humanoid", "monitor", "ooze", "plant", "shade", "spirit", "undead"
]);
const LEVEL_DCS = [14, 15, 16, 18, 19, 20, 22, 23, 24, 26, 27, 28, 30, 31, 32, 34, 35, 36, 38, 39, 40, 42, 44, 46, 48, 50];
export const DEGREE_LABELS = ["Critical Failure", "Failure", "Success", "Critical Success"];

/** Reads traits from prepared data without confusing an Actor's document type with its creature type. */
export function creatureTraits(creature) {
  return [...new Set(creature.system?.traits?.value ?? [])];
}

/** Uses PF2e labels for known traits while retaining custom trait names. */
export function traitLabel(slug) {
  return localize(globalThis.CONFIG?.PF2E?.creatureTraits?.[slug], titleCase(slug));
}

/** Reports creature classifications independently of the check's degree of success. */
export function creatureType(creature) {
  const types = creatureTraits(creature).filter((trait) => CREATURE_TYPES.has(trait)).map(traitLabel);
  return types.length ? types.join(", ") : "Unspecified creature type";
}

/** Uses PF2e's prepared DC, including its variant rules, and falls back to the level and rarity table. */
export function creatureKnowledgeDC(creature) {
  const prepared = creature.identificationDCs?.standard?.dc;
  if (typeof prepared === "number" && Number.isFinite(prepared)) return prepared;
  const level = creature.level ?? creature.system?.details?.level?.value;
  if (!Number.isInteger(level) || level < -1 || level > 25) {
    throw new Error("The creature's Recall Knowledge DC could not be determined.");
  }
  const rarity = creature.rarity ?? creature.system?.traits?.rarity ?? "common";
  const adjustment = { common: 0, uncommon: 2, rare: 5, unique: 10 }[rarity];
  if (adjustment === undefined) throw new Error("The creature's rarity is not recognized.");
  return LEVEL_DCS[Math.max(0, level)] + adjustment;
}

/** Reads a contextual skill bonus so Recall Knowledge and target-specific predicates can apply. */
function skillCandidate(actor, slug, creature = null) {
  const skill = actor.getStatistic?.(slug) ?? actor.skills?.[slug];
  const contextual = skill?.withRollOptions?.({
    target: creature,
    extraRollOptions: ["action:recall-knowledge", "action:recall-knowledge:ask-a-question", "trait:concentrate", "trait:secret"]
  }) ?? skill;
  const modifier = contextual?.check?.mod ?? contextual?.mod;
  if (typeof modifier !== "number" || !Number.isFinite(modifier)) return null;
  return { slug, label: localize(skill.label, skill.label ?? titleCase(slug)), modifier, lore: Boolean(skill.lore ?? actor.system?.skills?.[slug]?.lore) };
}

/** Lists only Lore statistics belonging to the selected source Actor, including system-generated Lore. */
export function actorLoreSkills(actor) {
  const slugs = new Set([...Object.keys(actor.skills ?? {}), ...Object.keys(actor.system?.skills ?? {})]);
  return [...slugs]
    .filter((slug) => actor.skills?.[slug]?.lore || actor.system?.skills?.[slug]?.lore)
    .map((slug) => skillCandidate(actor, slug))
    .filter(Boolean)
    .sort((first, second) => first.label.localeCompare(second.label));
}

/** Normalizes skill and trait names for case-insensitive matching across spaces, punctuation, and slugs. */
function nameWords(name) {
  return String(name ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Matches complete trait names within a Lore name, including common plurals, without matching word fragments. */
function loreNameMatchesTrait(loreName, traitName) {
  const loreWords = nameWords(loreName);
  const traitWords = nameWords(traitName);
  if (!traitWords.length) return false;
  const lastWord = traitWords.at(-1);
  const endings = new Set([lastWord, `${lastWord}s`]);
  if (/[^aeiou]y$/.test(lastWord)) endings.add(`${lastWord.slice(0, -1)}ies`);
  if (/(?:s|x|z|ch|sh)$/.test(lastWord)) endings.add(`${lastWord}es`);
  if (/f$/.test(lastWord)) endings.add(`${lastWord.slice(0, -1)}ves`);
  if (/fe$/.test(lastWord)) endings.add(`${lastWord.slice(0, -2)}ves`);
  return loreWords.some((_word, start) => traitWords.every((word, index) => (
    index === traitWords.length - 1 ? endings.has(loreWords[start + index]) : loreWords[start + index] === word
  )));
}

/** Lowers a chosen Lore's DC by five for a matching creature trait, or by three otherwise. */
export function loreKnowledgeDCAdjustment(creature, lore) {
  const names = [lore.slug, lore.label];
  const matches = creatureTraits(creature).some((trait) => names.some((name) => (
    loreNameMatchesTrait(name, trait) || loreNameMatchesTrait(name, traitLabel(trait))
  )));
  return matches ? -5 : -3;
}

/** Chooses the skill with the best bonus relative to its DC while leaving the rolled modifier unchanged. */
export function bestKnowledgeSkill(actor, creature, loreSlug = null) {
  const skills = creature.identificationDCs?.skills
    ?? creatureTraits(creature).flatMap((trait) => IDENTIFICATION_SKILLS[trait] ?? []);
  const candidates = [...new Set(skills)].map((slug) => skillCandidate(actor, slug, creature)).filter(Boolean);
  if (loreSlug) {
    if (!actorLoreSkills(actor).some((skill) => skill.slug === loreSlug)) {
      throw new Error("The selected Lore skill no longer belongs to the selected character.");
    }
    const lore = skillCandidate(actor, loreSlug, creature);
    candidates.push({ ...lore, lore: true, dcAdjustment: loreKnowledgeDCAdjustment(creature, lore) });
  }
  if (!candidates.length) throw new Error("No applicable identification skill was found. Choose an applicable Lore skill or ask the GM to adjudicate this creature.");
  return candidates.reduce((best, candidate) => (
    candidate.modifier - (candidate.dcAdjustment ?? 0) > best.modifier - (best.dcAdjustment ?? 0) ? candidate : best
  ));
}

/** Applies PF2e's ten-point thresholds and one-step natural 20 or natural 1 adjustment. */
export function knowledgeDegree(total, dc, natural) {
  let degree = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (natural === 20) degree += 1;
  if (natural === 1) degree -= 1;
  return DEGREE_LABELS[Math.min(3, Math.max(0, degree))];
}
