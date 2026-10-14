import { conditionSlugs, damageTypeSlugs } from "./zone-config.js";
import { localize, titleCase } from "./utils.js";

// These lists keep common PF2e traits easy to choose in the builder.
export const COMMON_TRAITS = Object.freeze([
  "aura",
  "auditory",
  "death",
  "emotion",
  "fear",
  "holy",
  "incapacitation",
  "mental",
  "olfactory",
  "poison",
  "unholy",
  "vitality",
  "visual",
  "void"
]);

// Common reactive traits; other PF2e trait slugs can be supplied in the editor.
export const WATCHED_TRAITS = Object.freeze([
  "auditory",
  "concentrate",
  "divine",
  "emotion",
  "fear",
  "healing",
  "holy",
  "manipulate",
  "mental",
  "move",
  "spirit",
  "unholy",
  "vitality",
  "void"
]);

/** Uses the installed PF2e condition catalog so the builder follows the active system version. */
export function getConditionChoices() {
  const config = CONFIG.PF2E?.conditionTypes ?? {};
  return conditionSlugs()
    .map((slug) => {
      const raw = config[slug];
      let label = titleCase(slug);
      if (typeof raw === "string") label = localize(raw, label);
      else if (raw && typeof raw === "object") {
        const candidate = raw.label ?? raw.name;
        if (typeof candidate === "string") label = localize(candidate, titleCase(slug));
      }
      return { slug, label };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Uses PF2e damage types so zone automation does not maintain a stale duplicate list. */
export function getDamageChoices() {
  const config = CONFIG.PF2E?.damageTypes ?? {};
  const values = damageTypeSlugs().map((slug) => ({
    slug,
    label: typeof config[slug] === "string" ? localize(config[slug], titleCase(slug)) : titleCase(slug)
  }));
  return values.sort((a, b) => a.label.localeCompare(b.label));
}
