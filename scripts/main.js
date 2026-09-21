import { openZoneBuilder } from "./builder.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { openShieldingTaunt, requestShieldingTaunt } from "./shielding-taunt.js";
import { registerZoneSocket } from "./transport.js";

const MODULE_ID = "pf2e-zone-automation";

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    openBuilder: openZoneBuilder,
    openShieldingTaunt,
    requestShieldingTaunt,
    handleRegionEvent: zoneRuntimeEntrypoint
  };
});

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

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e") return;
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
