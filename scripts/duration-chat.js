function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Record a formula duration for GMs without revealing it to players.
 * Formula durations have already been evaluated exactly once by the caller.
 */
export async function postFormulaDurationToGMs({ zoneName, duration, actor = null, token = null } = {}) {
  const formula = String(duration?.formula ?? "").trim();
  const rounds = Number(duration?.rounds);
  if (!formula || !Number.isSafeInteger(rounds) || rounds < 1) return null;

  const Chat = globalThis.ChatMessage;
  if (typeof Chat?.create !== "function" || typeof Chat.getWhisperRecipients !== "function") return null;

  try {
    const whisper = Array.from(Chat.getWhisperRecipients("GM") ?? [])
      .map((user) => user?.id)
      .filter(Boolean);
    if (!whisper.length) return null;

    const roundLabel = rounds === 1 ? "round" : "rounds";
    return await Chat.create({
      speaker: Chat.getSpeaker?.({ actor, token }) ?? {},
      whisper,
      content: `<p><strong>PF2e Zone Duration</strong>: ${escapeHtml(zoneName || "Unnamed Zone")} will last <strong>${rounds} ${roundLabel}</strong> (rolled ${escapeHtml(formula)}).</p>`
    });
  } catch (error) {
    console.error("PF2e Zone: could not post the GM duration message", error);
    return null;
  }
}