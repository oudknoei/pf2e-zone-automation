# PF2e Zone Automation

An early Foundry VTT v14 module that provide generic area of effect automation (circular bursts and emanations); this targets PF2e 8.5.1+.

## Install on The Forge

Use a Forge-hosted Foundry VTT v14 game with PF2e 8.5.1. Install **Advanced Macros 2.4.0+** and **PF2e Utility Buttons 0.21.0+** (package ID `pf2e-flatcheck-helper`). Both are declared as required dependencies in `module.json`.

After the first GitHub release is published, open The Forge Bazaar and use **Install from Custom Manifest**:

1. Paste this manifest URL: `https://github.com/oudknoei/pf2e-zone-automation/releases/latest/download/module.json`
2. Install the module. If the Foundry server is running, restart it from **Games Configuration**.
3. Open the PF2e world and enable **PF2e Zone Automation** under **Settings → Manage Modules**. Enable the two required modules there as well.

The manifest URL tracks the latest published release. It will return an error until the first release has been published.

Players use the module's **PF2e Zone Builder** control directly; no world macros need to be created. An active GM must be logged in for player-initiated creation, dismissal, and shared preset changes.

Select one source token and click **PF2e Zone Builder** in the token controls.

The module initializes the zone runtime when the world opens. New Regions use a short Execute Script behavior that calls the module API. Their configuration and state still use the original `world.pf2eZone` flags, so existing zone data remains readable. Existing Regions retain their embedded scripts and continue to work. New Regions require this module to remain enabled.

## Current conversion scope

- GMs can build, save, load, create, manage, and dismiss zones without running either original macro.
- Player initiated create, dismiss, and preset operations are sent to the active GM through the module's socket. The GM Worker code runs inside the module and checks the player's permissions. No GM Worker world macro or Advanced Macros configuration is needed. This has not yet been verified with separate live GM and player clients.
- The original macro files are kept under `original macro/` as conversion references. `tools/convert-macros.py` can regenerate the extracted source files from those originals, but it overwrites edits in `scripts/builder.js`, `scripts/worker.js`, `scripts/runtime.js`, and `styles/pf2e-zone.css`.
- The three supplied custom Effects and their PNG images ship in the **PF2e Zone Effects** Item compendium.

## Bundled Effects

The Effect Item field in the builder accepts these compendium UUIDs:

| Effect | Item UUID |
| --- | --- |
| Shadow Raid - Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.WGhBnNhQNH3uVgP1` |
| Focusing Hum Protection | `Compendium.pf2e-zone-automation.zone-effects.Item.j42JjZYGnRM1wf6R` |
| Toxic Cloud – Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.Qz16EDTu2GVTtUPV` |

The images referenced by the supplied exports are stored in `assets/effects/` and the compendium Items point to those local files. The supplied Focusing Hum Protection Item contains a description but no rule elements, so this module preserves it as a descriptive Effect.

The checked-in LevelDB pack is ready for Foundry. To rebuild it from the JSON sources in `packs/src/zone-effects/`, install development dependencies with `pnpm install` and run `pnpm run build:packs`.

## Publishing a release

The source manifest points to a version-specific `module.zip` download. `tools/package-release.py` builds that ZIP with `module.json` at its root, the module scripts and styles, the three Effect images, and the compiled Effect pack. It also copies `module.json` as a separate release asset.

1. Commit and push the module files and `.github/workflows/release.yml` to the repository's default branch.
2. Set `version` in `module.json` and update its `download` URL to the matching tag. For example, version `0.1.1` uses tag `v0.1.1`.
3. Create and push that tag from the committed release state. The GitHub workflow runs checks and publishes `module.json` and `module.zip` as release assets. For the first release, use `git tag v0.1.1` and `git push origin v0.1.1`.

Run `python tools/package-release.py --tag v0.1.1` to check the ZIP locally before tagging. Generated files go into the ignored `dist/` directory. Keep the release public so The Forge can fetch both URLs.

## Local checks

Run `pnpm test` for the module and compiled Effect pack, plus `node --check` on each file in `scripts/` for syntax. Full gameplay behavior needs a Foundry v14 and PF2e 8.5.1 world with a GM and player client; it has not been verified in this repository alone.
