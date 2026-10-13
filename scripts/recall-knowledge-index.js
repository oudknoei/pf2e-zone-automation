import { ANSWER_MESSAGE_FLAG, knowledgeAnswerMarker, privateKnowledgeQuestion,
  QUESTION_MESSAGE_FLAG, QUESTION_MODULE_ID } from "./recall-knowledge-message.js";
import { readDocumentFlag } from "./utils.js";

/** Indexes recovery candidates once, then maintains trusted pending questions and answer attempts incrementally. */
export class KnowledgeChatIndex {
  /** Performs one startup pass over the loaded messages, retaining only Recall Knowledge candidates. */
  constructor(messages) {
    this.messages = messages;
    this.candidates = new Map();
    this.pending = new Map();
    this.answerKeys = new Map();
    this.attempts = new Map();
    for (const message of messages?.contents ?? []) this.update(message);
  }

  /** Encodes all three attempt identities without ambiguous concatenation or delimiter collisions. */
  attemptKey(questionMessageId, operationId, attemptId) {
    return JSON.stringify([questionMessageId, operationId, attemptId]);
  }

  /** Removes previous keys before reclassifying a changed document, including flag and visibility changes. */
  update(message) {
    if (!message?.id) return false;
    const rawQuestion = readDocumentFlag(message, QUESTION_MODULE_ID, QUESTION_MESSAGE_FLAG);
    const rawAnswer = readDocumentFlag(message, QUESTION_MODULE_ID, ANSWER_MESSAGE_FLAG);
    const answer = rawAnswer ? knowledgeAnswerMarker(message) : null;
    const key = answer ? this.attemptKey(answer.questionMessageId, answer.operationId, answer.attemptId) : null;
    // Preserve recovery order when only the text or visibility of a matching answer changes.
    const removed = this.remove(message.id, key);
    if (!rawQuestion && !rawAnswer) return removed;
    this.candidates.set(message.id, message);
    const question = privateKnowledgeQuestion(message);
    if (question && ["queued", "thinking"].includes(question.ai?.status)) this.pending.set(message.id, message);
    if (answer) {
      if (!this.attempts.has(key)) this.attempts.set(key, new Set());
      this.attempts.get(key).add(message.id);
      this.answerKeys.set(message.id, key);
    }
    return true;
  }

  /** Deletes cached references, retaining an unchanged answer key only during document reclassification. */
  remove(messageId, keepAnswerKey = null) {
    const key = this.answerKeys.get(messageId);
    if (key && key !== keepAnswerKey) {
      const ids = this.attempts.get(key);
      ids.delete(messageId);
      if (!ids.size) this.attempts.delete(key);
      this.answerKeys.delete(messageId);
    }
    this.pending.delete(messageId);
    return this.candidates.delete(messageId);
  }

  /** Uses Foundry's direct document lookup and supports source-shaped recovery fixtures without a Collection getter. */
  message(messageId) {
    return typeof this.messages?.get === "function" ? this.messages.get(messageId) : this.candidates.get(messageId);
  }

  /** Returns a still-authentic answer for exactly one attempt, preserving its private or public visibility. */
  answer(questionMessageId, operationId, attemptId) {
    const key = this.attemptKey(questionMessageId, operationId, attemptId);
    for (const id of [...(this.attempts.get(key) ?? [])]) {
      const message = this.message(id);
      const marker = knowledgeAnswerMarker(message);
      if (marker && this.attemptKey(marker.questionMessageId, marker.operationId, marker.attemptId) === key) return message;
      if (message) this.update(message);
      else this.remove(id);
    }
    return null;
  }

  /** Exposes only indexed in-progress cards for lifecycle recovery, with live trust checks left to the caller. */
  pendingQuestions() {
    return this.pending.values();
  }

  /** Rechecks only flagged candidates when a user role or recipient's GM status changes. */
  refreshTrust() {
    for (const id of [...this.candidates.keys()]) {
      const message = this.message(id);
      if (message) this.update(message);
      else this.remove(id);
    }
  }
}
