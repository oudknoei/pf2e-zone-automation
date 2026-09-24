import { normalizeDurationRounds } from "./duration.js";

/** Defaults absent legacy dimensions while preserving current empty or invalid fields for validation. */
export function editableZoneSize(value, fallback) {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text === "" ? "" : Number(text);
}

/** Defaults absent legacy durations while keeping an empty custom-duration field invalid. */
export function editableDurationRounds(value, fallback = 1) {
  if (value == null) return fallback;
  if (String(value).trim() === "") return "";
  return normalizeDurationRounds(value, fallback);
}
