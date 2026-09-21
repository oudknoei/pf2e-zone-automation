import assert from "node:assert/strict";
import test from "node:test";

const { postFormulaDurationToGMs } = await import("../scripts/duration-chat.js");

test("formula durations post their resolved length as a GM-only chat message", async () => {
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

    await postFormulaDurationToGMs({
      zoneName: "Stoke the Fervent",
      duration: { formula: "2d4", rounds: 5 },
      actor: { id: "actor" },
      token: { id: "token" }
    });

    assert.deepEqual(created.whisper, ["gm-one", "gm-two"]);
    assert.deepEqual(created.speaker, { actor: "actor", token: "token" });
    assert.match(created.content, /Stoke the Fervent will last <strong>5 rounds<\/strong> \(rolled 2d4\)/);

    created = null;
    await postFormulaDurationToGMs({ zoneName: "Fixed", duration: { formula: null, rounds: 6 } });
    assert.equal(created, null);
  } finally {
    if (originalChatMessage === undefined) delete globalThis.ChatMessage;
    else globalThis.ChatMessage = originalChatMessage;
  }
});