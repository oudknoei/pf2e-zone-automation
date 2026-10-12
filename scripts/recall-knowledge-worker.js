import { bestKnowledgeSkill, creatureKnowledgeDC, creatureTraits, creatureType, knowledgeDegree, traitLabel } from "./recall-knowledge-rules.js";
import { compactCreatureData } from "./recall-knowledge-data.js";
import { knowledgePromptInstructions } from "./recall-knowledge-prompt.js";
import { oncePerOperation } from "./request-cache.js";
import { escapeHtml, readDocumentFlag } from "./utils.js";

export const QUESTION_MODULE_ID = "pf2e-zone-automation";
export const QUESTION_MESSAGE_FLAG = "recallKnowledgeQuestion";
const preparedQuestions = new Map();
const deliveries = new Map();
const REQUEST_TTL_MS = 10 * 60 * 1000;

/** Rejects malformed or oversized input before a secret roll or document lookup starts. */
export function normalizeQuestionRequest(request) {
  const question = typeof request.question === "string" ? request.question.trim() : "";
  if (!question || question.length > 2000) throw new Error("Enter a question of no more than 2,000 characters.");
  if (typeof request.operationId !== "string" || !/^[a-zA-Z0-9_-]{12,64}$/.test(request.operationId)) {
    throw new Error("Question operation ID is invalid.");
  }
  if (request.loreSlug != null && (typeof request.loreSlug !== "string" || request.loreSlug.length > 200)) {
    throw new Error("The selected Lore skill is invalid.");
  }
  return {
    operationId: request.operationId, requesterUserId: request.requesterUserId,
    sourceTokenUuid: request.sourceTokenUuid, targetTokenUuid: request.targetTokenUuid,
    question, loreSlug: request.loreSlug || null
  };
}

/** Captures exactly the details a retry must retain to avoid rolling a different question under the same ID. */
function questionFingerprint(request) {
  const { sourceTokenUuid, targetTokenUuid, question, loreSlug } = request;
  return JSON.stringify({ sourceTokenUuid, targetTokenUuid, question, loreSlug });
}

/** Finds durable chat markers so a successful submission cannot roll again after a GM refresh. */
function completedQuestion(request) {
  for (const message of game.messages?.contents ?? []) {
    const marker = readDocumentFlag(message, QUESTION_MODULE_ID, QUESTION_MESSAGE_FLAG);
    if (marker?.operationId !== request.operationId || marker?.requesterUserId !== request.requesterUserId) continue;
    if (marker.fingerprint !== questionFingerprint(request)) {
      throw new Error("Question operation ID was reused with different details.");
    }
    return { action: "ask-question", messageId: message.id };
  }
  return null;
}

/** Resolves synthetic Token Actors on the GM client, where the complete creature data is available. */
async function questionToken(uuid, label) {
  if (typeof uuid !== "string" || !uuid.startsWith("Scene.") || uuid.length > 200) {
    throw new Error(`${label} must be a Scene token.`);
  }
  const token = await fromUuid(uuid);
  if (token?.documentName !== "Token" || !["character", "npc", "familiar"].includes(token.actor?.type)) {
    throw new Error(`${label} must be a token with a creature Actor.`);
  }
  return token;
}

/** Builds a portable prompt whose answer instructions stay separate from untrusted question and creature text. */
export function buildKnowledgePrompt({ request, requester, source, creature, skill, dc, natural, total, degree }) {
  const traits = creatureTraits(creature).map(traitLabel).join(", ") || "None listed";
  const type = creatureType(creature);
  const data = compactCreatureData(creature.toObject(), creature.toObject(false).system);
  return [
    knowledgePromptInstructions(),
    "",
    `PLAYER: ${JSON.stringify(requester.name)}`,
    `CHARACTER: ${JSON.stringify(source.name)}`,
    `QUESTION: ${JSON.stringify(request.question)}`,
    `RESULT: ${degree}`,
    `SKILL USED: ${skill.label}${skill.dcAdjustment ? ` (Lore DC ${skill.dcAdjustment}: ${skill.dcAdjustment === -5 ? "creature trait match" : "no creature trait match"})` : ""}`,
    `ROLL: d20 ${natural} + modifier ${skill.modifier} = ${total}; DC ${dc}`,
    `LORE SELECTED AS APPLICABLE: ${request.loreSlug ?? "None"}`,
    `CREATURE NAME (GM REFERENCE): ${JSON.stringify(creature.name)}`,
    `CREATURE TYPE (ALWAYS REVEAL): ${type}`,
    `CREATURE TRAITS (ALWAYS REVEAL): ${traits}`,
    "",
    "CREATURE DATA (GM REFERENCE; all embedded items and factual system data; internal bookkeeping and empty fields omitted):",
    JSON.stringify(data, null, 2)
  ].join("\n");
}

