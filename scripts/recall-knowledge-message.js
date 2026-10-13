import { isGMAuthoredMessage, readDocumentFlag } from "./utils.js";

export const QUESTION_MODULE_ID = "pf2e-zone-automation";
export const QUESTION_MESSAGE_FLAG = "recallKnowledgeQuestion";
export const ANSWER_MESSAGE_FLAG = "recallKnowledgeAnswer";

/** Identifies the single GM allowed to submit paid AI requests in this browser. */
export function isKnowledgeActiveGM() {
  return Boolean(game.user?.isGM && game.users?.activeGM?.id === game.user.id);
}

/** Accepts only authentic, blind question cards whose author and all recipients are GMs. */
export function privateKnowledgeQuestion(message) {
  if (!game.user?.isGM || message?.blind !== true || !Array.isArray(message.whisper)) return null;
  const recipients = message.whisper.map((recipient) => typeof recipient === "string" ? recipient : recipient?.id);
  if (!recipients.includes(game.user.id) || !recipients.every((id) => typeof id === "string" && game.users.get(id)?.isGM)) return null;
  if (!isGMAuthoredMessage(message)) return null;
  const marker = readDocumentFlag(message, QUESTION_MODULE_ID, QUESTION_MESSAGE_FLAG);
  return ["prompt", "operationId", "requesterUserId", "fingerprint"]
    .every((field) => typeof marker?.[field] === "string" && marker[field].trim()) ? marker : null;
}

/** Recognizes answer-only messages even after the GM changes their visibility to public. */
export function knowledgeAnswerMarker(message) {
  if (!isGMAuthoredMessage(message)) return null;
  const marker = readDocumentFlag(message, QUESTION_MODULE_ID, ANSWER_MESSAGE_FLAG);
  return typeof marker?.text === "string" && typeof marker.questionMessageId === "string"
    && typeof marker.operationId === "string" && typeof marker.attemptId === "string" ? marker : null;
}

/** Removes presentation markup while retaining prose, paragraphs, numbers, and literal Foundry commands. */
export function plainKnowledgeAnswer(value) {
  return value.replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, "")
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/^\s{0,3}#{1,6}\s+|\s+#+\s*$/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*•]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*[-*_](?:\s*[-*_]){2,}\s*$/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(?<!\w)(\*|_)(?=\S)([^\n]*?\S)\1(?!\w)/g, "$2")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_match, row) => row.trim().replace(/\s*\|\s*/g, "; "))
    .replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Includes factual identification independently of the model's prose when copying an answer. */
export function knowledgeAnswerText(marker) {
  const type = marker.creatureType ?? marker.prompt?.match(/^CREATURE TYPE \(ALWAYS REVEAL\): (.*)$/m)?.[1];
  const traits = marker.creatureTraits ?? marker.prompt?.match(/^CREATURE TRAITS \(ALWAYS REVEAL\): (.*)$/m)?.[1];
  const facts = type && traits ? `Type: ${type}\nTraits: ${traits}\n\n` : "";
  return `${facts}${plainKnowledgeAnswer(marker.ai?.answer ?? "")}`;
}
