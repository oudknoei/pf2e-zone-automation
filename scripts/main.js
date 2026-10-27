import { openZoneBuilder } from "./builder.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { openShieldingTaunt, requestShieldingTaunt } from "./shielding-taunt.js";
import { registerZoneSocket } from "./transport.js";
import { installZoneOutlines } from "./zone-outline.js";
import { promptSetHeroPoints, setHeroPoints } from "./hero-points.js";
import { createHeroPointReminder, registerHeroPointReminderChat, registerHeroPointReminders } from "./hero-point-reminders.js";
import { installABPSpellAttacks, registerMiscSettings } from "./misc-settings.js";
import { openSessionNotes, openQuickNote, registerSessionNotesHooks } from "./session-notes.js";
import { registerSessionNotesSettings } from "./session-notes-settings.js";
import { registerSessionNotesChat, refreshSessionNotesChat } from "./session-notes-chat.js";

const MODULE_ID = "pf2e-zone-automation";
const SHARED_IMMUNITIES_SETTING = "sharedImmunities";

/** Exposes stable module entry points during initialization so compendium macros always call the installed implementation. */
Hooks.once("init", () => {
  registerMiscSettings();
  registerSessionNotesSettings();
  game.settings.register(MODULE_ID, SHARED_IMMUNITIES_SETTING, {
    name: "Shared temporary immunities",
    hint: "Internal PF2e Zone Automation state for temporary immunity groups.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
  
  const module = game.modules.get(MODULE_ID);
  module.api = {
    openBuilder: openZoneBuilder,
    openShieldingTaunt,
    requestShieldingTaunt,
    handleRegionEvent: zoneRuntimeEntrypoint,
    setHeroPoints,
    promptSetHeroPoints,
    createHeroPointReminder,
    openSessionNotes,
    openQuickNote
  };
  registerHeroPointReminderChat();
  registerSessionNotesChat();

  // World actors are prepared before setup in Foundry v14, so install this during init.
  if (game.system.id !== "pf2e") return;
  try {
    installABPSpellAttacks();
  } catch (error) {
    console.error("PF2e Zone ABP spell attack initialization failed", error);
    /** Waits until settings and notifications are available before reporting an unavailable enabled option. */
    Hooks.once("ready", () => {
      if (game.settings.get(MODULE_ID, "abpSpellAttacks")) {
        ui.notifications.warn("PF2e Zone: ABP attack potency for spell attacks is unavailable.");
      }
    });
  }
});

/** Adds the builder where token-focused preparation naturally begins, avoiding a separate setup macro. */
Hooks.on("getSceneControlButtons", (controls) => {
  const tokenTools = controls.tokens?.tools;
  if (!tokenTools) return;
  tokenTools.pf2eZoneBuilder = {
    name: "pf2eZoneBuilder",
    title: "PF2e Zone Builder",
	icon: "fa-solid fa-poo-storm", 
    //icon: "fa-solid fa-circle-nodes",
    order: Object.keys(tokenTools).length,
    button: true,
    visible: game.system.id === "pf2e",
    onChange: () => {
      void openZoneBuilder().catch((error) => {
        console.error("PF2e Zone Builder failed", error);
        ui.notifications.error(`PF2e Zone Builder failed: ${error?.message ?? error}`);
      });
    }
  };
});

/** Starts cross-client requests and runtime reconciliation only after Foundry services and documents are available. */
Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") return;
  registerHeroPointReminders();
  registerSessionNotesHooks();
  refreshSessionNotesChat();
  try {
    installZoneOutlines();
  } catch (error) {
    console.error("PF2e Zone outline display failed", error);
    ui.notifications.warn("PF2e Zone outlines are unavailable; Foundry will show filled Regions.");
  }
  try {
    registerZoneSocket();
  } catch (error) {
    console.error("PF2e Zone socket initialization failed", error);
    ui.notifications.error(`PF2e Zone player requests are unavailable: ${error?.message ?? error}`);
  }
  void zoneRuntimeEntrypoint().catch((error) => {
    console.error("PF2e Zone runtime initialization failed", error);
    ui.notifications.error(`PF2e Zone runtime failed: ${error?.message ?? error}`);
  });
});
