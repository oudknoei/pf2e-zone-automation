import { test, expect, FOUNDRY_URL } from "./fixtures.mjs";

test.describe.serial("real Foundry lifecycle coverage", () => {
  test.beforeEach(async ({ sessions }) => {
    const active = await sessions.primary.evaluate(() => game.users.activeGM?.name);
    expect(active).toBe("Primary GM");
  });

  test.afterEach(async ({ sessions }) => {
    for (const page of [sessions.primary, sessions.remote]) {
      const cleaned = await page.evaluate(async () => {
        if (!game?.ready || !globalThis.__PZA_E2E || game.users.activeGM?.id !== game.user.id) return false;
        await globalThis.__PZA_E2E.cleanup();
        return true;
      }).catch(() => false);
      if (cleaned) break;
    }
  });

  test("creator-only duration messages reach the creator but not a bystander", async ({ sessions }) => {
    const creatorId = await sessions.creator.evaluate(() => game.user.id);
    const message = await sessions.primary.evaluate(async (recipient) => {
      const { postFormulaDurationMessage } = await import("/modules/pf2e-zone-automation/scripts/duration-chat.js");
      const created = await postFormulaDurationMessage({
        zoneName: "[PZA E2E] private duration",
        duration: { formula: "1d4", rounds: 3 },
        visibility: "creator",
        creatorUserId: recipient
      });
      return { id: created.id, whisper: [...created.whisper] };
    }, creatorId);

    expect(message.whisper).toEqual([creatorId]);
    await expect.poll(() => sessions.creator.evaluate((id) => Boolean(game.messages.get(id)?.visible), message.id))
      .toBe(true);
    await expect.poll(() => sessions.bystander.evaluate((id) => Boolean(game.messages.get(id)?.visible), message.id))
      .toBe(false);
  });

  test("the GM socket trusts Foundry's sender id instead of a claimed requester id", async ({ sessions }) => {
    const bystanderId = await sessions.bystander.evaluate(() => game.user.id);
    const spoofed = await sessions.creator.evaluate(async (claimedUserId) => {
      const { requestGMWorker } = await import("/modules/pf2e-zone-automation/scripts/transport.js");
      return requestGMWorker({ protocol: 1, action: "ping", requesterUserId: claimedUserId });
    }, bystanderId);
    expect(spoofed.ok).toBe(false);
    expect(spoofed.error).toContain("does not match the socket sender");

    const legitimate = await sessions.creator.evaluate(async () => {
      const { requestGMWorker } = await import("/modules/pf2e-zone-automation/scripts/transport.js");
      return requestGMWorker({ protocol: 1, action: "ping", requesterUserId: game.user.id });
    });
    expect(legitimate).toMatchObject({ ok: true, action: "ping" });
  });

  test("deleting an unlinked target lets dismissal finish", async ({ sessions }) => {
    const fixture = await sessions.primary.evaluate(async () => {
      const helper = globalThis.__PZA_E2E;
      const scene = await helper.createScene("deleted target");
      const sourceActor = await helper.createActor("deleted target source");
      const targetActor = await helper.createActor("deleted target base");
      const sourceToken = await helper.createToken(scene, sourceActor, { x: 100, y: 100 });
      const targetToken = await helper.createToken(scene, targetActor, { x: 300, y: 100, linked: false });
      const config = await helper.defaultConfig("deleted target zone", (value) => { value.effects = []; });
      const region = await helper.createRegion(
        scene, sourceActor, sourceToken, config,
        { type: "rectangle", x: 0, y: 0, width: 600, height: 400, rotation: 0, gridBased: true }
      );
      const [item] = await targetToken.actor.createEmbeddedDocuments("Item", [await helper.effectSource()]);
      const runtime = globalThis.PF2EZoneRuntime;
      await runtime.withState(region, (payload) => {
        payload.state.applied.deletedTarget = {
          recordId: "deletedTarget",
          kind: "effect",
          actorUuid: targetToken.actor.uuid,
          tokenUuid: targetToken.uuid,
          itemId: item.id,
          blockId: "deleted-target",
          removal: "zone-end"
        };
      });
      return { sceneId: scene.id, regionId: region.id, targetTokenId: targetToken.id };
    });

    await sessions.primary.evaluate(async ({ sceneId, targetTokenId }) => {
      await game.scenes.get(sceneId).tokens.get(targetTokenId).delete();
    }, fixture);

    await expect.poll(() => sessions.primary.evaluate(({ sceneId, regionId }) => {
      const region = game.scenes.get(sceneId)?.regions.get(regionId);
      return Object.keys(region?.getFlag("world", "pf2eZone")?.state?.applied ?? {}).length;
    }, fixture)).toBe(0);

    await sessions.primary.evaluate(async ({ sceneId, regionId }) => {
      const region = game.scenes.get(sceneId).regions.get(regionId);
      await globalThis.PF2EZoneRuntime.endZone(region, "real-Foundry deleted-target test");
    }, fixture);
    await expect.poll(() => sessions.primary.evaluate(({ sceneId, regionId }) => (
      Boolean(game.scenes.get(sceneId)?.regions.get(regionId))
    ), fixture)).toBe(false);
  });

  test("save recovery resolves a genuine completed PF2e roll and preserves an unanswered request", async ({ sessions }) => {
    const result = await sessions.primary.evaluate(async () => {
      const helper = globalThis.__PZA_E2E;
      const scene = await helper.createScene("save recovery");
      const sourceActor = await helper.createActor("save recovery source");
      const targetActor = await helper.createActor("save recovery target");
      const sourceToken = await helper.createToken(scene, sourceActor, { x: 100, y: 100 });
      const targetToken = await helper.createToken(scene, targetActor, { x: 300, y: 100 });
      const config = await helper.defaultConfig("save recovery zone", (value) => {
        const block = value.effects[0];
        block.id = "save-block";
        block.name = "Recovery Save";
        block.triggers.enter = true;
        block.repeat = "every";
        block.save.enabled = true;
        block.save.type = "fortitude";
        block.save.dc = { mode: "custom", value: 10 };
        block.save.basic = false;
        block.chatAlert.enabled = false;
      });
      const region = await helper.createRegion(
        scene, sourceActor, sourceToken, config,
        { type: "rectangle", x: 0, y: 0, width: 600, height: 400, rotation: 0, gridBased: true }
      );
      const completedId = "completed";
      const unansweredId = "unanswered";
      const completedIdentifier = `pf2e-zone:${scene.id}:${region.id}:${completedId}`;
      const unansweredIdentifier = `pf2e-zone:${scene.id}:${region.id}:${unansweredId}`;
      const runtime = globalThis.PF2EZoneRuntime;
      await runtime.withState(region, (payload) => {
        const common = {
          tokenUuid: targetToken.uuid,
          actorUuid: targetToken.actor.uuid,
          blockId: "save-block",
          blockName: "Recovery Save",
          trigger: "enter",
          batchId: "save-recovery",
          dc: 10,
          saveTypes: ["fortitude"],
          eventContext: { trigger: "enter", count: 1 },
          createdWorldTime: Number(game.time.worldTime ?? 0)
        };
        payload.state.pendingSaves[completedId] = {
          ...common, id: completedId, identifier: completedIdentifier
        };
        payload.state.pendingSaves[unansweredId] = {
          ...common, id: unansweredId, identifier: unansweredIdentifier
        };
      });

      runtime.teardownHooks();
      let roll;
      try {
        roll = await targetToken.actor.getStatistic("fortitude").roll({
          identifier: completedIdentifier,
          token: targetToken,
          dc: { value: 10 },
          traits: [],
          extraRollOptions: ["area-effect"],
          title: "[PZA E2E] recovered save",
          skipDialog: true
        });
      } finally {
        runtime.installHooks();
      }
      const message = [...game.messages.contents].reverse().find((entry) => (
        entry.flags?.pf2e?.context?.identifier === completedIdentifier
      ));
      if (!message || !roll) throw new Error("PF2e did not create the expected saving-throw ChatMessage.");
      await message.setFlag("world", "pf2eZoneE2E", true);

      await runtime.reconcileCompletedSaves();
      const payload = runtime.readPayload(region);
      return {
        pending: Object.keys(payload.state.pendingSaves).sort(),
        resolved: payload.state.resolvedSaves[completedId]?.identifier ?? null
      };
    });

    expect(result.pending).toEqual(["unanswered"]);
    expect(result.resolved).toMatch(/^pf2e-zone:/);
  });

  test("an on-exit item remains while another linked token for the same actor is inside", async ({ sessions }) => {
    const fixture = await sessions.primary.evaluate(async () => {
      const helper = globalThis.__PZA_E2E;
      const scene = await helper.createScene("linked tokens");
      await scene.view();
      const sourceActor = await helper.createActor("linked tokens source");
      const sharedActor = await helper.createActor("linked tokens target");
      const sourceToken = await helper.createToken(scene, sourceActor, { x: 700, y: 100 });
      const firstToken = await helper.createToken(scene, sharedActor, { x: 100, y: 100 });
      const secondToken = await helper.createToken(scene, sharedActor, { x: 300, y: 100 });
      const config = await helper.defaultConfig("linked tokens zone", (value) => { value.effects = []; });
      const region = await helper.createRegion(
        scene, sourceActor, sourceToken, config,
        { type: "rectangle", x: 0, y: 0, width: 500, height: 400, rotation: 0, gridBased: true }
      );
      const source = await helper.effectSource();
      foundry.utils.setProperty(source, "flags.world.pf2eZone", {
        kind: "effect", zoneUuid: region.uuid, blockId: "linked", tokenUuid: firstToken.uuid, removal: "on-exit"
      });
      const [item] = await sharedActor.createEmbeddedDocuments("Item", [source]);
      await globalThis.PF2EZoneRuntime.withState(region, (payload) => {
        payload.state.applied.linked = {
          recordId: "linked",
          kind: "effect",
          actorUuid: sharedActor.uuid,
          tokenUuid: firstToken.uuid,
          itemId: item.id,
          blockId: "linked",
          removal: "on-exit"
        };
      });
      return {
        sceneId: scene.id,
        actorId: sharedActor.id,
        firstTokenId: firstToken.id,
        secondTokenId: secondToken.id,
        itemId: item.id
      };
    });

    await sessions.primary.evaluate(async ({ sceneId, firstTokenId }) => {
      await game.scenes.get(sceneId).tokens.get(firstTokenId).update({ x: 1_000 });
    }, fixture);
    await expect.poll(() => sessions.primary.evaluate(({ actorId, itemId }) => (
      Boolean(game.actors.get(actorId)?.items.get(itemId))
    ), fixture), { timeout: 5_000 }).toBe(true);
    await sessions.primary.evaluate(async ({ sceneId, secondTokenId }) => {
      await game.scenes.get(sceneId).tokens.get(secondTokenId).update({ x: 1_000 });
    }, fixture);
    await expect.poll(() => sessions.primary.evaluate(({ actorId, itemId }) => (
      Boolean(game.actors.get(actorId)?.items.get(itemId))
    ), fixture), { timeout: 5_000 }).toBe(false);
  });

  test("a remote GM moving an off-canvas area applies Entry along the swept path", async ({ sessions }) => {
    const fixture = await sessions.primary.evaluate(async () => {
      const helper = globalThis.__PZA_E2E;
      const encounter = await helper.createScene("remote movement encounter");
      const other = await helper.createScene("active GM other scene");
      const sourceActor = await helper.createActor("remote movement source");
      const targetActor = await helper.createActor("remote movement target");
      const sourceToken = await helper.createToken(encounter, sourceActor, { x: 1_500, y: 100 });
      const targetToken = await helper.createToken(encounter, targetActor, { x: 500, y: 100 });
      await other.view();
      const config = await helper.defaultConfig("remote movement zone", (value) => {
        const block = value.effects[0];
        block.id = "remote-entry";
        block.name = "Remote Entry";
        block.triggers.enter = true;
        block.repeat = "every";
        block.chatAlert.enabled = true;
        block.chatAlert.text = "[PZA E2E] remote area reached {creature}";
      });
      const region = await helper.createRegion(
        encounter, sourceActor, sourceToken, config,
        { type: "rectangle", x: 100, y: 100, width: 200, height: 200, rotation: 0, gridBased: true }
      );
      return {
        encounterId: encounter.id,
        otherId: other.id,
        regionId: region.id,
        regionUuid: region.uuid,
        targetName: targetToken.name
      };
    });

    expect(await sessions.primary.evaluate(() => canvas.scene.id)).toBe(fixture.otherId);
    await sessions.remote.waitForFunction((sceneId) => game.scenes.has(sceneId), fixture.encounterId);
    await expect.poll(() => sessions.primary.evaluate((regionUuid) => (
      globalThis.PF2EZoneRuntime.areaBoundarySnapshots.has(regionUuid)
    ), fixture.regionUuid)).toBe(true);
    await sessions.remote.evaluate(async ({ encounterId }) => {
      await game.scenes.get(encounterId).view();
    }, fixture);
    await sessions.remote.evaluate(async ({ encounterId, regionId }) => {
      const region = game.scenes.get(encounterId).regions.get(regionId);
      await region.update({
        shapes: [{ type: "rectangle", x: 800, y: 100, width: 200, height: 200, rotation: 0, gridBased: true }]
      });
    }, fixture);

    await expect.poll(() => sessions.primary.evaluate((targetName) => (
      game.messages.contents.some((message) => (
        String(message.content ?? "").includes("[PZA E2E] remote area reached")
        && String(message.content ?? "").includes(targetName)
      ))
    ), fixture.targetName), { timeout: 10_000 }).toBe(true);
    expect(await sessions.primary.evaluate(() => canvas.scene.id)).toBe(fixture.otherId);
  });

  test("Shielding Taunt does not leave two Taunts when old-effect cleanup fails", async ({ sessions }) => {
    const fixture = await sessions.primary.evaluate(async () => {
      const helper = globalThis.__PZA_E2E;
      const value = await helper.createShieldingTauntFixture("delete failure");
      const source = await helper.effectSource();
      source.system.context = {
        origin: { actor: value.guardian.uuid, token: value.sourceToken.uuid, item: null, spellcasting: null, rollOptions: [] },
        target: { actor: value.oldTarget.uuid, token: value.oldToken.uuid },
        roll: null
      };
      await value.oldTarget.createEmbeddedDocuments("Item", [source]);
      return {
        guardianUuid: value.guardian.uuid,
        sourceTokenUuid: value.sourceToken.uuid,
        oldActorId: value.oldTarget.id,
        newActorId: value.newTarget.id,
        newTokenUuid: value.newToken.uuid,
        tauntEffectUuid: "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW"
      };
    });

    const result = await sessions.primary.evaluate(async ({ guardianUuid, sourceTokenUuid, oldActorId, newActorId, newTokenUuid, tauntEffectUuid }) => {
      const oldActor = game.actors.get(oldActorId);
      let owner = oldActor;
      while (owner && !Object.hasOwn(owner, "deleteEmbeddedDocuments")) owner = Object.getPrototypeOf(owner);
      if (!owner) throw new Error("Could not locate Actor.deleteEmbeddedDocuments.");
      const original = owner.deleteEmbeddedDocuments;
      owner.deleteEmbeddedDocuments = async function(type, ids, ...args) {
        if (this.id === oldActorId && type === "Item") throw new Error("injected old Taunt cleanup failure");
        return original.call(this, type, ids, ...args);
      };
      let response;
      try {
        const { requestGMWorker } = await import("/modules/pf2e-zone-automation/scripts/transport.js");
        response = await requestGMWorker({
          protocol: 1,
          action: "shielding-taunt",
          requesterUserId: game.user.id,
          operationId: foundry.utils.randomID(20),
          sourceTokenUuid,
          targetTokenUuid: newTokenUuid
        });
      } finally {
        owner.deleteEmbeddedDocuments = original;
      }
      const count = [game.actors.get(oldActorId), game.actors.get(newActorId)]
        .flatMap((actor) => actor.itemTypes.effect)
        .filter((item) => item.sourceId === tauntEffectUuid && item.system?.context?.origin?.actor === guardianUuid)
        .length;
      return { response, count };
    }, fixture);
    expect(result.count).toBe(1);
  });

  test("Shielding Taunt reports mechanical success when only chat creation fails", async ({ sessions }) => {
    const fixture = await sessions.primary.evaluate(async () => {
      const value = await globalThis.__PZA_E2E.createShieldingTauntFixture("chat failure");
      return {
        guardianUuid: value.guardian.uuid,
        sourceTokenUuid: value.sourceToken.uuid,
        targetActorId: value.newTarget.id,
        targetTokenUuid: value.newToken.uuid,
        tauntEffectUuid: "Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW"
      };
    });

    const result = await sessions.primary.evaluate(async ({ guardianUuid, sourceTokenUuid, targetActorId, targetTokenUuid, tauntEffectUuid }) => {
      const original = ChatMessage.create;
      ChatMessage.create = async () => { throw new Error("injected chat failure"); };
      let response;
      try {
        const { requestGMWorker } = await import("/modules/pf2e-zone-automation/scripts/transport.js");
        response = await requestGMWorker({
          protocol: 1,
          action: "shielding-taunt",
          requesterUserId: game.user.id,
          operationId: foundry.utils.randomID(20),
          sourceTokenUuid,
          targetTokenUuid
        });
      } finally {
        ChatMessage.create = original;
      }
      const applied = game.actors.get(targetActorId).itemTypes.effect.some((item) => (
        item.sourceId === tauntEffectUuid && item.system?.context?.origin?.actor === guardianUuid
      ));
      return { response, applied };
    }, fixture);
    expect(result.applied).toBe(true);
    expect(result.response.ok).toBe(true);
    expect(result.response.warnings?.join(" ")).toMatch(/chat/i);
  });

  test("a new active GM resumes an unfinished dismissal without viewing the Scene", async ({ sessions }) => {
    const fixture = await sessions.primary.evaluate(async () => {
      const helper = globalThis.__PZA_E2E;
      const scene = await helper.createScene("GM handoff");
      const sourceActor = await helper.createActor("GM handoff source");
      const sourceToken = await helper.createToken(scene, sourceActor, { x: 100, y: 100 });
      const config = await helper.defaultConfig("GM handoff zone", (value) => { value.effects = []; });
      const region = await helper.createRegion(
        scene, sourceActor, sourceToken, config,
        { type: "rectangle", x: 0, y: 0, width: 400, height: 400, rotation: 0, gridBased: true }
      );
      await globalThis.PF2EZoneRuntime.withState(region, (payload) => {
        payload.state.endRequested = true;
        payload.state.endReason = "injected unfinished dismissal";
      });
      return { sceneId: scene.id, regionId: region.id };
    });

    await sessions.primary.goto(`${FOUNDRY_URL}/join`, { waitUntil: "domcontentloaded" });
    await sessions.remote.waitForFunction(() => game.users.activeGM?.name === "Remote GM", { timeout: 15_000 });
    await expect.poll(() => sessions.remote.evaluate(({ sceneId, regionId }) => (
      Boolean(game.scenes.get(sceneId)?.regions.get(regionId))
    ), fixture), { timeout: 5_000 }).toBe(false);
  });
});
