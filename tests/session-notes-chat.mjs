import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerSessionNotesChat, refreshSessionNotesChat } from "../scripts/session-notes-chat.js";

const dom = new JSDOM("<!doctype html><body></body>");

globalThis.document = dom.window.document;

const hooks = new Map();

globalThis.Hooks = {
  on(name, callback) {
    const id = Symbol(name);

    hooks.set(id, { name, callback });

    return id;
  },
  off(_name, id) {
    hooks.delete(id);
  }
};

const calls = [];
const errors = [];
const module = { active: true, api: {} };
let enabled = true;

globalThis.ui = { notifications: { error: message => errors.push(message) } };

function emit(name, ...args) {
  for (const hook of hooks.values()) if (hook.name === name) hook.callback(...args);
}

function reset() {
  registerSessionNotesChat()();
  document.body.replaceChildren();
  calls.length = errors.length = 0;
  globalThis.game = {
    user: { id: "gm", isGM: true },
    system: { id: "pf2e" },
    settings: { get: (_scope, key) => key === "sessionNotesEnabled" ? enabled : undefined },
    modules: { get: id => id === "pf2e-zone-automation" ? module : null }
  };

  enabled = true;
  module.active = true;
  module.api = {
    async openSessionNotes() {
      calls.push("session");
    },
    async openQuickNote() {
      calls.push("note");
    },
    async promptAdvanceSessionTime() {
      calls.push("clock");
    }
  };
}

function chat(application = {}) {
  const root = document.createElement("section");

  root.innerHTML = '<div class="chat-history"><ol class="chat-log"><li>Existing chat message</li></ol></div><div class="chat-composer"><div id="chat-controls">Roll mode controls</div><form id="chat-form"><textarea name="chat-message"></textarea></form></div>';
  root.querySelector("textarea").value = "An unfinished message";
  document.body.append(root);
  emit("renderChatLog", application, root);

  return { root, application };
}

function button(root, method) {
  return root.querySelector(`[data-pza-session-open="${method}"]`);
}

test("chat shortcuts stay above the composer outside message history and leave the existing draft and form untouched", async () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    const { root } = chat();

    assert.deepEqual(
      [...root.querySelectorAll("nav button")].map(button => button.textContent.trim()),
      ["Session Notes", "Quick Note", "Advance Time"]
    );

    assert.equal(root.querySelector(".chat-log nav"), null);
    assert.equal(root.querySelector("nav").nextElementSibling, root.querySelector("#chat-controls"));
    assert.equal(root.querySelector(".chat-history nav"), null);
    assert.equal(root.querySelector("textarea").value, "An unfinished message");
    assert.equal(button(root, "openQuickNote").type, "button");
    assert.equal(button(root, "openSessionNotes").getAttribute("aria-label"), "Open Session Notes");

    let submitted = false;

    root.querySelector("form").addEventListener("submit", () => {
      submitted = true;
    });

    button(root, "openSessionNotes").click();
    button(root, "openQuickNote").click();
    button(root, "promptAdvanceSessionTime").click();
    await Promise.resolve();
    assert.deepEqual(calls, ["session", "note", "clock"]);
    assert.equal(submitted, false);
  } finally {
    stop();
  }
});

test("registration and repeated renders neither duplicate controls nor multiply click handlers", async () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    assert.equal(registerSessionNotesChat(), stop);
    assert.equal(hooks.size, 5);

    const { root, application } = chat();
    const original = button(root, "openQuickNote");

    for (let i = 0; i < 12; i++) emit("renderChatLog", application, root);

    assert.equal(root.querySelectorAll("nav").length, 1);
    assert.equal(button(root, "openQuickNote"), original);
    original.click();
    await Promise.resolve();
    assert.deepEqual(calls, ["note"]);
  } finally {
    stop();
  }

  assert.equal(hooks.size, 0);
  assert.equal(document.querySelector("nav"), null);
});

