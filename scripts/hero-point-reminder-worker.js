import { readDocumentFlag } from "./utils.js";

const MODULE_ID = "pf2e-zone-automation";
const REMINDERS_FLAG = "heroPointReminders";
const creations = new Map();
const userTails = new Map();

/** Rechecks the recipient and elected GM before a queued reminder can change User flags. */
function requireReminderCreator(requesterUserId, workerUserId = game.user?.id) {
  if (!game.user?.isGM || game.user.id !== workerUserId || game.users.activeGM?.id !== workerUserId) {
    throw new Error("Hero Point reminders must be saved by the active GM. Try again.");
  }
  const user = game.users.get(requesterUserId);
  if (!user?.isGM || !user.active) throw new Error("Only an active GM can create Hero Point reminders.");
  return user;
}

/** Reuses pending records, including older reminders whose IDs were randomly generated. */
function existingReminder(user, remindAt) {
  const records = readDocumentFlag(user, MODULE_ID, REMINDERS_FLAG);
  if (!records || typeof records !== "object" || Array.isArray(records)) return null;
  const existing = Object.entries(records).find(([id, record]) =>
    /^[a-zA-Z0-9]{16}$/.test(id) && record?.remindAt === remindAt);
  return existing ? { id: existing[0], remindAt, recipientUserId: user.id } : null;
}

/** Gives the same recipient and absolute time one document identity across retries, tabs, and GM handoffs. */
async function reminderDocumentId(userId, remindAt) {
  const identity = new TextEncoder().encode(JSON.stringify([MODULE_ID, REMINDERS_FLAG, userId, remindAt]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", identity));
  // Eighty bits fit in sixteen base-36 characters, all accepted by Foundry document IDs.
  const value = digest.slice(0, 10).reduce((total, byte) => (total << 8n) + BigInt(byte), 0n);
  return value.toString(36).padStart(16, "0");
}

/** Serializes one recipient's creation without blocking unrelated GMs or retaining rejected queue tails. */
function serializeReminderUser(userId, create) {
  const result = (userTails.get(userId) ?? Promise.resolve()).then(create);
  const tail = result.then(() => undefined, () => undefined);
  userTails.set(userId, tail);
  tail.then(() => { if (userTails.get(userId) === tail) userTails.delete(userId); });
  return result;
}

/** Rechecks saved state inside the queue and confirms uncertain acknowledgments using the exact record. */
async function saveReminder(requesterUserId, remindAt, workerUserId) {
  let user = requireReminderCreator(requesterUserId, workerUserId);
  let existing = existingReminder(user, remindAt);
  if (existing) return existing;
  const id = await reminderDocumentId(user.id, remindAt);
  user = requireReminderCreator(requesterUserId, workerUserId);
  existing = existingReminder(user, remindAt);
  if (existing) return existing;
  const collision = readDocumentFlag(user, MODULE_ID, REMINDERS_FLAG)?.[id];
  if (collision != null) throw new Error("The Hero Point reminder ID is already in use.");
  try {
    await user.update({ [`flags.${MODULE_ID}.${REMINDERS_FLAG}.${id}`]: { remindAt } });
  } catch (error) {
    if (readDocumentFlag(user, MODULE_ID, REMINDERS_FLAG)?.[id]?.remindAt !== remindAt) throw error;
  }
  if (readDocumentFlag(user, MODULE_ID, REMINDERS_FLAG)?.[id]?.remindAt !== remindAt) {
    throw new Error("The Hero Point reminder save could not be confirmed. Try again.");
  }
  return { id, remindAt, recipientUserId: user.id };
}

/** Reserves matching requests synchronously before any ID lookup or User update can yield. */
export function executeCreateHeroPointReminder(request) {
  const user = requireReminderCreator(request.requesterUserId);
  const remindAt = request.remindAt;
  if (!Number.isSafeInteger(remindAt) || remindAt <= 0 || remindAt > 8_640_000_000_000_000) {
    throw new Error("A valid Hero Point reminder timestamp is required.");
  }
  const key = JSON.stringify([user.id, remindAt]);
  const pending = creations.get(key);
  if (pending) return pending;
  const workerUserId = game.user.id;
  const creation = serializeReminderUser(user.id, () => saveReminder(user.id, remindAt, workerUserId))
    .then(reminder => ({ action: "create-hero-point-reminder", reminder }))
    .finally(() => { if (creations.get(key) === creation) creations.delete(key); });
  creations.set(key, creation);
  return creation;
}
