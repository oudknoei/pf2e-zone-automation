import { escapeHtml, readDocumentFlag } from "./utils.js";

const MODULE_ID = "pf2e-zone-automation";
const ROLL_FLAG = "recognizeSpell";
const CRITICAL_SUCCESS_EFFECT = "Compendium.pf2e-zone-automation.zone-effects.Item.pzaRecognCrit001";
const TRADITION_SKILLS = ["arcana", "nature", "occultism", "religion"];
const SPELL_RANK_DCS = [15, 18, 20, 23, 26, 28, 31, 34, 36, 39];
const AUTO_RECOGNIZE_RANK = [0, 2, 4, 6, 10];
const OUTCOMES = ["Critical Failure", "Failure", "Success", "Critical Success"];
const RARITIES = { Common: 0, Uncommon: 2, Rare: 5 };
const wiredCards = new WeakSet();

/** Compares a check against one DC, shifting the outcome on a natural 1 or 20. */
function degreeOfSuccess(total, dc, die) {
  let degree = 1;
  if (total >= dc + 10) degree = 3;
  else if (total >= dc) degree = 2;
  else if (total <= dc - 10) degree = 0;

  if (die === 20) return Math.min(3, degree + 1);
  if (die === 1) return Math.max(0, degree - 1);
  return degree;
}

/** Renders each skill total using the outcome for the selected rarity and spell rank. */
function renderRows({ die, checks, pwol }, rarity) {
  return SPELL_RANK_DCS.map((baseDc, index) => {
    const rank = index + 1;
    const dc = baseDc + RARITIES[rarity] - (pwol ? 2 * rank - 1 : 0);
    const cells = checks.map(({ autoRank, total }) => {
      const degree = degreeOfSuccess(total, dc, die);
      const automatic = rarity === "Common" && rank <= autoRank && degree < 2;
      const outcome = automatic ? 2 : degree;
      const result = outcome < 2 ? "failure" : "success";
      const critical = outcome === 0 || outcome === 3 ? " pza-spell-critical" : "";
      const label = automatic ? "Automatic Success" : OUTCOMES[outcome];
      return `<td class="pza-spell-${result}${critical}" title="${label}" aria-label="${total}, ${label}">${total}</td>`;
    }).join("");
    return `<tr><th scope="row">${rank}</th><td>${dc}</td>${cells}</tr>`;
  }).join("");
}

/** Wires the rarity buttons to the saved roll whenever Foundry renders the GM's card. */
function renderRecognizeSpellChat(message, html) {
  if (!game.user.isGM) return;

  const roll = readDocumentFlag(message, MODULE_ID, ROLL_FLAG);
  const card = html.querySelector(".pza-recognize-spell");
  const tableBody = card?.querySelector("tbody");
  if (!roll || !tableBody || wiredCards.has(card)) return;

  wiredCards.add(card);
  const buttons = [...card.querySelectorAll("button[data-rarity]")];
  for (const button of buttons) {
    const rarity = button.dataset.rarity;
    if (!Object.hasOwn(RARITIES, rarity)) continue;

    button.addEventListener("click", () => {
      tableBody.innerHTML = renderRows(roll, rarity);
      for (const option of buttons) option.setAttribute("aria-pressed", String(option === button));
    });
  }
}

/** Registers the chat hook before Foundry renders new or saved Recognize Spell cards. */
export function registerRecognizeSpellChat() {
  Hooks.on("renderChatMessageHTML", renderRecognizeSpellChat);
}

/** Rolls one secret d20 and whispers the totals for every trained tradition skill to GMs. */
export async function recognizeSpell() {
  if (!game.user.isGM) {
    ui.notifications.warn("Recognize Spell is a GM-only macro.");
    return;
  }

  const controlled = canvas.tokens?.controlled ?? [];
  const token = controlled[0]?.document;
  const actor = token?.actor;
  if (controlled.length !== 1 || actor?.type !== "character") {
    ui.notifications.warn("Select one player character token to roll Recognize Spell.");
    return;
  }

  const skills = TRADITION_SKILLS.map((slug) => actor.getStatistic(slug))
    .filter((skill) => skill?.rank > 0);
  if (!skills.length) {
    ui.notifications.warn(`${actor.name} has no trained skills for Recognize Spell.`);
    return;
  }

  const whisper = ChatMessage.getWhisperRecipients("GM").map((user) => user.id);
  if (!whisper.length) return;

  const rollOptions = { extraRollOptions: ["action:recognize-spell", "self:action:slug:recognize-spell", "secret"] };
  const die = (await new Roll("1d20").evaluate({ allowInteractive: false })).total;
  const checks = skills.map((skill) => ({
    label: skill.label,
    autoRank: AUTO_RECOGNIZE_RANK[skill.rank],
    total: die + skill.withRollOptions(rollOptions).check.mod
  }));

  const roll = { die, checks, pwol: game.pf2e.settings.variants.pwol.enabled };
  const headings = checks.map(({ label }) => `<th scope="col">${escapeHtml(label)}</th>`).join("");
  const buttons = Object.keys(RARITIES).map((rarity) =>
    `<button type="button" data-rarity="${rarity}" aria-pressed="${rarity === "Common"}">${rarity}</button>`
  ).join("");
  const effectLink = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
    `@UUID[${CRITICAL_SUCCESS_EFFECT}]{Effect: Critical Success}`
  );

  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token }),
    whisper,
    flags: { [MODULE_ID]: { [ROLL_FLAG]: roll } },
    content: `<section class="pza-recognize-spell">
      <p><strong>${escapeHtml(actor.name)}</strong> rolled to recognize the spell. Use the results below to determine success.</p>
      <div class="pza-spell-rarities" role="group" aria-label="Spell rarity">${buttons}</div>
      <table aria-label="Recognize Spell results">
        <thead><tr><th scope="col">Rank</th><th scope="col">DC</th>${headings}</tr></thead>
        <tbody>${renderRows(roll, "Common")}</tbody>
      </table>
      <p><strong>Critical Success</strong> You recognize the spell and gain a +1 circumstance bonus to AC or your saving throw against it: ${effectLink}.</p>
      <p><strong>Success</strong> You recognize the spell</p>
      <p><strong>Failure</strong> You fail to recognize the spell.</p>
      <p><strong>Critical Failure</strong> You misidentify the spell as another spell entirely, of the GM’s choice.</p>
    </section>`
  });
}
