import { actorLoreSkills } from "./recall-knowledge-rules.js";
import { requestGMWorker } from "./transport.js";
import { escapeHtml, newOperationId, readDocumentFlag } from "./utils.js";
import { QUESTION_MESSAGE_FLAG, QUESTION_MODULE_ID, isKnowledgeActiveGM, knowledgeAnswerText, privateKnowledgeQuestion } from "./recall-knowledge-message.js";
import { hasKnowledgeApiKey, knowledgeLocalAIStatus, queueKnowledgeAnswer } from "./recall-knowledge-ai.js";
import { openKnowledgeAIConnection } from "./recall-knowledge-settings.js";

let questionDialog = null;
let chatHook = null;
const wiredCopyButtons = new WeakSet();

/** Sends only the player's question and token identities; the GM resolves skills, dice, and creature data. */
export async function requestAskQuestion(sourceTokenUuid, targetTokenUuid, question, { loreSlug = null, operationId = newOperationId() } = {}) {
  const response = await requestGMWorker({
    protocol: 1, action: "ask-question", requesterUserId: game.user.id,
    sourceTokenUuid, targetTokenUuid, question, loreSlug, operationId
  });
  if (!response?.ok) {
    const error = new Error(response?.error ?? "The question could not be sent to the GM.");
    error.code = response?.errorCode;
    error.retryable = Boolean(response?.retryable);
    throw error;
  }
  return response;
}

/** Requires an owned selection and one target before showing Lore from the selected character. */
export async function openAskQuestion() {
  if (game.system.id !== "pf2e") return null;
  if (questionDialog?.rendered) {
    questionDialog.bringToFront();
    return questionDialog;
  }
  const targets = [...(game.user.targets ?? [])];
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  if (targets.length !== 1 || !targets[0].actor) {
    ui.notifications.warn("Target exactly one creature first.");
    return null;
  }
  if (controlled.length !== 1 || !controlled[0].actor) {
    ui.notifications.warn("Select exactly one character token.");
    return null;
  }
  const source = controlled[0];
  const target = targets[0];
  if (!game.user.isGM && !source.actor.isOwner) {
    ui.notifications.warn("You must own the selected character.");
    return null;
  }
  if (!game.user.isGM && !game.users.activeGM) {
    ui.notifications.warn("An active GM must be logged in to answer a question.");
    return null;
  }
  const loreSkills = actorLoreSkills(source.actor);
  const content = document.createElement("div");
  content.innerHTML = `<div class="pza-knowledge-dialog">
    <p><strong>${escapeHtml(source.name)}</strong>, what would you like to know about <strong>${escapeHtml(target.name)}</strong></p>
    <label><textarea name="knowledge-question" aria-label="Question" rows="3" maxlength="2000" required></textarea></label>
    <label>Applicable Lore<select name="knowledge-lore"><option value="">None</option>${loreSkills.map((skill) =>
      `<option value="${escapeHtml(skill.slug)}">${escapeHtml(skill.label)} (${skill.modifier >= 0 ? "+" : ""}${skill.modifier})</option>`).join("")}</select></label>
    <p class="hint">Choose a Lore only if it applies to your question</p>
    <p data-pza-question-status aria-live="polite"></p>
  </div>`;
  let sending = false;
  let attempt = null;
  const dialog = new foundry.applications.api.DialogV2({
    window: { title: "Ask a question about ..." }, position: { width: 480 },
    content, form: { closeOnSubmit: false },
    buttons: [
      {
        action: "ask", label: "Ask", default: true,
        callback: async (_event, button) => {
          if (sending) return;
          const form = button.form;
          const questionInput = form.querySelector('[name="knowledge-question"]');
          const loreInput = form.querySelector('[name="knowledge-lore"]');
          const question = questionInput.value.trim();
          if (!question) {
            ui.notifications.warn("Enter a question.");
            questionInput.focus();
            return;
          }
          const details = { question, loreSlug: loreInput.value || null };
          if (attempt && (attempt.question !== details.question || attempt.loreSlug !== details.loreSlug)) {
            ui.notifications.warn("Retry the pending question before changing it; the GM may still be resolving it.");
            return;
          }
          attempt ??= { ...details, operationId: newOperationId() };
          sending = true;
          for (const input of form.querySelectorAll("button, textarea, select")) input.disabled = true;
          const status = form.querySelector("[data-pza-question-status]");
          status.textContent = "Sending to the GM…";
          try {
            const response = await requestAskQuestion(source.document.uuid, target.document.uuid, attempt.question, attempt);
            await dialog.close();
            ui.notifications.info("Question sent privately to the GM.");
            return response;
          } catch (error) {
            if (error?.code !== "PF2E_ZONE_REQUEST_TIMEOUT" && !error?.retryable) attempt = null;
            status.textContent = error?.message ?? "The question could not be sent. Try again.";
            ui.notifications.error(status.textContent);
          } finally {
            sending = false;
            for (const input of form.querySelectorAll("button, textarea, select")) input.disabled = false;
            // A timed-out request may still finish. Preserve its exact question and operation ID for retry.
            questionInput.disabled = Boolean(attempt);
            loreInput.disabled = Boolean(attempt);
          }
        }
      },
      { action: "cancel", label: "Cancel", callback: () => dialog.close() }
    ]
  });
  dialog.addEventListener("close", () => {
    if (questionDialog === dialog) questionDialog = null;
  }, { once: true });
  questionDialog = dialog;
  await dialog.render({ force: true });
  return dialog;
}

