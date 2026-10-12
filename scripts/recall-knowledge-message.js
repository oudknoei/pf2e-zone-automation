import { readDocumentFlag } from "./utils.js";

export const QUESTION_MODULE_ID = "pf2e-zone-automation";
export const QUESTION_MESSAGE_FLAG = "recallKnowledgeQuestion";

/** Identifies the single GM allowed to submit paid AI requests in this browser. */
export function isKnowledgeActiveGM() {
  return Boolean(game.user?.isGM && game.users?.activeGM?.id === game.user.id);
}

/** Accepts only authentic, blind question cards whose author and all recipients are GMs. */
export function privateKnowledgeQuestion(message) {
  if (!game.user?.isGM || !message?.blind || !message.whisper?.includes(game.user.id)) return null;
  const authorId = typeof message.user === "string" ? message.user : message.user?.id;
  if (!game.users?.get(authorId)?.isGM || !message.whisper.every((id) => game.users.get(id)?.isGM)) return null;
  const marker = readDocumentFlag(message, QUESTION_MODULE_ID, QUESTION_MESSAGE_FLAG);
  return typeof marker?.prompt === "string" && typeof marker.operationId === "string"
    && typeof marker.requesterUserId === "string" && typeof marker.fingerprint === "string" ? marker : null;
}

/** Includes factual identification independently of the model's prose when copying an answer. */
export function knowledgeAnswerText(marker) {
  const type = marker.creatureType ?? marker.prompt?.match(/^CREATURE TYPE \(ALWAYS REVEAL\): (.*)$/m)?.[1];
  const traits = marker.creatureTraits ?? marker.prompt?.match(/^CREATURE TRAITS \(ALWAYS REVEAL\): (.*)$/m)?.[1];
  const facts = type && traits ? `Type: ${type}\nTraits: ${traits}\n\n` : "";
  return `${facts}${marker.ai?.answer ?? ""}`;
}
