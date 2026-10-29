export const CLOCK_SETTING = "sessionClock";
export const CLOCK_CHANGED_HOOK = "pf2eZoneSessionClockChanged";
export const CLOCK_ACTIVITIES = ["Searching", "Exploring", "Healing", "Roleplaying", "Travel", "Rest", "Other"];

const MODULE_ID = "pf2e-zone-automation";

/** Validates the campaign's Day numbering and local clock without consulting a calendar. */
export function campaignTime(day, time) {
  if (day == null || String(day).trim() === "") throw new Error("Enter the campaign Day number.");

  const value = Number(day);

  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value * 86400))
    throw new Error("Campaign Day must be a whole number of zero or greater within the supported range.");
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error("Enter a campaign time of day in HH:mm format.");

  return { day: value, time };
}

/** Converts Day/time snapshots, including accumulated combat seconds, to a campaign offset. */
export function campaignSeconds(value) {
  const [hour, minute] = value.time.split(":").map(Number);

  return value.day * 86400 + hour * 3600 + minute * 60 + (value.second ?? 0);
}

/** Derives a display snapshot from elapsed world seconds using exactly twenty-four-hour days. */
export function campaignAt(anchor, worldTime) {
  const seconds = campaignSeconds(anchor) + worldTime - anchor.worldTime;

  if (!Number.isFinite(seconds) || Math.abs(seconds) > Number.MAX_SAFE_INTEGER)
    throw new Error("The campaign clock is outside the supported range.");

  const day = Math.floor(seconds / 86400);
  const within = seconds - day * 86400;
  const hour = Math.floor(within / 3600), minute = Math.floor(within % 3600 / 60);
  const second = within % 60;

  return { day, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, ...(second ? { second } : {}) };
}

/** Formats Day/time directly, retaining seconds instead of rounding combat to activity blocks. */
export function campaignLabel(value) {
  if (!value) return "Day/time not recorded";

  const [hour, minute] = value.time.split(":").map(Number);
  const second = value.second ? `:${String(Number(value.second.toFixed(3))).padStart(2, "0")}` : "";

  return `Day ${value.day}, ${hour % 12 || 12}:${String(minute).padStart(2, "0")}${second} ${hour >= 12 ? "PM" : "AM"}`;
}

/** Reads only a recognized persisted clock; unopened worlds remain uninitialized. */
export function sessionClockState() {
  const state = game.settings.get(MODULE_ID, CLOCK_SETTING);

  if (!state || !Object.keys(state).length) return null;
  if (state.schemaVersion !== 1 || !state.anchor || !Number.isFinite(state.anchor.worldTime)
    || !Array.isArray(state.events) || !state.completed) throw new Error("The saved campaign clock needs migration or repair; its data has been preserved.");

  return state;
}

/** Uses the shared anchor during play while keeping ended sessions' snapshots historical. */
export function currentCampaign(data = null) {
  if (data?.state === "ended") return data.endCampaign ?? data.campaign;

  const state = sessionClockState();

  return state && Number.isFinite(game.time?.worldTime) ? campaignAt(state.anchor, game.time.worldTime) : data?.campaign ?? null;
}

/** Presents elapsed seconds without interpreting a label as a completed PF2e activity. */
export function durationLabel(seconds) {
  const sign = seconds < 0 ? "−" : "";
  let remaining = Math.abs(seconds);
  const parts = [];

  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]]) {
    const count = Math.floor(remaining / size);

    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);

    remaining %= size;
  }

  if (remaining || !parts.length) parts.push(`${Number(remaining.toFixed(3))} second${remaining === 1 ? "" : "s"}`);

  return sign + parts.join(" ");
}

/** Previews one shared interval, including custom durations or an explicit future Day/time target. */
export function previewAdvance(state, worldTime, request) {
  if (!state) throw new Error("Set the campaign Day/time before advancing time.");

  let seconds = Number(request.seconds);

  if (request.mode === "until")
    seconds = campaignSeconds(campaignTime(request.day, request.time)) - campaignSeconds(campaignAt(state.anchor, worldTime));
  if (!Number.isFinite(seconds) || seconds <= 0 || worldTime + seconds <= worldTime || seconds > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(Math.trunc(worldTime + seconds))) {
    throw new Error("Enter a positive duration or a future Day/time. Use Set Day/Time for corrections.");
  }

  return {
    seconds,
    worldStart: worldTime,
    worldEnd: worldTime + seconds,
    start: campaignAt(state.anchor, worldTime),
    end: campaignAt(state.anchor, worldTime + seconds)
  };
}
