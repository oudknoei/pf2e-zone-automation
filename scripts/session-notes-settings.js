import {
  SESSION_MODULE,
  SESSION_ENABLED_SETTING,
  SESSION_ENABLED_HOOK
} from "./session-notes-data.js";
import { CLOCK_SETTING, CLOCK_CHANGED_HOOK } from "./session-clock-data.js";

/** Registers the campaign clock state and the GM-only Session Notes switch. */
export function registerSessionNotesSettings() {
  game.settings.register(SESSION_MODULE, CLOCK_SETTING, {
    name: "Campaign clock state",
    scope: "world",
    config: false,
    restricted: true,
    type: Object,
    default: {},
    onChange: () => Hooks.callAll(CLOCK_CHANGED_HOOK)
  });

  game.settings.register(SESSION_MODULE, SESSION_ENABLED_SETTING, {
    name: "Enable Session Notes",
    hint: "Enable GM session notebooks, Quick Note, Advance Time, and chat shortcuts. Turning this off closes Session Notes windows; saved Journals and clock state are kept.",
    scope: "world",
    config: true,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: enabled => Hooks.callAll(SESSION_ENABLED_HOOK, enabled)
  });
}

/** Places the Session Notes switch first among this module's native settings. */
export function registerSessionNotesSettingsUI() {
  /** Reorders the existing setting without changing its value. */
  function render(_application, html) {
    const root = html?.querySelector ? html : html?.[0];

    if (!root?.querySelector) return;

    const enabledRow = root.querySelector(`input[name="${SESSION_MODULE}.${SESSION_ENABLED_SETTING}"]`)?.closest(".form-group");

    if (!enabledRow) return;

    const firstRow = root.querySelector(`[name^="${SESSION_MODULE}."], button[data-key^="${SESSION_MODULE}."]`)?.closest(".form-group");

    if (firstRow && firstRow !== enabledRow) firstRow.before(enabledRow);
  }

  const hook = Hooks.on("renderSettingsConfig", render);

  return () => Hooks.off("renderSettingsConfig", hook);
}
