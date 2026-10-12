import { openZoneBuilder } from "./builder.js";
import { zoneRuntimeEntrypoint } from "./runtime.js";
import { openShieldingTaunt, requestShieldingTaunt } from "./shielding-taunt.js";
import { registerZoneSocket } from "./transport.js";
import { installZoneOutlines } from "./zone-outline.js";

const MODULE_ID = "pf2e-zone-automation";
const SHARED_IMMUNITIES_SETTING = "sharedImmunities";

/** Exposes stable module entry points during initialization so compendium macros always call the installed implementation. */
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SHARED_IMMUNITIES_SETTING, {
    name: "Shared temporary immunities",
    hint: "Internal PF2e Zone Automation state for temporary immunity groups.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });
  
  /** Adjusts Hero Points for the character selected by the GM, keeping the stored total between zero and three. */
  const setHeroPoints = (amount, character) => {
    // Implementation to set hero points
    if (!game.user.isGM) return;
    
    const tokens = game.canvas.tokens?.placeables || [];
    let selectedToken = null;
    
    if (character === "selected") {
      // Use the currently selected token
      const selectedTokens = canvas.tokens?.controlled || [];
      if (selectedTokens.length > 0) {
        selectedToken = selectedTokens[0];
      }
    } else if (character === "target") {
      // Use a target token if available
      const targetedTokens = game.user.targets || new Set();
      if (targetedTokens.size > 0) {
        selectedToken = Array.from(targetedTokens)[0];
      }
    }
    
    // If we have a specific character, use that one
    if (character && character !== "selected" && character !== "target") {
      const token = tokens.find(t => t.name === character);
      if (token) selectedToken = token;
    }
    
    // Use the first token if no selection made or found
    if (!selectedToken && tokens.length > 0) {
      selectedToken = tokens[0];
    }
    
    if (selectedToken) {
      const heroPointsKey = "heroPoints";
      const currentPoints = selectedToken.actor?.getFlag("pf2e", heroPointsKey) || 0;
      let newPoints = Math.max(0, currentPoints + amount);
      
      // Ensure points don't exceed maximum of 3
      newPoints = Math.min(3, newPoints);
      
      // Update the token's actor with new hero points
      if (selectedToken.actor) {
        selectedToken.actor.setFlag("pf2e", heroPointsKey, newPoints);
        
        // Show chat message with changes for GM only by default
        const changeAmount = newPoints - currentPoints;
        if (changeAmount !== 0) {
          const characterName = selectedToken.name;
          const chatMessage = `Hero Points changed for ${characterName}: ${currentPoints} → ${newPoints}`;
          
          // Create the message with GM only visibility by default
          const messageData = {
            content: chatMessage,
            user: game.user.id
          };
          
          if (game.user.isGM) {
            ChatMessage.create(messageData);
          }
        }
      }
    } else {
      ui.notifications.warn("No character found to set hero points for.");
    }
  };
  
  /** Prompts for a Hero Point adjustment and the characters who should receive it. */
  const promptSetHeroPoints = async () => {
    if (!game.modules.get(MODULE_ID)?.active || !game.modules.get(MODULE_ID)?.api?.setHeroPoints) {
      ui.notifications.error("Enable PF2e Zone Automation first.");
      return;
    }
    
    // Prompt for hero point amount
    const amountInput = await Dialog.prompt({
      title: "Set Hero Points Amount",
      content: `<div class="form-group">
        <label>Amount:</label>
        <input type="number" name="amount" value="1" min="-999" max="999" />
      </div>`,
      buttons: {
        set: {
          label: "Set Points",
          callback: (html) => {
            const amount = parseInt(html.find('[name="amount"]').val());
            
            // Get all actors for selection
            const actors = game.actors?.filter(a => a.type === "character") || [];
            
            if (actors.length > 0) {
              // Create character selection options with checkboxes and select/clear buttons
              let content = `<div class="form-group">
                <label>Character:</label>
                <select name="character" id="character-select">
                  <option value="selected">Selected Token</option>
                  <option value="target">Targeted Token</option>`;
              
              for (const actor of actors) {
                content += `<option value="${actor.name}">${actor.name}</option>`;
              }
              
              content += `</select></div><div class="form-group"><label>Check Characters:</label><br>`;
              
              // Add checkboxes for all characters
              const characterCheckboxes = actors.map(actor => 
                `<input type="checkbox" name="characters" value="${actor.name}" id="char-${actor.name}"> 
                  <label for="char-${actor.name}">${actor.name}</label><br>`
              ).join('');
              
              content += `<div style="max-height: 200px; overflow-y: auto;">${characterCheckboxes}</div>`;
              content += `<button type="button" id="select-all">Select All</button> 
                         <button type="button" id="clear-all">Clear All</button></div>`;
              
              // Create a custom dialog with event listeners
              const dialog = new Dialog({
                title: "Select Characters",
                content,
                buttons: {
                  set: {
                    label: "Set Points",
                    callback: (html) => {
                      // Get selected checkboxes from the DOM after dialog is closed
                      const checkboxes = html.find('input[name="characters"]:checked');
                      const selectedCharacters = Array.from(checkboxes).map(cb => cb.value);
                      
                      if (selectedCharacters.length > 0) {
                        for (const characterName of selectedCharacters) {
                          setHeroPoints(amount, characterName);
                        }
                      } else {
                        // If no checkboxes are checked, use the dropdown selection
                        const characterSelect = html.find('#character-select');
                        if (characterSelect && characterSelect.val() !== "selected" && characterSelect.val() !== "target") {
                          setHeroPoints(amount, characterSelect.val());
                        }
                      }
                    }
                  },
                  cancel: {
                    label: "Cancel"
                  }
                },
                default: "set",
                render: (html) => {
                  // Add event listeners for select/clear buttons after dialog is rendered
                  html.find('#select-all').on('click', () => {
                    html.find('input[name="characters"]').prop('checked', true);
                  });
                  
                  html.find('#clear-all').on('click', () => {
                    html.find('input[name="characters"]').prop('checked', false);
                  });
                }
              });
              
              dialog.render(true);
            } else {
              // No actors available
              ui.notifications.warn("No characters found.");
            }
          }
        },
        cancel: {
          label: "Cancel"
        }
      },
      default: "set"
    });
  };
  
  const module = game.modules.get(MODULE_ID);
  module.api = {
    openBuilder: openZoneBuilder,
    openShieldingTaunt,
    requestShieldingTaunt,
    handleRegionEvent: zoneRuntimeEntrypoint,
    setHeroPoints,
    promptSetHeroPoints
  };
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
