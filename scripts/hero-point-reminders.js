import { isGMAuthoredMessage, readDocumentFlag } from "./utils.js";
import { requestGMWorker } from "./transport.js";

const MODULE_ID = "pf2e-zone-automation";
const REMINDERS_FLAG = "heroPointReminders";
const MESSAGE_FLAG = "heroPointReminder";
const RETRY_DELAY_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
let installed = false;
let timer = null;
let delivery = null;
let retryAfter = 0;
let reminderChatHook = null;
const wiredReminderButtons = new WeakSet();

/** Limits the private reminder's dialog shortcut to the user who created it. */
function canOpenReminder(message) {
  const marker = readDocumentFlag(message, MODULE_ID, MESSAGE_FLAG);
  return Boolean(game.user && Number.isFinite(marker?.remindAt)
    && isDeliveredReminder(message, { user: game.user, remindAt: marker.remindAt }));
}

/** Adds a dialog shortcut to new and previously saved reminders whenever Foundry renders them. */
function renderReminderChat(message, html) {
  const selector = "button[data-pza-hero-point-reminder]";
  const buttons = [...html.querySelectorAll(selector)];
  if (!canOpenReminder(message)) {
    for (const button of buttons) button.remove();
    return;
  }
  const button = buttons[0] ?? html.ownerDocument.createElement("button");
  for (const duplicate of buttons.slice(1)) duplicate.remove();
  if (wiredReminderButtons.has(button)) return;
  button.type = "button";
  button.dataset.pzaHeroPointReminder = "";
  button.textContent = game.user.isGM ? "Award Hero Points" : "Set Hero Points";
  if (!button.parentElement) (html.querySelector(".message-content") ?? html).append(button);
  wiredReminderButtons.add(button);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled || !canOpenReminder(message)) return;
    button.disabled = true;
    try {
      const api = game.modules.get(MODULE_ID)?.api;
      if (typeof api?.promptSetHeroPoints !== "function") throw new Error("The Hero Points dialog is unavailable. Refresh Foundry and try again.");
      await api.promptSetHeroPoints();
    } catch (error) {
      console.error("PF2e Zone Hero Point reminder button failed", error);
      ui.notifications.error(error?.message ?? "The Hero Points dialog could not be opened. Try again.");
    } finally {
      button.disabled = false;
    }
  });
}

/** Registers before chat history loads so reminders retain working buttons after a refresh. */
export function registerHeroPointReminderChat() {
  if (reminderChatHook !== null) return;
  const hook = Hooks.on("renderChatMessageHTML", renderReminderChat);
  reminderChatHook = hook;
  return () => {
    Hooks.off("renderChatMessageHTML", hook);
    if (reminderChatHook === hook) reminderChatHook = null;
  };
}

/** Interprets a local clock time as its next occurrence, including tomorrow when today's time has passed. */
export function reminderTimestamp(time, now = Date.now()) {
  if (typeof time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Enter a reminder time, such as 20:30.");
  }
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date(now);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** Uses one elected GM to deliver saved reminders across refreshes and GM handoffs. */
function isReminderGM() {
  return game.user?.isGM && game.users.activeGM?.id === game.user.id;
}

/** Ignores malformed stored data while retaining each reminder's recipient and stable message ID. */
function savedReminders() {
  const reminders = [];
  for (const user of game.users) {
    const saved = readDocumentFlag(user, MODULE_ID, REMINDERS_FLAG);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) continue;
    for (const [id, record] of Object.entries(saved)) {
      if (/^[a-zA-Z0-9]{16}$/.test(id) && Number.isFinite(record?.remindAt)) {
        reminders.push({ id, user, remindAt: record.remindAt });
      }
    }
  }
  return reminders.sort((a, b) => a.remindAt - b.remindAt);
}

/** Reports whether the current user has any pending private reminders, including overdue reminders. */
export function hasHeroPointReminders() {
  return Boolean(game.user && savedReminders().some((entry) => entry.user.id === game.user.id));
}

/** Removes only the current user's pending reminders through the authenticated GM worker. */
export async function clearHeroPointReminders() {
  const response = await requestGMWorker({
    protocol: 1, action: "clear-hero-point-reminders", requesterUserId: game.user.id
  });
  if (!response?.ok) throw new Error(response?.error ?? "The Hero Point reminders could not be cleared. Try again.");
  scheduleNextReminder();
  return response.count;
}

