const MODULE_ID = "pf2e-zone-automation";
const ABP_SPELL_ATTACKS_SETTING = "abpSpellAttacks";

/** Registers optional house rules separately from the zone builder's configuration. */
export function registerMiscSettings() {
  game.settings.register(MODULE_ID, ABP_SPELL_ATTACKS_SETTING, {
    name: "Apply ABP attack potency to spell attacks",
    hint: "House rule: while Automatic Bonus Progression is enabled, characters gain a potency bonus to spell attack rolls: +1 at level 2, +2 at level 10, and +3 at level 16. Does not increase spell DCs or damage. Respects each character's ABP opt-out. Reload the world after changing this setting.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true
  });

  Hooks.on("renderSettingsConfig", addMiscSettingsHeading);
}

/** Groups the module's miscellaneous options in Foundry's ordinary settings window. */
function addMiscSettingsHeading(_application, html) {
  const root = html?.querySelector ? html : html?.[0];
  const row = root?.querySelector(`input[name="${MODULE_ID}.${ABP_SPELL_ATTACKS_SETTING}"]`)?.closest(".form-group");

  if (!row) return;

  row.classList.add("pza-abp-spell-attacks-setting");
  if (root.querySelector(".pza-misc-settings-heading")) return;

  const heading = row.ownerDocument.createElement("h3");

  heading.className = "pza-misc-settings-heading";
  heading.textContent = "Miscellaneous";
  row.before(heading);
}

/** Extends native ABP preparation before PF2e builds spellcasting statistics, without changing stored actors. */
export function installABPSpellAttacks() {
  if (game.system.id !== "pf2e") return;

  const abp = game.pf2e?.variantRules?.AutomaticBonusProgression;

  if (!globalThis.libWrapper?.register || typeof abp?.concatModifiers !== "function"
      || typeof abp.isEnabled !== "function" || typeof abp.getAttackPotency !== "function"
      || typeof game.pf2e.Modifier !== "function") {
    throw new Error("PF2e's Automatic Bonus Progression interface or libWrapper is unavailable.");
  }

  /** Preserves native ABP and adds its typed attack bonus only to the spell attack roll selector. */
  libWrapper.register(MODULE_ID, "game.pf2e.variantRules.AutomaticBonusProgression.concatModifiers", function(wrapped, actor, ...args) {
    const result = wrapped(actor, ...args);

    if (!game.settings.get(MODULE_ID, ABP_SPELL_ATTACKS_SETTING)
        || actor?.type !== "character" || !abp.isEnabled(actor)) return result;

    const bonus = abp.getAttackPotency(actor.level);

    if (bonus > 0) {
      const modifiers = (actor.synthetics.modifiers["spell-attack-roll"] ??= []);

      modifiers.push(() => new game.pf2e.Modifier({
        slug: "attack-potency",
        label: "PF2E.AutomaticBonusProgression.attackPotency",
        modifier: bonus,
        type: "potency"
      }));
    }

    return result;
  }, "WRAPPER");
}
