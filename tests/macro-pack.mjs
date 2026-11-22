import assert from "node:assert/strict";
import { cpSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { compiledPackRecords } from "./compiled-pack-records.mjs";
import { recognizeSpell, registerRecognizeSpellChat } from "../scripts/recognize-spell.js";

const root = resolve(import.meta.dirname, "..");
const expectedMacros = new Map([
  [
    "pzaOpenBuilder01",
    {
      name: "Open PF2e Zone Builder",
      image: "modules/pf2e-zone-automation/assets/macros/pf2e-zone-builder.webp",
      api: "openBuilder"
    }
  ],
  [
    "pzaShieldTaunt01",
    {
      name: "Shielding Taunt",
      image: "modules/pf2e-zone-automation/assets/macros/shielding-taunt.webp",
      api: "openShieldingTaunt"
    }
  ],
  [
    "pzaHeroPoints001",
    {
      name: "Set Hero Points",
      image: "modules/pf2e-zone-automation/assets/macros/SetHeroPoints.webp",
      api: "promptSetHeroPoints"
    }
  ],
  ["pzaSessionNote01", {
    name: "Session Notes",
    image: "icons/svg/book.svg",
    api: "openSessionNotes",
    ownership: 0
  }],
  ["pzaQuickNote0001", {
    name: "Quick Note",
    image: "icons/svg/scroll.svg",
    api: "openQuickNote",
    ownership: 0
  }],
  ["pzaAdvanceTime01", {
    name: "Advance Time",
    image: "icons/svg/clockwork.svg",
    api: "promptAdvanceSessionTime",
    ownership: 0
  }],
  ["pzaRecognSpell01", {
    name: "Recognize Spell",
    image: "modules/pf2e-zone-automation/assets/macros/recognize-spell.webp",
    api: "recognizeSpell",
    ownership: 0
  }]
]);

test("Recognize Spell handles PC and NPC skills and changes rarity without rolling again", async () => {
  const statistics = {
    arcana: { label: "Arcana", rank: 1, withRollOptions: () => ({ check: { mod: 14 } }) },
    nature: { label: "Nature", rank: 3, withRollOptions: () => ({ check: { mod: 27 } }) },
    occultism: { label: "Occultism", rank: 0 },
    religion: { label: "Religion", rank: 1, withRollOptions: () => ({ check: { mod: -3 } }) }
  };
  const actor = { type: "character", name: "Celina", skills: statistics };
  let rolls = 0;
  let renderChat;
  globalThis.Hooks = {
    on(event, callback) {
      assert.equal(event, "renderChatMessageHTML");
      renderChat = callback;
    }
  };
  globalThis.game = { user: { isGM: true }, pf2e: { settings: { variants: { pwol: { enabled: false } } } } };
  globalThis.canvas = { tokens: { controlled: [{ document: { actor } }] } };
  globalThis.Roll = class {
    constructor(formula) {
      assert.equal(formula, "1d20");
    }

    async evaluate() {
      rolls += 1;
      return { total: 11 };
    }
  };
  globalThis.ChatMessage = {
    getWhisperRecipients: () => [{ id: "gm" }],
    getSpeaker: () => ({}),
    create: async (data) => data
  };
  const effectUuid = "Compendium.pf2e-zone-automation.zone-effects.Item.pzaRecognCrit001";
  const effectLabel = "Effect: Critical Success";
  globalThis.foundry = { applications: { ux: { TextEditor: { implementation: {
    async enrichHTML(text) {
      assert.equal(text, `@UUID[${effectUuid}]{${effectLabel}}`);
      return `<a class="content-link" draggable="true" data-uuid="${effectUuid}">${effectLabel}</a>`;
    }
  } } } } };

  registerRecognizeSpellChat();
  const message = await recognizeSpell();
  assert.deepEqual(message.whisper, ["gm"]);

  const { document } = new JSDOM(message.content).window;
  const effectLink = document.querySelector("a.content-link[draggable='true']");
  assert.equal(effectLink.dataset.uuid, effectUuid);
  assert.equal(effectLink.textContent, effectLabel);
  assert.match(document.body.textContent, /\+1 circumstance bonus to AC or your saving throw/);
  assert.match(document.body.textContent, /Automatic Success \(Common only\).*rank 2 if trained, 4 if expert, 6 if master, and 10 if legendary/);
  assert.match(document.body.textContent, /upgrade failure and critical failure to success/);
  assert.equal(document.querySelector("table"), null);
  const [common, uncommon, rare] = document.querySelectorAll("button");
  const totals = document.querySelector(".pza-spell-totals");
  const dcs = document.querySelector(".pza-spell-rank-dcs");
  const skillTotals = ["Arcana (Trained): 25", "Nature (Master): 38", "Religion (Trained): 8"];
  assert.deepEqual([...totals.children].map((line) => line.textContent), skillTotals);
  const commonDcs = [15, 18, 20, 23, 26, 28, 31, 34, 36, 39];
  const assertDcs = (adjustment) => {
    assert.deepEqual([...dcs.children].map((line) => line.textContent),
      commonDcs.map((dc, index) => `Rank ${index + 1}: DC ${dc + adjustment}`));
  };
  assertDcs(0);

  renderChat(message, document.body);
  uncommon.click();
  assert.equal(uncommon.getAttribute("aria-pressed"), "true");
  assertDcs(2);
  rare.click();
  assert.equal(rare.getAttribute("aria-pressed"), "true");
  assert.equal(uncommon.getAttribute("aria-pressed"), "false");
  assertDcs(5);
  assert.deepEqual([...totals.children].map((line) => line.textContent), skillTotals);
  common.click();
  assertDcs(0);
  assert.equal(rolls, 1);

  const legacy = new JSDOM(`<section class="pza-recognize-spell">
    <button data-rarity="Common">Common</button><button data-rarity="Rare">Rare</button>
    <table><tbody></tbody></table></section>`).window.document;
  renderChat(message, legacy.body);
  legacy.querySelector("button[data-rarity='Rare']").click();
  const legacyRows = legacy.querySelector("tbody").rows;
  assert.equal(legacyRows.length, 10);
  assert.equal(legacyRows[0].cells[1].textContent, "20");
  legacy.querySelector("button[data-rarity='Common']").click();
  assert.equal(legacyRows[0].cells[4].title, "Automatic Success");

  const npc = {
    type: "npc",
    name: "NPC Mage",
    skills: {
      arcana: { label: "Arcana", rank: null, proficient: true, withRollOptions: () => ({ check: { mod: 2 } }) },
      religion: { label: "Religion", rank: null, proficient: false }
    }
  };
  canvas.tokens.controlled = [{ document: { actor: npc } }];
  const npcMessage = await recognizeSpell();
  const npcDocument = new JSDOM(npcMessage.content).window.document;
  assert.deepEqual([...npcDocument.querySelectorAll(".pza-spell-totals li")].map((line) => line.textContent),
    ["Arcana (Trained): 13"]);
  assert.equal(rolls, 2);
});

test("compiled Macro pack provides the module hotbar macros", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  const pack = manifest.packs.find(({ name }) => name === "zone-macros");

  assert.equal(pack.type, "Macro");

  const scratchRoot = join(root, "test-results");

  mkdirSync(scratchRoot, { recursive: true });

  const scratch = mkdtempSync(join(scratchRoot, "pf2e-zone-macro-pack-"));

  try {
    const packCopy = join(scratch, "pack");

    cpSync(join(root, pack.path), packCopy, { recursive: true });

    const records = await compiledPackRecords(packCopy);

    assert.equal(records.length, expectedMacros.size);
    assert.equal(new Set(records.map((macro) => macro.name)).size, records.length, "Macro names must be unique");
    assert.equal(records.filter((macro) => macro.name === "Set Hero Points").length, 1);

    for (const macro of records) {
      const expected = expectedMacros.get(macro._id);

      assert.ok(expected, `Unexpected macro ${macro._id}`);
      assert.match(macro._id, /^[A-Za-z0-9]{16}$/, "Foundry document IDs must have 16 characters");
      assert.equal(macro.name, expected.name);
      assert.equal(macro.type, "script");
      assert.equal(macro.ownership.default, expected.ownership ?? 2);
      assert.equal(macro.img, expected.image);
      assert.match(macro.command, /game\.modules\.get\("pf2e-zone-automation"\)/);
      assert.match(macro.command, new RegExp(`await zoneModule\\.api\\.${expected.api}\\(\\)`));
    }

    for (const { image } of expectedMacros.values()) {
      if (!image.startsWith("modules/pf2e-zone-automation/")) continue;

      const imagePath = image.replace("modules/pf2e-zone-automation/", "");
      const imageData = readFileSync(join(root, imagePath));

      assert.equal(imageData.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(imageData.subarray(8, 12).toString("ascii"), "WEBP");
    }
  } finally {
    assert.ok(scratch.startsWith(`${scratchRoot}${sep}`));
    rmSync(scratch, { recursive: true, force: true });
  }
});
