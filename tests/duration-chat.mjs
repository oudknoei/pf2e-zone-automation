import assert from "node:assert/strict";
import test from "node:test";

const { postFormulaDurationMessage } = await import("../scripts/duration-chat.js");

test("formula duration chat messages match their zone visibility", async () => {
  const originalChatMessage = globalThis.ChatMessage;
  let created = null;
  try {
    globalThis.ChatMessage = {
      getWhisperRecipients(target) {
        assert.equal(target, "GM");
        return [{ id: "gm-one" }, { id: "gm-two" }];
      },
      getSpeaker({ actor, token }) {
        return { actor: actor?.id, token: token?.id };
      },
      async create(data) {
        created = data;
        return data;
      }
    };

    await postFormulaDurationMessage({
      zoneName: "Stoke the Fervent",
      duration: { formula: "2d4", rounds: 5 },
      visibility: "gm",
      actor: { id: "actor" },
      token: { id: "token" }
    });

    assert.deepEqual(created.whisper, ["gm-one", "gm-two"]);
    assert.deepEqual(created.speaker, { actor: "actor", token: "token" });
    assert.match(created.content, /Stoke the Fervent will last <strong>5 rounds<\/strong> \(rolled 2d4\)/);

    created = null;
    await postFormulaDurationMessage({
      zoneName: "Private Zone",
      duration: { formula: "1d6", rounds: 4 },
      visibility: "creator",
      creatorUserId: "player-one"
    });
    assert.deepEqual(created.whisper, ["player-one"]);

    created = null;
    await postFormulaDurationMessage({
      zoneName: "Public Zone",
      duration: { formula: "1d4", rounds: 3 },
      visibility: "everyone"
    });
    assert.equal("whisper" in created, false);
    assert.match(created.content, /Public Zone will last <strong>3 rounds<\/strong> \(rolled 1d4\)/);

    created = null;
    await postFormulaDurationMessage({ zoneName: "Fixed", duration: { formula: null, rounds: 6 }, visibility: "gm" });
    assert.equal(created, null);
  } finally {
    if (originalChatMessage === undefined) delete globalThis.ChatMessage;
    else globalThis.ChatMessage = originalChatMessage;
  }
});