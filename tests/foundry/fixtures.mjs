import { test as base, expect } from "@playwright/test";

export const FOUNDRY_URL = process.env.FOUNDRY_URL || "http://127.0.0.1:31000";
const USERS = ["Primary GM", "Remote GM", "Zone Creator", "Bystander"];

async function login(page, userName) {
  await page.goto(`${FOUNDRY_URL}/join`, { waitUntil: "domcontentloaded" });
  const select = page.locator('select[name="userid"]');
  await select.waitFor({ state: "visible", timeout: 30_000 });
  const option = select.locator("option", { hasText: userName }).first();
  if (await option.count() !== 1) throw new Error(`Foundry test user '${userName}' is missing.`);
  if (await option.evaluate((element) => element.disabled)) {
    throw new Error(`Foundry test user '${userName}' is already logged in.`);
  }
  await select.selectOption({ label: userName });
  await page.locator('button[name="join"]').click();
  await page.waitForSelector(".game.system-pf2e", { timeout: 60_000 });
  await page.waitForFunction(() => (
    game?.ready === true
    && game.system?.id === "pf2e"
    && game.release?.generation === 14
    && foundry.utils.isNewerVersion(game.system.version, "8.5.0")
    && game.modules.get("pf2e-zone-automation")?.active === true
    && Boolean(globalThis.PF2EZoneRuntime)
  ), { timeout: 60_000 });
}

