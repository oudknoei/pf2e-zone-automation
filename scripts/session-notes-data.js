import { escapeHtml, readDocumentFlag } from "./utils.js";

export const SESSION_MODULE = "pf2e-zone-automation";
export const SESSION_FLAG = "sessionNotes";
export const SESSION_ENABLED_SETTING = "sessionNotesEnabled";
export const SESSION_ENABLED_HOOK = "pf2eZoneSessionNotesEnabled";
export const NOTE_TYPES = ["Note", "Discovery", "Decision", "NPC", "Objective", "Memorable Moment"];

/** Rejects direct player access as well as hidden or disabled dialog controls. */
export function requireSessionGM() {
  if (!game.user?.isGM) throw new Error("Only a GM can manage Session Notes.");
}

/** Defaults the entire feature off, including before its world setting is available. */
export function sessionNotesEnabled() {
  try { return game.settings?.get?.(SESSION_MODULE, SESSION_ENABLED_SETTING) === true; }
  catch { return false; }
}

/** Gates runtime entry points while leaving module configuration and saved Journals intact. */
export function requireSessionNotes() {
  requireSessionGM();
  if (!sessionNotesEnabled()) throw new Error("Enable Session Notes in Configure Settings → PF2e Zone Automation first.");
}

/** Reads versioned session metadata without depending on document names. */
export function sessionData(journal) {
  const data = readDocumentFlag(journal, SESSION_MODULE, SESSION_FLAG);
  return data?.schemaVersion === 1 && data.kind === "session" ? data : null;
}

/** Lists sessions in creation order, leaving manually edited page content untouched. */
export function sessionJournals() {
  requireSessionNotes();
  return [...(game.journal?.contents ?? game.journal?.values?.() ?? [])]
    .filter(journal => sessionData(journal))
    .sort((a, b) => sessionData(a).generation - sessionData(b).generation);
}

/** Keeps campaign Day/time manual in F1 and validates it before persisting a snapshot. */
export function campaignTime(day, time) {
  if (day == null || String(day).trim() === "") throw new Error("Enter the campaign Day number.");
  const value = Number(day);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Campaign Day must be a whole number of zero or greater.");
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Enter a campaign time of day in HH:mm format.");
  }
  return { day: value, time };
}

/** Formats campaign snapshots without a calendar date or local timezone conversion. */
export function campaignLabel(value) {
  if (!value) return "Day/time not recorded";
  const [hour, minute] = value.time.split(":").map(Number);
  return `Day ${value.day}, ${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

/** Preserves line breaks while storing user text as literal, editable Journal HTML. */
export function noteHtml(text) {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;
}

/** Generates Foundry-valid deterministic IDs so late retries cannot create extra documents. */
export async function sessionDocumentId(...parts) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify([SESSION_MODULE, ...parts]))));
  return digest.slice(0, 10).reduce((value, byte) => (value << 8n) + BigInt(byte), 0n)
    .toString(36).padStart(16, "0");
}

/** Copies only the selection and displayed context needed to describe a manual note. */
export function noteContext() {
  const view = globalThis.canvas;
  return {
    location: view?.scene?.name ?? "",
    sceneUuid: view?.scene?.uuid ?? null,
    worldTime: Number.isFinite(game.time?.worldTime) ? game.time.worldTime : null,
    tokens: (view?.tokens?.controlled ?? []).filter(token => token.actor).map(token => ({
      tokenUuid: token.document?.uuid ?? null, actorUuid: token.actor.uuid ?? null,
      name: String(token.actor.name ?? "")
    }))
  };
}

/** Uses screen-space token bounds so panning and zooming restrict the list to the current viewport. */
export function visibleNoteActors(view = globalThis.canvas) {
  if (!view?.ready || !view.scene || !view.app?.renderer) return [];
  const screen = view.app.renderer.screen;
  if (!screen) return [];
  const rows = new Map();
  for (const token of view.tokens?.placeables ?? []) {
    if (!token.actor || !token.isVisible || token.visible === false || token.isPreview) continue;
    if (token.document?.hidden && !game.user?.isGM) continue;
    const bounds = token.getBounds?.();
    if (!bounds || bounds.x + bounds.width <= screen.x || bounds.y + bounds.height <= screen.y
      || bounds.x >= screen.x + screen.width || bounds.y >= screen.y + screen.height) continue;
    const actor = token.actor;
    const key = token.document?.actorLink ? actor.uuid ?? actor.id : token.document?.uuid ?? token.id;
    if (!key || rows.has(key)) continue;
    rows.set(key, { key, name: String(actor.name ?? token.name ?? "Unnamed Actor"),
      qualifier: String(token.name ?? ""), image: actor.img || token.document?.texture?.src || "icons/svg/mystery-man.svg" });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Appends at the end without replacing a selected passage or discarding paragraph breaks. */
export function appendActorName(textarea, name) {
  textarea.value += `${textarea.value && !/\s$/.test(textarea.value) ? " " : ""}${name} `;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Converts saved Journal HTML to readable text, including native paragraph and table edits. */
export function journalPageText(page) {
  const content = page.text?.content ?? "";
  if (page.text?.format === 2) return content;
  const root = document.createElement("div");
  root.innerHTML = content;
  for (const node of root.querySelectorAll("script, style")) node.remove();
  for (const node of root.querySelectorAll("br")) node.replaceWith("\n");
  for (const node of root.querySelectorAll("p, div, h1, h2, h3, h4, li, tr")) node.append("\n");
  for (const node of root.querySelectorAll("td, th")) node.append("\t");
  return root.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

/** Exports current page text rather than stale automatic payloads or the finished recap itself. */
export function sessionNotesPackage(journal, prompt) {
  requireSessionNotes();
  if (!sessionData(journal)) throw new Error("The Session Notes Journal was not found.");
  const pages = [...journal.pages].filter(page =>
    readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG)?.role !== "recap")
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const sections = [];
  for (const page of pages) {
    const metadata = readDocumentFlag(page, SESSION_MODULE, SESSION_FLAG);
    if (metadata?.excluded) continue;
    const text = journalPageText(page);
    if (!text) continue;
    const context = metadata?.role === "event" ? [metadata.important ? "Important" : "", metadata.location,
      metadata.author?.name ? `Noted by ${metadata.author.name}` : "", metadata.related ? `Related: ${metadata.related}` : ""]
      .filter(Boolean).join(" · ") : "";
    sections.push(`## ${page.name}${metadata?.campaign ? `\n${campaignLabel(metadata.campaign)}` : ""}${context ? `\n${context}` : ""}\n\n${text}`);
  }
  const data = sessionData(journal);
  return `${prompt.trim()}\n\n---\nAudience: GM. This package may contain secrets. Review before sharing.\nSession: ${journal.name}
State: ${data.state}
Campaign start: ${campaignLabel(data.startCampaign)}
Campaign ${data.endCampaign ? "end" : "current"}: ${campaignLabel(data.endCampaign ?? data.campaign)}
Real start: ${new Date(data.startedAt).toISOString()}${data.endedAt ? `\nReal end: ${new Date(data.endedAt).toISOString()}` : ""}
Party: ${data.party.map(actor => actor.name).join(", ") || "Not specified"}\n\n${sections.join("\n\n")}`;
}