/** Rolls once and retains the prepared GM card if chat delivery needs a retry. */
async function prepareQuestion(request, requester, sourceToken, targetToken) {
  const source = sourceToken.actor;
  const creature = targetToken.actor;
  const skill = bestKnowledgeSkill(source, creature, request.loreSlug);
  const dc = creatureKnowledgeDC(creature) + (skill.dcAdjustment ?? 0);
  const roll = await new Roll("1d20 + @modifier", { modifier: skill.modifier }).evaluate();
  const natural = roll.dice?.[0]?.results?.find((result) => result.active !== false)?.result;
  if (!Number.isInteger(natural) || natural < 1 || natural > 20 || !Number.isFinite(roll.total)) {
    throw new Error("The Recall Knowledge die roll could not be read.");
  }
  const degree = knowledgeDegree(roll.total, dc, natural);
  const prompt = buildKnowledgePrompt({ request, requester, source, creature, skill, dc, natural, total: roll.total, degree });
  const traits = creatureTraits(creature).map(traitLabel).join(", ") || "None listed";
  return {
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor: source, token: sourceToken }),
    blind: true,
    rolls: [roll],
    content: `<div class="pza-knowledge-card">
      <h3>Ask a question about ...</h3>
      <p><strong>${escapeHtml(source.name)}</strong> asks about <strong>${escapeHtml(creature.name)}</strong>:</p>
      <p>${escapeHtml(request.question)}</p>
      <p><strong>${degree}</strong> · ${escapeHtml(skill.label)}${skill.dcAdjustment ? ` (Lore DC ${skill.dcAdjustment})` : ""} · ${roll.total} vs. DC ${dc}</p>
      <p><strong>Type:</strong> ${escapeHtml(creatureType(creature))}<br><strong>Traits:</strong> ${escapeHtml(traits)}</p>
      <button type="button" data-pza-copy-knowledge>Copy</button>
      <details><summary>LLM prompt and full creature data</summary><pre data-pza-knowledge-prompt>${escapeHtml(prompt)}</pre></details>
    </div>`,
    flags: {
      [QUESTION_MODULE_ID]: {
        [QUESTION_MESSAGE_FLAG]: {
          operationId: request.operationId, requesterUserId: request.requesterUserId,
          fingerprint: questionFingerprint(request), prompt
        }
      }
    }
  };
}

/** Authorizes a question and posts its secret result only to GMs without returning creature data to the requester. */
export async function executeAskQuestion(rawRequest) {
  if (!game.user?.isGM) throw new Error("Recall Knowledge questions must be resolved by a GM.");
  const request = normalizeQuestionRequest(rawRequest);
  const requester = game.users.get(request.requesterUserId);
  if (!requester?.active) throw new Error("The requesting user is no longer active.");
  const [sourceToken, targetToken] = await Promise.all([
    questionToken(request.sourceTokenUuid, "The selected character"),
    questionToken(request.targetTokenUuid, "The targeted creature")
  ]);
  if (!requester.isGM && !sourceToken.actor.testUserPermission(requester, "OWNER")) {
    throw new Error("You must own the selected character.");
  }
  if (sourceToken.parent?.id !== targetToken.parent?.id) throw new Error("The character and creature must be on the same Scene.");
  if (!requester.isGM && targetToken.hidden) throw new Error("The targeted creature is hidden.");
  const completed = completedQuestion(request);
  if (completed) return completed;
  const key = `${request.requesterUserId}:${request.operationId}`;
  const options = {
    key, fingerprint: questionFingerprint(request), ttlMs: REQUEST_TTL_MS,
    reuseError: "Question operation ID was reused with different details."
  };
  return oncePerOperation(deliveries, options, async () => {
    const whisper = [...game.users].filter((user) => user.isGM).map((user) => user.id);
    if (!whisper.length) throw new Error("No GM recipients are available.");
    const chatData = await oncePerOperation(preparedQuestions, options,
      () => prepareQuestion(request, requester, sourceToken, targetToken));
    const existing = completedQuestion(request);
    if (existing) return existing;
    try {
      const message = await ChatMessage.create({ ...chatData, whisper });
      if (!message) throw new Error("The GM prompt could not be posted. Retry the same question.");
      return { action: "ask-question", messageId: message.id };
    } catch (error) {
      const completed = completedQuestion(request);
      if (completed) return completed;
      error.retryable = true;
      throw error;
    }
  });
}
