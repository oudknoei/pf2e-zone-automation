/** Freezes dispatch and GM routing together so adding an action requires one policy entry. */
function actionPolicy(handler, authority) {
  return Object.freeze({ handler, authority });
}

export const WORKER_ACTION_POLICY = Object.freeze({
  "session-notes": actionPolicy("sessionNotes", "active-gm"),
  create: actionPolicy("createZone", "gm"),
  move: actionPolicy("moveZone", "gm"),
  end: actionPolicy("endZone", "gm"),
  "cancel-pending-save": actionPolicy("cancelPendingSave", "active-gm"),
  "set-hero-points": actionPolicy("setHeroPoints", "active-gm"),
  "create-hero-point-reminder": actionPolicy("createHeroPointReminder", "active-gm"),
  "clear-hero-point-reminders": actionPolicy("clearHeroPointReminders", "active-gm"),
  "shielding-taunt": actionPolicy("shieldingTaunt", "active-gm"),
  "library-list": actionPolicy("listPresets", "active-gm"),
  "library-save": actionPolicy("savePreset", "active-gm"),
  "library-delete": actionPolicy("deletePreset", "active-gm"),
  ping: actionPolicy("ping", "gm")
});

/** Rejects unknown or inherited action names before selecting a privileged handler. */
export function getWorkerActionPolicy(action) {
  return typeof action === "string" && Object.hasOwn(WORKER_ACTION_POLICY, action)
    ? WORKER_ACTION_POLICY[action] : null;
}

/** Keeps shared operations on the active GM while retaining intentional direct-GM paths and the no-active-GM fallback. */
export function canExecuteWorkerLocally(action, user, activeGM) {
  const policy = getWorkerActionPolicy(action);
  return Boolean(user?.isGM && (policy?.authority !== "active-gm" || !activeGM || activeGM.id === user.id));
}
