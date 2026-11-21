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
    nature: { label: "Nature", rank: 0 },
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
  const [common, uncommon, rare] = document.querySelectorAll("button");
  const tableBody = document.querySelector("tbody");
  const commonRows = tableBody.innerHTML;
  assert.deepEqual([...document.querySelectorAll("thead th")].map((cell) => cell.textContent),
    ["Rank", "DC", "Arcana", "Religion"]);
  assert.equal(tableBody.rows.length, 10);
  assert.equal(tableBody.rows[0].cells[2].className, "pza-spell-success pza-spell-critical");
  for (const row of [tableBody.rows[0], tableBody.rows[1]]) {
    const religion = row.cells[3];
    assert.equal(religion.textContent, "8");
    assert.equal(religion.className, "pza-spell-success");
    assert.equal(religion.title, "Automatic Success");
  }
  assert.equal(tableBody.rows[2].cells[3].className, "pza-spell-failure pza-spell-critical");

  renderChat(message, document.body);
  uncommon.click();
  assert.equal(uncommon.getAttribute("aria-pressed"), "true");
  assert.equal(tableBody.rows[0].cells[1].textContent, "17");
  assert.equal(tableBody.rows[0].cells[2].className, "pza-spell-success");
  assert.equal(tableBody.rows[0].cells[3].className, "pza-spell-failure");
  assert.equal(tableBody.rows[1].cells[3].className, "pza-spell-failure pza-spell-critical");
  rare.click();
  assert.equal(rare.getAttribute("aria-pressed"), "true");
  assert.equal(uncommon.getAttribute("aria-pressed"), "false");
  assert.equal(tableBody.rows[0].cells[1].textContent, "20");
  assert.equal(tableBody.rows[9].cells[1].textContent, "44");
  assert.equal(tableBody.rows[9].cells[3].className, "pza-spell-failure pza-spell-critical");
  assert.deepEqual([...tableBody.rows[0].cells].map((cell) => cell.textContent), ["1", "20", "25", "8"]);
  common.click();
  assert.equal(tableBody.innerHTML, commonRows);
  assert.equal(rolls, 1);

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
  const npcRows = npcDocument.querySelector("tbody").rows;
  assert.deepEqual([...npcDocument.querySelectorAll("thead th")].map((cell) => cell.textContent),
    ["Rank", "DC", "Arcana"]);
  assert.equal(npcRows[0].cells[2].textContent, "13");
  assert.equal(npcRows[1].cells[2].title, "Automatic Success");
  assert.equal(npcRows[2].cells[2].title, "Failure");
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