test("docked and popped-out chat have independent shortcuts; replacements and close release old controls", () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    const docked = chat({ id: "chat" });
    const popout = chat({ id: "popout", isPopout: true });

    assert.equal(document.querySelectorAll("nav").length, 2);

    const replacement = chat(docked.application);

    assert.equal(docked.root.querySelector("nav"), null);
    assert.ok(replacement.root.querySelector("nav"));
    assert.ok(popout.root.querySelector("nav"));
    emit("closeChatLog", popout.application);
    assert.equal(popout.root.querySelector("nav"), null);
    assert.ok(replacement.root.querySelector("nav"));
  } finally {
    stop();
  }
});

test("player clients get no controls; losing GM permission also blocks a retained button reference", async () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    game.user.isGM = false;

    const { root, application } = chat();

    assert.equal(root.querySelector("nav"), null);
    game.user.isGM = true;
    emit("updateUser", game.user);

    const oldButton = button(root, "openQuickNote");

    assert.ok(oldButton);
    game.user.isGM = false;
    emit("updateUser", game.user);
    oldButton.click();
    await Promise.resolve();
    assert.equal(root.querySelector("nav"), null);
    assert.deepEqual(calls, []);
    emit("renderChatLog", application, root);
    assert.equal(root.querySelector("nav"), null);
  } finally {
    stop();
  }
});

test("an in-flight dialog launch rejects rapid double clicks and recovers when the entry point fails", async () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    let reject;

    module.api.openQuickNote = () => {
      calls.push("note");

      return new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    };

    const { root } = chat();
    const shortcut = button(root, "openQuickNote");

    shortcut.click();
    shortcut.click();
    assert.deepEqual(calls, ["note"]);
    assert.equal(shortcut.disabled, true);
    reject(new Error("Test launch failure"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(shortcut.disabled, false);
    assert.deepEqual(errors, ["Test launch failure"]);

    module.api.openQuickNote = async () => {
      calls.push("retry");
    };

    shortcut.click();
    await Promise.resolve();
    assert.deepEqual(calls, ["note", "retry"]);
  } finally {
    stop();
  }
});

test("missing module APIs report an error and unrelated systems do not receive shortcuts", async () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    const { root, application } = chat();

    module.active = false;
    button(root, "openSessionNotes").click();
    await Promise.resolve();
    assert.match(errors[0], /Session Notes is unavailable/);
    assert.deepEqual(calls, []);
    game.system.id = "another-system";
    emit("renderChatLog", application, root);
    assert.equal(root.querySelector("nav"), null);
  } finally {
    stop();
  }
});

test("Foundry's separate input hook mounts next to a rich-text composer outside the ChatLog root", () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    const application = {};
    const log = document.createElement("section");

    log.innerHTML = '<ol class="chat-log"><li>Old message</li></ol>';
    document.body.append(log);
    emit("renderChatLog", application, log);
    assert.equal(
      document.querySelector("nav"),
      null,
      "Do not hide shortcuts above message history while waiting for the composer"
    );

    const composer = document.createElement("section");

    composer.innerHTML = '<div id="chat-controls">Roll controls</div><form id="chat-form"><div class="prosemirror"><div contenteditable="true"><p>Unsent rich-text draft</p></div></div></form>';
    document.body.append(composer);

    const controls = composer.querySelector("#chat-controls");
    const form = composer.querySelector("form");
    const editor = composer.querySelector("[contenteditable]");
    const original = editor.innerHTML;

    editor.focus();
    emit("renderChatInput", application, { "#chat-controls": controls, "#chat-form": form }, {});
    assert.equal(composer.querySelector("nav").nextElementSibling, controls);
    assert.equal(log.querySelector("nav"), null);
    assert.equal(editor.innerHTML, original);
    assert.equal(document.activeElement, editor);
    for (let i = 0; i < 10; i++)
      emit("renderChatInput", application, { "#chat-controls": controls, "#chat-form": form }, {});

    assert.equal(document.querySelectorAll("nav").length, 1);
  } finally {
    stop();
  }
});