/** Saves a private reminder before starting its timer so a refresh cannot discard it. */
export async function createHeroPointReminder(time) {
  const user = game.user;
  const remindAt = reminderTimestamp(time);
  const response = await requestGMWorker({
    protocol: 1, action: "create-hero-point-reminder", requesterUserId: user.id, remindAt
  });
  if (!response?.ok) throw new Error(response?.error ?? "The Hero Point reminder could not be saved. Try again.");
  scheduleNextReminder();
  return response.reminder;
}

/** Accepts only a private reminder from its recipient or a GM before reusing delivery or granting its shortcut. */
function isDeliveredReminder(message, reminder) {
  const marker = readDocumentFlag(message, MODULE_ID, MESSAGE_FLAG);
  if (marker?.recipientUserId !== reminder.user.id || marker?.remindAt !== reminder.remindAt
    || !Array.isArray(message.whisper) || message.whisper.length !== 1) return false;
  const recipient = typeof message.whisper[0] === "string" ? message.whisper[0] : message.whisper[0]?.id;
  if (recipient !== reminder.user.id) return false;
  const author = message.author !== undefined ? message.author : message.user;
  const authorId = typeof author === "string" ? author : author?.id;
  return isGMAuthoredMessage(message) || (!reminder.user.isGM && authorId === reminder.user.id);
}

/** Posts one private chat message, then removes its pending record only after confirmed delivery. */
async function deliverReminder(reminder) {
  // Another client may clear a reminder while this delivery batch awaits an earlier message.
  const pending = readDocumentFlag(reminder.user, MODULE_ID, REMINDERS_FLAG)?.[reminder.id];
  if (pending?.remindAt !== reminder.remindAt) return;
  let message = game.messages.get(reminder.id);
  if (message && !isDeliveredReminder(message, reminder)) throw new Error("A Hero Point reminder message ID is already in use.");
  if (!message) {
    try {
      message = await ChatMessage.create({
        _id: reminder.id,
        author: reminder.user.isGM ? game.user.id : reminder.user.id,
        whisper: [reminder.user.id],
        content: `<p><strong>Hero Point reminder</strong></p><p>It's time to award ${reminder.user.isGM ? "everyone" : "your characters"} 1 Hero Point.</p>`,
        flags: { [MODULE_ID]: { [MESSAGE_FLAG]: { recipientUserId: reminder.user.id, remindAt: reminder.remindAt } } }
      }, { keepId: true });
    } catch (error) {
      // A handoff can race another GM's completed creation. The same ID prevents a second message.
      message = game.messages.get(reminder.id);
      if (!isDeliveredReminder(message, reminder)) throw error;
    }
  }
  if (!isDeliveredReminder(message, reminder)) throw new Error("The Hero Point reminder could not be delivered.");
  await reminder.user.update({ [`flags.${MODULE_ID}.${REMINDERS_FLAG}.${reminder.id}`]: new foundry.data.operators.ForcedDeletion() });
}

/** Reserves delivery synchronously so timer, reconnect, and document hooks cannot send overlapping reminders. */
export function deliverHeroPointReminders(now = Date.now()) {
  if (delivery) return delivery;
  if (!isReminderGM()) return Promise.resolve();
  delivery = Promise.resolve().then(async () => {
    const failures = [];
    for (const reminder of savedReminders().filter((entry) => entry.remindAt <= now)) {
      if (!isReminderGM()) break;
      try {
        await deliverReminder(reminder);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Some Hero Point reminders could not be delivered; retrying shortly.");
    retryAfter = 0;
  }).catch((error) => {
    retryAfter = Date.now() + RETRY_DELAY_MS;
    throw error;
  }).finally(() => {
    delivery = null;
    scheduleNextReminder();
  });
  return delivery;
}

/** Sleeps until the earliest saved reminder, with bounded retries when Foundry rejects a delivery. */
function scheduleNextReminder() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!installed || delivery || !isReminderGM()) return;
  const next = savedReminders()[0];
  if (!next) return;
  const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.max(next.remindAt, retryAfter) - Date.now()));
  timer = setTimeout(() => {
    timer = null;
    void deliverHeroPointReminders().catch((error) => console.warn("PF2e Zone Hero Point reminder delivery failed", error));
  }, delay);
}

/** Restores timers on world startup and follows reminder edits and changes to the active GM. */
export function registerHeroPointReminders() {
  if (installed || !game.user?.isGM) return;
  installed = true;
  const userHook = Hooks.on("updateUser", scheduleNextReminder);
  const connectionHook = Hooks.on("userConnected", scheduleNextReminder);
  scheduleNextReminder();
  /** Releases the scheduler and its hooks for tests or module teardown. */
  return () => {
    installed = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    Hooks.off("updateUser", userHook);
    Hooks.off("userConnected", connectionHook);
  };
}
