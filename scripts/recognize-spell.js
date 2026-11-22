import { escapeHtml, readDocumentFlag } from "./utils.js";

const MODULE_ID = "pf2e-zone-automation";
const ROLL_FLAG = "recognizeSpell";
const CRITICAL_SUCCESS_EFFECT = "Compendium.pf2e-zone-automation.zone-effects.Item.pzaRecognCrit001";
const TRADITION_SKILLS = ["arcana", "nature", "occultism", "religion"];
const PROFICIENCY_LABELS = ["Untrained", "Trained", "Expert", "Master", "Legendary"];
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

/** Calculates the DC for a spell's rank and rarity using the roll's proficiency variant. */
function spellRankDc(rank, rarity, pwol) {
  return SPELL_RANK_DCS[rank - 1] + RARITIES[rarity] - (pwol ? 2 * rank - 1 : 0);
}

/** Renders one DC per spell rank. */
function renderRankDcs(pwol, rarity) {
  return SPELL_RANK_DCS.map((_, index) => {
    const rank = index + 1;
    return `<li>Rank ${rank}: DC ${spellRankDc(rank, rarity, pwol)}</li>`;
  }).join("");
}

/** Updates the rarity on chat cards saved with the original results table. */
function renderRows({ die, checks, pwol }, rarity) {
  return SPELL_RANK_DCS.map((_, index) => {
    const rank = index + 1;
    const dc = spellRankDc(rank, rarity, pwol);
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
  const rankDcs = card?.querySelector(".pza-spell-rank-dcs");
  const results = rankDcs ?? card?.querySelector("tbody");
  if (!roll || !results || wiredCards.has(card)) return;

  wiredCards.add(card);
  const buttons = [...card.querySelectorAll("button[data-rarity]")];
  for (const button of buttons) {
    const rarity = button.dataset.rarity;
    if (!Object.hasOwn(RARITIES, rarity)) continue;

    button.addEventListener("click", () => {
      results.innerHTML = rankDcs ? renderRankDcs(roll.pwol, rarity) : renderRows(roll, rarity);
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
  if (controlled.length !== 1 || !["character", "npc"].includes(actor?.type)) {
    ui.notifications.warn("Select one PC or NPC token to roll Recognize Spell.");
    return;
  }

  const skills = TRADITION_SKILLS.map((slug) => {
    const skill = actor.skills[slug];
    // PF2e marks listed NPC skills as proficient and typically leaves their rank unset.
    const rank = skill?.rank ?? (actor.type === "npc" && skill?.proficient ? 1 : 0);
    return { skill, rank };
  }).filter(({ rank }) => rank > 0);
  if (!skills.length) {
    ui.notifications.warn(`${actor.name} has no trained skills for Recognize Spell.`);
    return;
  }

  const whisper = ChatMessage.getWhisperRecipients("GM").map((user) => user.id);
  if (!whisper.length) return;

  const rollOptions = { extraRollOptions: ["action:recognize-spell", "self:action:slug:recognize-spell", "secret"] };
  const die = (await new Roll("1d20").evaluate({ allowInteractive: false })).total;
  const checks = skills.map(({ skill, rank }) => ({
    label: skill.label,
    rank,
    autoRank: AUTO_RECOGNIZE_RANK[rank],
    total: die + skill.withRollOptions(rollOptions).check.mod
  }));

  const roll = { die, checks, pwol: game.pf2e.settings.variants.pwol.enabled };
  const totals = checks.map(({ label, rank, total }) =>
    `<li><strong>${escapeHtml(label)} (${PROFICIENCY_LABELS[rank]}):</strong> ${total}</li>`
  ).join("");
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
      <p><strong>${escapeHtml(actor.name)}</strong> rolled <strong>${die}</strong> on the secret d20.</p>
      <ul class="pza-spell-totals" aria-label="Skill totals">${totals}</ul>
      <div class="pza-spell-rarities" role="group" aria-label="Spell rarity">${buttons}</div>
      <ul class="pza-spell-rank-dcs" aria-label="Spell rank DCs">${renderRankDcs(roll.pwol, "Common")}</ul>
      <p><strong>Automatic Success (Common only)</strong> With the skill for the spell's tradition, you upgrade failure and critical failure to success through rank ${AUTO_RECOGNIZE_RANK[1]} if trained, ${AUTO_RECOGNIZE_RANK[2]} if expert, ${AUTO_RECOGNIZE_RANK[3]} if master, and ${AUTO_RECOGNIZE_RANK[4]} if legendary.</p>
      <p><strong>Critical Success</strong> You recognize the spell and gain a +1 circumstance bonus to AC or your saving throw against it: ${effectLink}.</p>
      <p><strong>Success</strong> You recognize the spell</p>
      <p><strong>Failure</strong> You fail to recognize the spell.</p>
      <p><strong>Critical Failure</strong> You misidentify the spell as another spell entirely (GM choice).</p>
    </section>`
  });
}
