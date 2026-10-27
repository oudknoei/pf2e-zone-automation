const MODULE_ID = "pf2e-zone-automation";
const TOOLBAR = ".pza-session-chat-buttons";
const roots = new Map();
const wired = new WeakSet();
let cleanup = null;

/** Adds module entry points outside the scrolling message list, without touching the chat composer. */
function renderSessionNotesChat(application, html) {
  const root = html?.[0] ?? html;
  if (!root?.querySelectorAll) return;
  const previous = roots.get(application);
  if (previous && previous !== root) for (const toolbar of previous.querySelectorAll(TOOLBAR)) toolbar.remove();
  roots.set(application, root);
  const toolbars = [...root.querySelectorAll(TOOLBAR)];
  if (!game.user?.isGM || game.system.id !== "pf2e") {
    for (const toolbar of toolbars) toolbar.remove();
    return;
  }
  const list = root.querySelector("#chat-log, .chat-log");
  const host = list?.parentElement ?? root.querySelector(".window-content") ?? root;
  const toolbar = toolbars[0] ?? root.ownerDocument.createElement("nav");
  for (const duplicate of toolbars.slice(1)) duplicate.remove();
  toolbar.className = "pza-session-chat-buttons";
  toolbar.setAttribute("aria-label", "Session Notes shortcuts");
  if (list && (toolbar.parentElement !== host || toolbar.nextElementSibling !== list)) list.before(toolbar);
  else if (toolbar.parentElement !== host) host.prepend(toolbar);
  for (const [method, label, icon] of [["openSessionNotes", "Session Notes", "fa-book-open"],
    ["openQuickNote", "Quick Note", "fa-pen-to-square"]]) {
    const button = toolbar.querySelector(`[data-pza-session-open="${method}"]`) ?? root.ownerDocument.createElement("button");
    if (wired.has(button)) continue;
    button.type = "button";
    button.dataset.pzaSessionOpen = method;
    button.title = `Open ${label}`;
    button.setAttribute("aria-label", button.title);
    const image = root.ownerDocument.createElement("i");
    image.className = `fa-solid ${icon}`;
    image.setAttribute("aria-hidden", "true");
    button.replaceChildren(image, root.ownerDocument.createTextNode(` ${label}`));
    toolbar.append(button);
    wired.add(button);
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled || !game.user?.isGM || game.system.id !== "pf2e") return;
      button.disabled = true;
      try {
        const module = game.modules.get(MODULE_ID);
        if (!module?.active || typeof module.api?.[method] !== "function") {
          throw new Error(`${label} is unavailable. Refresh Foundry and try again.`);
        }
        await module.api[method]();
      } catch (error) {
        ui.notifications.error(error?.message ?? `${label} could not be opened.`);
      } finally { button.disabled = false; }
    });
  }
}

/** Installs GM-only shortcuts for both docked and popped-out chat, with idempotent registration and teardown. */
export function registerSessionNotesChat() {
  if (cleanup) return cleanup;
  const hooks = [
    ["renderChatLog", Hooks.on("renderChatLog", renderSessionNotesChat)],
    ["closeChatLog", Hooks.on("closeChatLog", application => {
      const root = roots.get(application);
      for (const toolbar of root?.querySelectorAll(TOOLBAR) ?? []) toolbar.remove();
      roots.delete(application);
    })],
    ["updateUser", Hooks.on("updateUser", () => {
      for (const [application, root] of roots) renderSessionNotesChat(application, root);
    })]
  ];
  /** Removes only this feature's listeners and controls when its registration is released. */
  cleanup = () => {
    for (const [name, id] of hooks) Hooks.off(name, id);
    for (const root of roots.values()) for (const toolbar of root.querySelectorAll(TOOLBAR)) toolbar.remove();
    roots.clear();
    cleanup = null;
  };
  return cleanup;
}