async function installHelpers(page) {
  await page.evaluate(() => {
    const prefix = "[PZA E2E]";

    const state = (sourceActor, sourceToken, extra = {}) => ({
      createdWorldTime: Number(game.time?.worldTime ?? 0),
      createdBy: { userId: game.user.id, name: game.user.name },
      sourceActorUuid: sourceActor.uuid,
      sourceTokenUuid: sourceToken.uuid,
      activation: { damageType: null },
      activationProcessed: true,
      activationPending: false,
      activationTargets: {},
      initialOccupants: {},
      deactivated: false,
      pendingSaves: {},
      resolvedSaves: {},
      repeat: {},
      hpObserved: {},
      immunities: {},
      applied: {},
      damageRolls: {},
      healingRolls: {},
      recoveryWatchers: {},
      turnStartEvents: {},
      duration: {},
      ...extra
    });

    const behavior = () => {
      const type = Object.entries(CONFIG.RegionBehavior?.dataModels ?? {})
        .find(([, model]) => model?.name === "ExecuteScriptRegionBehaviorType")?.[0] ?? "executeScript";
      return {
        name: "PF2e Zone Runtime",
        type,
        system: {
          events: [
            "behaviorActivated", "behaviorDeactivated", "behaviorViewed",
            "tokenEnter", "tokenExit", "tokenTurnStart", "tokenTurnEnd"
          ],
          source: `
const api = game.modules.get("pf2e-zone-automation")?.api;
if (!api?.handleRegionEvent) throw new Error("PF2e Zone Automation module is not active.");
await api.handleRegionEvent({ behavior, event, region, scene: typeof scene !== "undefined" ? scene : region?.parent });
`
        },
        disabled: false,
        flags: {}
      };
    };

    globalThis.__PZA_E2E = {
      prefix,
      state,

      async cleanup() {
        try { await game.user?.updateTokenTargets?.([]); } catch { /* best effort */ }
        try { canvas?.tokens?.releaseAll?.(); } catch { /* best effort */ }

        for (const message of [...(game.messages?.contents ?? [])].reverse()) {
          if (String(message.content ?? "").includes(prefix) || message.getFlag("world", "pf2eZoneE2E")) {
            try { await message.delete(); } catch { /* best effort */ }
          }
        }
        for (const scene of [...(game.scenes?.contents ?? [])].reverse()) {
          if (String(scene.name ?? "").startsWith(prefix)) {
            try { await scene.delete(); } catch { /* best effort */ }
          }
        }
        for (const actor of [...(game.actors?.contents ?? [])].reverse()) {
          if (String(actor.name ?? "").startsWith(prefix)) {
            try { await actor.delete(); } catch { /* best effort */ }
          }
        }
      },

      async createActor(label, type = "npc") {
        return game.actors.documentClass.create({ name: `${prefix} ${label}`, type });
      },

      async createScene(label) {
        return game.scenes.documentClass.create({
          name: `${prefix} ${label}`,
          width: 2_000,
          height: 2_000,
          padding: 0,
          backgroundColor: "#20242a",
          grid: { type: CONST.GRID_TYPES.SQUARE, size: 100, distance: 5, units: "ft" }
        });
      },

      async createToken(scene, actor, { label = actor.name, x = 100, y = 100, linked = true } = {}) {
        const [token] = await scene.createEmbeddedDocuments("Token", [{
          name: label,
          actorId: actor.id,
          actorLink: linked,
          x,
          y,
          width: 1,
          height: 1,
          disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL
        }]);
        return token;
      },

      async defaultConfig(name, configure = null) {
        const { defaultConfig } = await import("/modules/pf2e-zone-automation/scripts/zone-config.js");
        const config = defaultConfig();
        config.name = `${prefix} ${name}`;
        config.mode = "area";
        config.targeting.affects = "both";
        if (configure) configure(config);
        return config;
      },

      async createRegion(scene, sourceActor, sourceToken, config, shape, extraState = {}) {
        const payload = {
          runtimeVersion: globalThis.PF2EZoneRuntime.version,
          config,
          state: state(sourceActor, sourceToken, extraState)
        };
        const [region] = await scene.createEmbeddedDocuments("Region", [{
          name: config.name,
          color: "#7f4cc9",
          visibility: CONST.REGION_VISIBILITY?.ALWAYS ?? 2,
          shapes: [shape],
          behaviors: [behavior()],
          flags: { world: { pf2eZone: payload } }
        }]);
        return region;
      },

      async effectSource() {
        const effect = await fromUuid("Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW");
        if (!effect || effect.type !== "effect") throw new Error("PF2e Taunt effect was not found.");
        const source = effect.toObject();
        delete source._id;
        return source;
      },

      async packItem(packId, slug) {
        const pack = game.packs.get(packId);
        if (!pack) throw new Error(`PF2e compendium '${packId}' was not found.`);
        const index = await pack.getIndex({ fields: ["system.slug"] });
        const entry = index.find((item) => item.system?.slug === slug);
        if (!entry) throw new Error(`PF2e item '${slug}' was not found in '${packId}'.`);
        return pack.getDocument(entry._id);
      },

      async createShieldingTauntFixture(label) {
        const scene = await this.createScene(`${label} scene`);
        const guardian = await this.createActor(`${label} guardian`, "character");
        const oldTarget = await this.createActor(`${label} old target`);
        const newTarget = await this.createActor(`${label} new target`);
        const [feat, shield] = await Promise.all([
          this.packItem("pf2e.feats-srd", "shielding-taunt"),
          this.packItem("pf2e.equipment-srd", "steel-shield")
        ]);
        const featSource = feat.toObject();
        const shieldSource = shield.toObject();
        delete featSource._id;
        delete shieldSource._id;
        shieldSource.system.equipped = {
          ...(shieldSource.system.equipped ?? {}),
          carryType: "held",
          handsHeld: 1,
          invested: null
        };
        await guardian.createEmbeddedDocuments("Item", [featSource, shieldSource]);

        const sourceToken = await this.createToken(scene, guardian, { x: 100, y: 100 });
        const oldToken = await this.createToken(scene, oldTarget, { x: 300, y: 100 });
        const newToken = await this.createToken(scene, newTarget, { x: 500, y: 100 });
        if (!guardian.heldShield) throw new Error("The real PF2e Actor did not recognize its held steel shield.");
        return { scene, guardian, oldTarget, newTarget, sourceToken, oldToken, newToken };
      }
    };
  });
}

export const test = base.extend({
  sessions: [async ({ browser }, use) => {
    const contexts = [];
    const pages = {};
    try {
      for (const userName of USERS) {
        const context = await browser.newContext({ viewport: { width: 1_280, height: 800 } });
        contexts.push(context);
        const page = await context.newPage();
        await login(page, userName);
        await installHelpers(page);
        pages[userName] = page;
      }
      await use({
        primary: pages["Primary GM"],
        remote: pages["Remote GM"],
        creator: pages["Zone Creator"],
        bystander: pages.Bystander
      });
    } finally {
      for (const context of contexts.reverse()) await context.close().catch(() => {});
    }
  }, { scope: "worker" }]
});

export { expect };
