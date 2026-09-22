/** Keeps zone names and formulas from changing the structure of the duration announcement. */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Keeps a randomly determined zone lifetime visible to exactly the people allowed to see that zone. */
export async function postFormulaDurationMessage({ zoneName, duration, visibility, actor = null, token = null } = {}) {
  const formula = String(duration?.formula ?? "").trim();
  const rounds = Number(duration?.rounds);
  if (!formula || !Number.isSafeInteger(rounds) || rounds < 1) return null;

  const Chat = globalThis.ChatMessage;
  if (typeof Chat?.create !== "function") return null;

  try {
    const roundLabel = rounds === 1 ? "round" : "rounds";
    const message = {
      speaker: Chat.getSpeaker?.({ actor, token }) ?? {},
      content: `<p><strong>PF2e Zone Duration</strong>: ${escapeHtml(zoneName || "Unnamed Zone")} will last <strong>${rounds} ${roundLabel}</strong> (rolled ${escapeHtml(formula)}).</p>`
    };

    if (visibility === "gm") {
      if (typeof Chat.getWhisperRecipients !== "function") return null;
      const whisper = Array.from(Chat.getWhisperRecipients("GM") ?? [])
        .map((user) => user?.id)
        .filter(Boolean);
      if (!whisper.length) return null;
      message.whisper = whisper;
    }

    return await Chat.create(message);
  } catch (error) {
    console.error("PF2e Zone: could not post the duration message", error);
    return null;
  }
}