import { clearKnowledgeApiKey, hasKnowledgeApiKey, setKnowledgeApiKey } from "./recall-knowledge-ai.js";
import { DEFAULT_KNOWLEDGE_API_ENDPOINT, DEFAULT_KNOWLEDGE_MODEL, KNOWLEDGE_API_ENDPOINT_SETTING,
  KNOWLEDGE_MODEL_SETTING, knowledgeAIProfile, normalizeKnowledgeEndpoint } from "./recall-knowledge-ai-config.js";
import { isKnowledgeActiveGM, QUESTION_MODULE_ID } from "./recall-knowledge-message.js";

let connectionClass;
let connectionDialog = null;

/** Prevents players from using settings handlers even if they invoke them outside the settings UI. */
function requireConnectionGM() {
  if (!game.user?.isGM) throw new Error("Only a GM can configure the AI connection.");
}

/** Shows browser-session state without revealing or prefilling a previously entered key. */
function updateConnectionStatus(form) {
  const status = form.querySelector("[data-pza-ai-key-status]");
  status.textContent = hasKnowledgeApiKey() ? "Key entered for this session" : "No key entered";
}

/** Constructs a GM connection dialog whose input is never registered or saved as a setting. */
function connectionOptions() {
  requireConnectionGM();
  const content = document.createElement("div");
  content.innerHTML = `<div class="pza-knowledge-connection">
    <p data-pza-ai-destination></p>
    <label>API key<input name="pza-api-key" type="text" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
    <p class="hint">Kept only until you reload or close this tab.</p>
    <p data-pza-ai-key-status aria-live="polite"></p>
    <p data-pza-ai-gm-note></p>
  </div>`;
  const profile = knowledgeAIProfile();
  content.querySelector("[data-pza-ai-destination]").textContent = `Destination: ${profile.endpoint}`;
  content.querySelector("[data-pza-ai-key-status]").textContent = hasKnowledgeApiKey() ? "Key entered for this session" : "No key entered";
  content.querySelector("[data-pza-ai-gm-note]").textContent = isKnowledgeActiveGM() ? ""
    : "The active GM must enter a key in their own tab to answer questions.";
  return {
    id: "pza-knowledge-ai-connection", window: { title: "AI Connection" }, position: { width: 520 },
    content, form: { closeOnSubmit: false },
    buttons: [
      { action: "use", label: "Use for this session", default: true, callback: (_event, button) => {
        requireConnectionGM();
        const input = button.form.querySelector('[name="pza-api-key"]');
        try {
          setKnowledgeApiKey(input.value);
          input.value = "";
          updateConnectionStatus(button.form);
        } catch (_error) { ui.notifications.warn("Enter a valid API key and check the API endpoint in game settings."); }
      } },
      { action: "clear", label: "Clear key", callback: (_event, button) => {
        requireConnectionGM();
        button.form.querySelector('[name="pza-api-key"]').value = "";
        clearKnowledgeApiKey();
        updateConnectionStatus(button.form);
      } },
      { action: "close", label: "Close", callback: (_event, _button, dialog) => dialog.close() }
    ]
  };
}

/** Registers world-wide connection options and a restricted session-key submenu during init. */
export function registerKnowledgeAISettings() {
  game.settings.register(QUESTION_MODULE_ID, KNOWLEDGE_API_ENDPOINT_SETTING, {
    name: "Recall Knowledge API endpoint",
    hint: "Complete Responses API URL. The session key is sent here. Changing this clears the key; enter a key for the new destination in AI Connection.",
    scope: "world", config: true,
    type: new foundry.data.fields.StringField({ blank: false, nullable: false, trim: true,
      initial: DEFAULT_KNOWLEDGE_API_ENDPOINT, validate: (value) => { normalizeKnowledgeEndpoint(value); return true; } }),
    default: DEFAULT_KNOWLEDGE_API_ENDPOINT, onChange: clearKnowledgeApiKey
  });
  game.settings.register(QUESTION_MODULE_ID, KNOWLEDGE_MODEL_SETTING, {
    name: "Recall Knowledge model", hint: "Model name accepted by your API endpoint. Changes apply to new AI attempts.",
    scope: "world", config: true,
    type: new foundry.data.fields.StringField({ blank: false, nullable: false, trim: true, initial: DEFAULT_KNOWLEDGE_MODEL }),
    default: DEFAULT_KNOWLEDGE_MODEL
  });
  connectionClass = class KnowledgeAIConnection extends foundry.applications.api.DialogV2 {
    /** Builds the settings submenu with an empty input and current session status. */
    constructor() {
      super(connectionOptions());
      connectionDialog = this;
      this.addEventListener("close", () => {
        const input = this.element?.querySelector('[name="pza-api-key"]');
        if (input) input.value = "";
        if (connectionDialog === this) connectionDialog = null;
      }, { once: true });
    }
  };
  game.settings.registerMenu(QUESTION_MODULE_ID, "recallKnowledgeAIConnection", {
    name: "AI Connection", label: "AI Connection", hint: "Enter or clear the API key for this GM tab.",
    icon: "fa-solid fa-key", type: connectionClass, restricted: true
  });
}

/** Opens the same GM-only session-key dialog from private question cards. */
export async function openKnowledgeAIConnection() {
  requireConnectionGM();
  if (connectionDialog?.rendered) {
    connectionDialog.bringToFront();
    return connectionDialog;
  }
  const dialog = new connectionClass();
  await dialog.render({ force: true });
  return dialog;
}
