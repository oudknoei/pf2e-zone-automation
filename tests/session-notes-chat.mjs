import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { registerSessionNotesChat } from "../scripts/session-notes-chat.js";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
const hooks = new Map();
globalThis.Hooks = {
  on(name, callback) { const id = Symbol(name); hooks.set(id, { name, callback }); return id; },
  off(_name, id) { hooks.delete(id); }
};
const calls = [];
const errors = [];
const module = { active: true, api: {} };
globalThis.ui = { notifications: { error: message => errors.push(message) } };

function emit(name, ...args) {
  for (const hook of hooks.values()) if (hook.name === name) hook.callback(...args);
}
function reset() {
  registerSessionNotesChat()();
  document.body.replaceChildren(); calls.length = errors.length = 0;
  globalThis.game = { user: { id: "gm", isGM: true }, system: { id: "pf2e" },
    modules: { get: id => id === "pf2e-zone-automation" ? module : null } };
  module.active = true;
  module.api = {
    async openSessionNotes() { calls.push("session"); },
    async openQuickNote() { calls.push("note"); }
  };
}
function chat(application = {}) {
  const root = document.createElement("section");
  root.innerHTML = '<ol class="chat-log"><li>Existing chat message</li></ol><form><textarea name="chat-message"></textarea></form>';
  root.querySelector("textarea").value = "An unfinished message";
  document.body.append(root);
  emit("renderChatLog", application, root);
  return { root, application };
}
function button(root, method) { return root.querySelector(`[data-pza-session-open="${method}"]`); }

test("chat shortcuts render outside message history and leave the existing draft and form untouched", async () => {
  reset(); const stop = registerSessionNotesChat();
  try {
    const { root } = chat();
    assert.deepEqual([...root.querySelectorAll("nav button")].map(button => button.textContent.trim()), ["Session Notes", "Quick Note"]);
    assert.equal(root.querySelector(".chat-log nav"), null);
    assert.equal(root.querySelector("nav").nextElementSibling, root.querySelector(".chat-log"));
    assert.equal(root.querySelector("textarea").value, "An unfinished message");
    assert.equal(button(root, "openQuickNote").type, "button");
    assert.equal(button(root, "openSessionNotes").getAttribute("aria-label"), "Open Session Notes");
    let submitted = false; root.querySelector("form").addEventListener("submit", () => { submitted = true; });
    button(root, "openSessionNotes").click(); button(root, "openQuickNote").click();
    await Promise.resolve();
    assert.deepEqual(calls, ["session", "note"]); assert.equal(submitted, false);
  } finally { stop(); }
});

test("registration and repeated renders neither duplicate controls nor multiply click handlers", async () => {
  reset(); const stop = registerSessionNotesChat();
  try {
    assert.equal(registerSessionNotesChat(), stop); assert.equal(hooks.size, 3);
    const { root, application } = chat();
    const original = button(root, "openQuickNote");
    for (let i = 0; i < 12; i++) emit("renderChatLog", application, root);
    assert.equal(root.querySelectorAll("nav").length, 1);
    assert.equal(button(root, "openQuickNote"), original);
    original.click(); await Promise.resolve(); assert.deepEqual(calls, ["note"]);
  } finally { stop(); }
  assert.equal(hooks.size, 0); assert.equal(document.querySelector("nav"), null);
});

test("docked and popped-out chat have independent shortcuts; replacements and close release old controls", () => {
  reset(); const stop = registerSessionNotesChat();
  try {
    const docked = chat({ id: "chat" }); const popout = chat({ id: "popout", isPopout: true });
    assert.equal(document.querySelectorAll("nav").length, 2);
    const replacement = chat(docked.application);
    assert.equal(docked.root.querySelector("nav"), null);
    assert.ok(replacement.root.querySelector("nav")); assert.ok(popout.root.querySelector("nav"));
    emit("closeChatLog", popout.application);
    assert.equal(popout.root.querySelector("nav"), null);
    assert.ok(replacement.root.querySelector("nav"));
  } finally { stop(); }
});

test("player clients get no controls; losing GM permission also blocks a retained button reference", async () => {
  reset(); const stop = registerSessionNotesChat();
  try {
    game.user.isGM = false; const { root, application } = chat();
    assert.equal(root.querySelector("nav"), null);
    game.user.isGM = true; emit("updateUser", game.user);
    const oldButton = button(root, "openQuickNote"); assert.ok(oldButton);
    game.user.isGM = false; emit("updateUser", game.user); oldButton.click();
    await Promise.resolve(); assert.equal(root.querySelector("nav"), null); assert.deepEqual(calls, []);
    emit("renderChatLog", application, root); assert.equal(root.querySelector("nav"), null);
  } finally { stop(); }
});

test("an in-flight dialog launch rejects rapid double clicks and recovers when the entry point fails", async () => {
  reset(); const stop = registerSessionNotesChat();
  try {
    let reject;
    module.api.openQuickNote = () => { calls.push("note"); return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }); };
    const { root } = chat(); const shortcut = button(root, "openQuickNote");
    shortcut.click(); shortcut.click(); assert.deepEqual(calls, ["note"]); assert.equal(shortcut.disabled, true);
    reject(new Error("Test launch failure")); await Promise.resolve(); await Promise.resolve();
    assert.equal(shortcut.disabled, false); assert.deepEqual(errors, ["Test launch failure"]);
    module.api.openQuickNote = async () => { calls.push("retry"); };
    shortcut.click(); await Promise.resolve(); assert.deepEqual(calls, ["note", "retry"]);
  } finally { stop(); }
});

test("missing module APIs report an error and unrelated systems do not receive shortcuts", async () => {
  reset(); const stop = registerSessionNotesChat();
  try {
    const { root, application } = chat(); module.active = false;
    button(root, "openSessionNotes").click(); await Promise.resolve();
    assert.match(errors[0], /Session Notes is unavailable/); assert.deepEqual(calls, []);
    game.system.id = "another-system"; emit("renderChatLog", application, root);
    assert.equal(root.querySelector("nav"), null);
  } finally { stop(); }
});