/** Keeps clipboard access limited to GMs who can see the private prompt. */
function canCopyQuestion(message) {
  return Boolean(privateKnowledgeQuestion(message));
}

/** Copies literal prompt or answer text, with a selectable fallback when clipboard permission is unavailable. */
async function copyKnowledgeText(text, element, label) {
  try {
    await navigator.clipboard.writeText(text);
    ui.notifications.info(`${label} copied.`);
  } catch (_error) {
    if (element.closest("details")) element.closest("details").open = true;
    // The answer fallback includes factual identification exactly as Copy answer would.
    element.textContent = text;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    ui.notifications.warn(`Clipboard access is unavailable. The ${label.toLowerCase()} is selected; use your usual Copy shortcut.`);
  }
}

/** Renders generated text only after Foundry enrichment, so it cannot create HTML, rolls, or UUID actions. */
function renderKnowledgeAI(message, html) {
  const marker = privateKnowledgeQuestion(message);
  let section = html.querySelector("[data-pza-knowledge-ai]");
  if (!section) {
    const card = html.querySelector(".pza-knowledge-card");
    if (!card) return;
    section = html.ownerDocument?.createElement("section") ?? html.createElement("section");
    section.dataset.pzaKnowledgeAi = "";
    card.append(section);
  }
  section.replaceChildren();
  if (!marker) return;
  const doc = section.ownerDocument;
  const ai = knowledgeLocalAIStatus(message.id) ?? marker.ai ?? { status: "needs-key" };
  const status = doc.createElement("p");
  status.setAttribute("aria-live", "polite");
  const pending = ["queued", "thinking"].includes(ai.status);
  status.textContent = ai.status === "complete" ? "Answer" : ai.status === "queued" ? "Queued…" : ai.status === "thinking" ? "Thinking…"
    : ai.error || (isKnowledgeActiveGM() && hasKnowledgeApiKey() ? "Ready to get an answer." : "Enter an API key to get an answer.");
  section.append(status);
  if (ai.status === "complete" && typeof ai.answer === "string") {
    const answer = doc.createElement("pre");
    answer.dataset.pzaKnowledgeAnswer = "";
    answer.textContent = ai.answer;
    section.append(answer);
    const copy = doc.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy answer";
    copy.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = privateKnowledgeQuestion(message);
      if (!current || copy.disabled) return;
      copy.disabled = true;
      try { await copyKnowledgeText(knowledgeAnswerText(current), answer, "Answer"); }
      finally { copy.disabled = false; }
    });
    section.append(copy);
    return;
  }
  if (!isKnowledgeActiveGM()) {
    const note = doc.createElement("p");
    note.textContent = "The active GM handles AI requests.";
    section.append(note);
    return;
  }
  for (const [action, label] of [["connection", "AI Connection"], ["answer", ["error", "interrupted", "delivery-error"].includes(ai.status) ? "Retry" : "Get answer"]]) {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.pzaKnowledgeAiAction = action;
    button.disabled = action === "answer" && pending;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled || !isKnowledgeActiveGM() || !privateKnowledgeQuestion(message)) return;
      button.disabled = true;
      try {
        if (action === "connection" || !hasKnowledgeApiKey()) await openKnowledgeAIConnection();
        else await queueKnowledgeAnswer(message.id);
      } catch (_error) { ui.notifications.warn("The AI action could not be completed. Check AI Connection or retry the private question."); }
      finally { button.disabled = action === "answer" && ["queued", "thinking"].includes(privateKnowledgeQuestion(message)?.ai?.status); }
    });
    section.append(button);
  }
}

/** Wires saved chat cards on every render and leaves the complete prompt selectable if copying fails. */
function renderQuestionChat(message, html) {
  const buttons = [...html.querySelectorAll("button[data-pza-copy-knowledge]")];
  if (!canCopyQuestion(message)) {
    for (const button of buttons) button.remove();
    html.querySelector("[data-pza-knowledge-ai]")?.replaceChildren();
    return;
  }
  // Restore literal text after Foundry enrichment so @UUID links and inline rolls remain intact in the copied data.
  const savedPrompt = readDocumentFlag(message, QUESTION_MODULE_ID, QUESTION_MESSAGE_FLAG)?.prompt;
  const promptText = html.querySelector("[data-pza-knowledge-prompt]");
  if (typeof savedPrompt === "string" && promptText) promptText.textContent = savedPrompt;
  renderKnowledgeAI(message, html);
  for (const button of buttons) {
    if (wiredCopyButtons.has(button)) continue;
    wiredCopyButtons.add(button);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled || !canCopyQuestion(message)) return;
      const prompt = html.querySelector("[data-pza-knowledge-prompt]");
      if (!prompt) return;
      button.disabled = true;
      try {
        await copyKnowledgeText(prompt.textContent, prompt, "Prompt");
      } finally {
        button.disabled = false;
      }
    });
  }
}

/** Registers early so the Copy button also works on chat history restored after a refresh. */
export function registerQuestionChat() {
  if (chatHook !== null) return;
  const hook = Hooks.on("renderChatMessageHTML", renderQuestionChat);
  chatHook = hook;
  return () => {
    Hooks.off("renderChatMessageHTML", hook);
    if (chatHook === hook) chatHook = null;
  };
}
