const MODULE_ID = "pf2e-zone-automation";
const roots = new Map();
const anchors = new Map();
const wired = new WeakSet();
let cleanup = null;

/** Finds the native composer controls even when Foundry renders them outside the ChatLog application. */
function composerAnchor(candidates) {
  for (const selector of ["#chat-controls", "#chat-form", "[data-application-part='input']"]) {
    for (const candidate of candidates) {
      const root = candidate?.[0] ?? candidate;
      const element = root?.matches?.(selector) ? root : root?.querySelector?.(selector);
      if (element?.parentElement) return element;
    }
  }
  return null;
}

/** Releases stale controls after a composer is replaced or an earlier chat application is removed. */
function pruneAnchors() {
  for (const [anchor, toolbar] of anchors) {
    if (anchor.isConnected) continue;
    toolbar.remove();
    anchors.delete(anchor);
  }
}

/** Keeps one shortcut row directly above the composer controls, outside scrolling message history. */
function mountShortcuts(anchor) {
  pruneAnchors();
  if (!anchor?.parentElement) return;
  for (const [other, toolbar] of anchors) {
    if (other === anchor || !(other.parentElement === anchor.parentElement || other.contains(anchor) || anchor.contains(other))) continue;
    toolbar.remove();
    anchors.delete(other);
  }
  let toolbar = anchors.get(anchor);
  if (!game.user?.isGM || game.system.id !== "pf2e") {
    toolbar?.remove();
    anchors.delete(anchor);
    return;
  }
  toolbar ??= anchor.ownerDocument.createElement("nav");
  anchors.set(anchor, toolbar);
  toolbar.className = "pza-session-chat-buttons";
  toolbar.setAttribute("aria-label", "Session Notes shortcuts");
  if (toolbar.nextElementSibling !== anchor || toolbar.parentElement !== anchor.parentElement) anchor.before(toolbar);
  for (const [method, label, icon] of [["openSessionNotes", "Session Notes", "fa-book-open"],
    ["openQuickNote", "Quick Note", "fa-pen-to-square"]]) {
    const button = toolbar.querySelector(`[data-pza-session-open="${method}"]`) ?? anchor.ownerDocument.createElement("button");
    if (wired.has(button)) continue;
    button.type = "button";
    button.dataset.pzaSessionOpen = method;
    button.title = `Open ${label}`;
    button.setAttribute("aria-label", button.title);
    const image = anchor.ownerDocument.createElement("i");
    image.className = `fa-solid ${icon}`;
    image.setAttribute("aria-hidden", "true");
    button.replaceChildren(image, anchor.ownerDocument.createTextNode(` ${label}`));
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

/** Covers normal and partial ChatLog renders without placing controls inside the message list. */
function renderSessionNotesChat(application, html) {
  const candidate = html?.[0] ?? html;
  const root = candidate?.querySelector ? candidate : application?.element;
  if (!root?.querySelector) return;
  const previous = roots.get(application);
  if (previous && previous !== root) {
    for (const [anchor, toolbar] of anchors) {
      if (!previous.contains(anchor) || root.contains(anchor)) continue;
      toolbar.remove();
      anchors.delete(anchor);
    }
  }
  roots.set(application, root);
  mountShortcuts(composerAnchor([root, root.ownerDocument]));
}

/** Follows Foundry's canonical input when it is adopted by docked chat, popout chat, or notifications. */
function renderSessionNotesInput(application, elements) {
  mountShortcuts(composerAnchor([...Object.values(elements ?? {}), application?.element]));
}

/** Recovers an already-rendered composer at startup and responds to GM permission changes. */
export function refreshSessionNotesChat() {
  pruneAnchors();
  for (const anchor of [...anchors.keys()]) mountShortcuts(anchor);
  for (const root of roots.values()) mountShortcuts(composerAnchor([root]));
  mountShortcuts(composerAnchor([globalThis.document]));
}

/** Installs GM-only shortcuts for both docked and popped-out chat, with idempotent registration and teardown. */
export function registerSessionNotesChat() {
  if (cleanup) return cleanup;
  const hooks = [
    ["renderChatLog", Hooks.on("renderChatLog", renderSessionNotesChat)],
    ["renderChatInput", Hooks.on("renderChatInput", renderSessionNotesInput)],
    ["closeChatLog", Hooks.on("closeChatLog", application => {
      const root = roots.get(application);
      for (const [anchor, toolbar] of anchors) {
        // The canonical input may already have moved back to another chat window.
        if (!root?.contains(anchor)) continue;
        toolbar.remove();
        anchors.delete(anchor);
      }
      roots.delete(application);
      pruneAnchors();
    })],
    ["updateUser", Hooks.on("updateUser", refreshSessionNotesChat)]
  ];
  /** Removes only this feature's listeners and controls when its registration is released. */
  cleanup = () => {
    for (const [name, id] of hooks) Hooks.off(name, id);
    for (const toolbar of anchors.values()) toolbar.remove();
    anchors.clear();
    roots.clear();
    cleanup = null;
  };
  refreshSessionNotesChat();
  return cleanup;
}
