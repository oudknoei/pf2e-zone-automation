# PF2e Zone Automation

PF2e Zone Automation creates Foundry VTT Regions for Pathfinder Second Edition spells, hazards, and abilities with a circular area of effect. Build an emanation that follows its source token or a fixed circular area, then let the module manage the configured effects while creatures enter, leave, or remain in the zone.

## Features

- Create token-following emanations and fixed circular areas.
- Configure one or more Effect Blocks in each zone.
- Trigger Effect Blocks on activation, entry, creature turn start or end, source turn start, continuous occupancy, and trait use.
- Resolve saves and outcome-specific damage, healing, conditions, and PF2e Effect Items.
- Set durations, dismissal, immunity, chat alerts, and damage-type choices.
- Save, share, load, update, and delete zone presets through the PF2e Zone Library.
- Launch the builder from the supplied hotbar-ready Script Macro.
- Create, dismiss, and manage zones as a player who owns the selected source Actor while a GM is online. No world macros are required.

## Requirements

- Foundry VTT v14
- Pathfinder 2e v8.5.1 or later
- Advanced Macros v2.4.0 or later
- PF2e Utility Buttons v0.21.0 or later (`pf2e-flatcheck-helper`)

Advanced Macros and PF2e Utility Buttons are required module dependencies. Install and enable them in the same world as PF2e Zone Automation.

## Install on The Forge

In The Forge Bazaar, select **Install from Custom Manifest** and paste:

```text
https://github.com/oudknoei/pf2e-zone-automation/releases/latest/download/module.json
```

After installation, restart the Foundry server from **Games Configuration** if it is running. Open the PF2e world, then enable **PF2e Zone Automation** and its required dependencies under **Settings → Manage Modules**.

## Create a Zone

1. Select exactly one token with an Actor.
2. Click **PF2e Zone Builder** in the Token Controls.
3. Choose the zone type, radius, duration, visibility, traits, and Effect Blocks.
4. Select **Create Zone**. For a fixed area, click the Scene to place its center.

Use **Manage Existing Zones** in the builder to inspect, export, or dismiss zones on the active Scene. Saved presets are shared through the **PF2e Zone Library** Journal in the **PF2e Zone Automation** Journal Entries folder.

## PF2e Zone Macros

The **PF2e Zone Macros** compendium contains **Open PF2e Zone Builder**. Drag it from the compendium to a Macro Hotbar slot, then select a source token and run it to open the builder.

## Example Configurations

Seven ready-to-import configurations are included in [`examples/zone-configurations/`](examples/zone-configurations/): Shadow Raid, Frightful Presence, Ghonatine Stench, Courageous Anthem, Focusing Hum, Toxic Cloud, and Soul Cutter - Soothe Souls.

To use one, open its JSON file, copy its contents, select a source token, open **PF2e Zone Builder**, select **Import JSON**, paste the configuration, and select **Import**. Adjust the imported values for the selected Actor and encounter before creating the zone. Use **Save** to add a configured zone to the shared **PF2e Zone Library** Journal.

## Player Use

Players open **PF2e Zone Builder** in the same way as a GM. They can create a zone only from an Actor they own and dismiss only a zone they are allowed to dismiss. The module sends these requests to the active GM client and verifies the player’s authority before it changes the Scene or shared preset library.

An active GM must remain connected for player-initiated zone creation, dismissal, and shared preset changes.

## PF2e Zone Effects

The three supplied Effects are in the separate **PF2e Zone Effects** Item compendium. Open **Compendium Packs** and select that pack to browse them. They do not appear in the world’s main Items directory unless a GM imports them.

Use these UUIDs in an Effect Item field in the builder:

| Effect | UUID |
| --- | --- |
| Shadow Raid - Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.WGhBnNhQNH3uVgP1` |
| Focusing Hum Protection | `Compendium.pf2e-zone-automation.zone-effects.Item.j42JjZYGnRM1wf6R` |
| Toxic Cloud – Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.Qz16EDTu2GVTtUPV` |

Each Effect uses its supplied PNG image from `assets/effects/`. Focusing Hum Protection is preserved as supplied: it has a description but no PF2e rule elements.

## Releasing a New Version

The GitHub release workflow runs checks, packages the module, and uploads `module.json` and `module.zip`. Set `version` in `module.json` and update its `download` URL to the matching tag, then commit, push, tag, and push the tag. For version `0.1.1`:

```powershell
git add -A
git commit -m "Release PF2e Zone Automation 0.1.1"
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

The release must be public so The Forge can retrieve the manifest and ZIP.
