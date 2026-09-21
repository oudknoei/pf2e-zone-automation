# PF2e Zone Automation

PF2e Zone Automation creates Foundry VTT Regions for Pathfinder Second Edition spells, hazards, and abilities with circular areas of effect. Build an emanation that follows its source token or a fixed circular area, then let the module manage the configured effects as creatures enter, leave, or remain in the zone.

## Features

- Create token-following emanations and fixed circular areas.
- Configure one or more Effect Blocks for each zone.
- Run an Effect Block when a zone is created, when a creature enters, during turns, while a creature is inside, or when a watched trait is used.
- Resolve saves and outcome-specific damage, healing, conditions, chat alerts, and PF2e Effect Items.
- Set a fixed duration, or enter a dice formula such as `2d4` in the existing **X rounds** field. The active GM rolls a formula once when the zone is created, stores the result, and posts the duration in a GM-only chat message.
- Save, share, load, update, and delete presets through the PF2e Zone Library.
- Create, dismiss, and manage zones as a player who owns the selected source Actor while a GM is online. No world macros are required.

## Requirements

- Foundry VTT v14
- Pathfinder 2e v8.5.1 or later
- Advanced Macros v2.4.0 or later
- PF2e Utility Buttons v0.21.0 or later (`pf2e-flatcheck-helper`)
- libWrapper

Advanced Macros, PF2e Utility Buttons, and libWrapper are required module dependencies. Install and enable them in the same world as PF2e Zone Automation.

## Install on The Forge

In The Forge Bazaar, select **Install from Custom Manifest** and paste:

```text
https://github.com/oudknoei/pf2e-zone-automation/releases/latest/download/module.json
```

After installation, restart the Foundry server from **Games Configuration** if it is running. Open the PF2e world, then enable **PF2e Zone Automation** and its required dependencies under **Settings → Manage Modules**.

## How To

### Open the builder

1. Select exactly one token with an Actor.
2. Click **PF2e Zone Builder** in Token Controls, or run the **Open PF2e Zone Builder** macro from the supplied compendium.
3. Confirm the source shown at the top of the builder. If the controlled token changed, select **Use Current Selection**.

A player can create a zone only from an Actor they own. An active GM must be connected when a player creates or dismisses a zone or changes the shared preset library.

### Set up the zone

1. Give the zone a clear name.
2. Choose **Emanation** for a circle that follows the source token, or **Area** for a fixed circle placed on the Scene after selecting **Create Zone**.
3. Enter the radius in feet, choose who can be affected, and decide whether the source is included.
4. Choose the zone's visibility and any applicable traits.
5. Set the duration. Choose **X rounds** for a positive whole number such as `6` or a dice formula such as `2d4`. A formula is rolled once when the zone is created, and its result is recorded in a GM-only chat message. Use the dismissal checkbox when the source should be able to end the zone early.

Use **Activation Choices** only when a zone needs one shared damage type selected at activation, such as Shadow Raid.

### Configure an Effect Block

An Effect Block answers two questions: **when does this happen?** and **what happens?** A zone can have several blocks when it needs different triggers or results. The collapsed block header summarizes its configured trigger and result.

Choose one or more plain-language trigger choices:

| Trigger | Use it when... |
| --- | --- |
| **When the zone is created** | Eligible creatures already inside should be affected immediately. |
| **When a creature enters after creation** | A creature should be affected only when it crosses into the zone later. |
| **At the start of a creature's turn** | The effect belongs at the beginning of an affected creature's turn. |
| **At the end of a creature's turn** | The effect belongs at the end of an affected creature's turn. |
| **At the start of the source's turn** | The source's combat turn controls the effect, even when the source is outside a fixed area. |
| **While a creature is inside** | The no-save result should be maintained for occupants, such as an ongoing Effect Item. Verify damage and healing carefully before using this trigger. |
| **When a creature uses a trait** | A creature inside the zone uses an item, spell, or ability with the watched trait. |

Then choose how often each creature can be affected: every time the event happens, once each round, or once for the zone's lifetime.

### Define the result

Within an Effect Block, enable only the result sections the ability needs:

- **Chat Alert** posts a message when the block runs. It supports the listed placeholders such as `{creature}`, `{zone}`, and `{item}`.
- **Saving Throw** requests the selected save against a custom DC or a statistic from the source Actor. Select **Basic save** for the normal 0 / half / full / double progression.
- **Damage** and **Healing** post normal PF2e roll cards.
- **Degree-of-success payloads** apply Conditions or PF2e Effect Items for each save result, or under **No Save** when no save is enabled.
- **Temporary Immunity** prevents later applications for the chosen duration after the selected result.

To apply an Effect Item, paste its Item UUID into the relevant result. The supplied Effects are available in the **PF2e Zone Effects** compendium:

| Effect | UUID |
| --- | --- |
| Shadow Raid - Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.WGhBnNhQNH3uVgP1` |
| Focusing Hum Protection | `Compendium.pf2e-zone-automation.zone-effects.Item.j42JjZYGnRM1wf6R` |
| Toxic Cloud – Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.Qz16EDTu2GVTtUPV` |

Choose the Effect Item removal rule that matches the ability: keep the item's own duration, remove it when the creature exits, or remove it when the zone ends.

### Review, create, and manage the zone

1. Select **Validate** to check the configuration.
2. Select **Post Preview to Chat** to validate and post a readable summary without creating a Region.
3. Select **Create Zone** to create and activate it. For an Area, click the Scene to place its center.
4. Use **Manage Existing Zones** to inspect, export, or dismiss zones on the active Scene.

As you edit, the footer shows **Ready to create** when the configuration has no blocking errors. It also reports **GM connected** for a GM, **Player creation available** when a player can reach an active GM, or **Source token changed** when you need to update the controlled source. Invalid fields receive an inline explanation; warnings remain visible in the validation and preview views but do not prevent creation.

### Save, import, and reuse configurations

Select **Save** to store the current configuration in the shared **PF2e Zone Library** Journal, inside the **PF2e Zone Automation** Journal Entries folder. Use **Save As** to create a new preset without changing the original. **Load Saved Zone** lists available presets.

Seven ready-to-import configurations are included in [`examples/zone-configurations/`](examples/zone-configurations/): Shadow Raid, Frightful Presence, Ghonatine Stench, Courageous Anthem, Focusing Hum, Toxic Cloud, and Soul Cutter - Soothe Souls.

To use an example, open its JSON file, copy its contents, select a source token, open the builder, select **Import JSON**, paste the configuration, and select **Import**. Adjust the imported values for the selected Actor and encounter before creating the zone. Use **Export JSON** to copy a portable configuration for reuse.

## Included Macros

The **PF2e Zone Macros** compendium contains these hotbar-ready Script Macros. Both default to **Observer** ownership for players, and their commands call the module API so the underlying logic updates with the module.

| Macro | What it does |
| --- | --- |
| **Open PF2e Zone Builder** | Opens the zone builder for the one controlled source token. |
| **Shielding Taunt** | For a Guardian with Shielding Taunt and a wielded shield, raises the shield, applies PF2e's auditory Taunt effect to one targeted creature, and replaces that Guardian's prior Taunt. |