test("a canonical input moved into popout and back carries one toolbar, including while the popout closes", async () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    const docked = chat({ id: "docked" });
    const popoutRoot = document.createElement("section");

    popoutRoot.innerHTML = '<ol class="chat-log"></ol>';
    document.body.append(popoutRoot);

    const popout = { element: popoutRoot };

    emit("renderChatLog", popout, popoutRoot);

    const controls = docked.root.querySelector("#chat-controls");
    const form = docked.root.querySelector("form");
    const toolbar = docked.root.querySelector("nav");

    popoutRoot.append(controls, form);
    emit("renderChatInput", popout, { "#chat-controls": controls, "#chat-form": form }, { previousParent: docked.root });
    assert.equal(popoutRoot.querySelector("nav"), toolbar);
    assert.equal(docked.root.querySelector("nav"), null);

    const dockedComposer = docked.root.querySelector(".chat-composer");

    dockedComposer.append(controls, form);
    emit(
      "renderChatInput",
      popout,
      { "#chat-controls": controls, "#chat-form": form },
      { previousParent: popoutRoot },
      { closing: true }
    );

    emit("closeChatLog", popout);
    assert.equal(docked.root.querySelector("nav"), toolbar);
    assert.equal(popoutRoot.querySelector("nav"), null);
    assert.equal(document.querySelectorAll("nav").length, 1);
    button(docked.root, "openQuickNote").click();
    await Promise.resolve();
    assert.deepEqual(calls, ["note"]);
    assert.equal(form.querySelector("textarea").value, "An unfinished message");
  } finally {
    stop();
  }
});

test("startup recovers an already-rendered composer without a renderChatLog event", () => {
  reset();

  const host = document.createElement("section");

  host.innerHTML = '<div id="chat-controls"></div><form id="chat-form"></form>';
  document.body.append(host);

  const stop = registerSessionNotesChat();

  try {
    assert.equal(host.querySelector("nav").nextElementSibling, host.querySelector("#chat-controls"));
    refreshSessionNotesChat();
    assert.equal(host.querySelectorAll("nav").length, 1);
  } finally {
    stop();
  }
});

test("a form-only fallback is replaced by the controls anchor without duplicating rows", () => {
  reset();

  const stop = registerSessionNotesChat();

  try {
    const host = document.createElement("section");

    host.innerHTML = '<form id="chat-form"><textarea>Draft</textarea></form>';
    document.body.append(host);

    const application = { element: host };
    const form = host.querySelector("form");

    emit("renderChatInput", application, { "#chat-form": form }, {});
    assert.equal(host.querySelectorAll("nav").length, 1);

    const controls = document.createElement("div");

    controls.id = "chat-controls";
    form.before(controls);
    emit("renderChatInput", application, { "#chat-controls": controls, "#chat-form": form }, {});
    assert.equal(host.querySelectorAll("nav").length, 1);
    assert.equal(host.querySelector("nav").nextElementSibling, controls);
    assert.equal(form.querySelector("textarea").value, "Draft");
  } finally {
    stop();
  }
});

test("the feature switch hides controls while off and restores them live without allowing retained clicks", async () => {
  reset();
  enabled = false;

  const stop = registerSessionNotesChat();

  try {
    const { root } = chat();

    assert.equal(root.querySelector("nav"), null);
    enabled = true;
    emit("pf2eZoneSessionNotesEnabled", true);

    const oldButton = button(root, "openQuickNote");

    assert.ok(oldButton);
    enabled = false;
    emit("pf2eZoneSessionNotesEnabled", false);
    oldButton.click();
    await Promise.resolve();
    assert.equal(root.querySelector("nav"), null);
    assert.deepEqual(calls, []);
    enabled = true;
    emit("pf2eZoneSessionNotesEnabled", true);
    assert.equal(root.querySelectorAll("nav").length, 1);
    assert.equal(root.querySelector("textarea").value, "An unfinished message");
  } finally {
    stop();
  }
});
