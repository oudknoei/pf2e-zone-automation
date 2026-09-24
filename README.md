# PF2e Zone Automation

PF2e Zone Automation creates Foundry VTT Regions for Pathfinder Second Edition spells, hazards, and abilities with areas of effect. Build an emanation that follows its source token or a fixed circular or square area, then let the module manage the configured effects as creatures enter, leave, or remain in the zone.

## Features

- Create token-following emanations and fixed circular or square areas. Drag a fixed area to apply Entry effects to creatures it crosses, including those outside its final position.
- Configure one or more Effect Blocks for each zone.
- Run an Effect Block when a zone is created, when a creature enters, during turns, while a creature is inside, when a creature casts a spell, or when a watched trait is used.
- Resolve saves and outcome-specific damage, healing, conditions, chat alerts, and PF2e Effect Items.
- Set a fixed duration, or enter a dice formula such as `2d4` in the existing **X rounds** field. The active GM rolls a formula once when the zone is created, stores the result, and posts the duration to the creator for **Creator only** zones and publicly otherwise.
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

1. Give the zone a clear name. A name is required.
2. Choose **Emanation** for a circle that follows the source token, **Area - Circle** for a fixed circle, or **Area - Square** for a fixed square. Fixed areas are placed on the Scene after selecting **Create Zone**.
3. Enter the radius for an emanation or circle, or the full side length for a square (for example, **10 feet** for a 10-foot square). Check any combination of **Allies**, **Enemies**, and **Self (Source Actor)**. Select at least one. Previously saved circles and squares reopen with the matching Zone Type and target boxes selected.
4. Choose **Visible to everyone** or **Creator only**, then add any applicable traits. Creator-only zones and their module chat alerts are visible to the creator; Foundry GMs retain their normal access. Traits begin unchecked.
5. Set the duration. Choose **X rounds** for a positive whole number such as `6` or a dice formula such as `2d4`, or choose **Unlimited** for a zone that remains until ended. Foundry checks the formula syntax before creation. A formula is rolled once when the zone is created, and its result is recorded in a chat message that matches the zone visibility. The source owner can always dismiss a zone early from **Manage Existing Zones**.

Use **Activation Choices** only when a zone needs one shared damage type selected at activation, such as Shadow Raid.

### Configure an Effect Block

An Effect Block answers two questions: **when does this happen?** and **what happens?** A zone can have several blocks when it needs different triggers or results. The collapsed block header summarizes its configured trigger and result.

Choose one or more plain-language trigger choices:

| Trigger | Use it when... |
| --- | --- |
| **When the zone is created** | Eligible creatures already inside should be affected immediately. |
| **When a creature enters after creation** | A creature should be affected when it moves into the zone, or when a manually moved fixed area crosses its space. Each moved area applies this trigger once per affected creature along that drag, subject to the chosen repeat setting. |
| **At the start of a creature's turn** | The effect belongs at the beginning of an affected creature's turn. |
| **At the end of a creature's turn** | The effect belongs at the end of an affected creature's turn. |
| **At the start of the source's turn** | The source's combat turn controls the effect, even when the source is outside a fixed area. |
| **While a creature is inside** | The no-save result should be maintained for occupants, such as an ongoing Effect Item. Verify damage and healing carefully before using this trigger. |
| **When a creature casts a spell** | A creature inside the zone casts any spell, regardless of its individual traits. Use this for reactions that trigger on spellcasting itself. |
| **When a creature uses a selected trait** | A creature inside the zone uses an item, spell, or ability with one of the selected traits. |

For [*Cyclone Rondo*](https://2e.aonprd.com/Spells.aspx?ID=1301), choose **Area - Square** with a 10-foot side length and two Effect Blocks: **When the zone is created** for a Reflex save that applies prone on failure or critical failure, and **When a creature enters after creation** for `4d6` damage with a basic Reflex save. Set the damage block to **Every time this happens** if the square may be moved more than once in a round. Move its Region manually when the spell is Sustained, and dismiss it if the spell ends before its one-minute maximum. The builder does not track Sustain actions.

For **Trait Use Trigger**, select one or more common traits or enter another trait slug. It begins with no selection. The supplied choices cover common reactive-aura cases: energy and healing (**vitality**, **void**, **healing**), sanctification and spirit (**holy**, **unholy**, **spirit**, **divine**), and action or mental effects (**auditory**, **concentrate**, **manipulate**, **move**, **emotion**, **fear**, **mental**).

Then choose how often the block can trigger: every time the event happens, once each round, or once for the zone's lifetime. New Effect Blocks default to **Once each round**. For **While a creature is inside**, ongoing Conditions and Effect Items are restored as needed after re-entry; this choice still limits new chat alerts, damage, and healing.

### Define the result

Within an Effect Block, enable only the result sections the ability needs:

- **Chat Alert** posts a message when the block runs. It supports the listed placeholders such as `{creature}`, `{zone}`, and `{item}`.
- **Saving Throw** requests the selected save against a custom DC or a statistic from the source Actor. A custom DC begins blank and is required only when the saving throw is enabled. Select **Basic save** for the normal 0 / half / full / double progression.
- **Damage** and **Healing** post normal PF2e roll cards. Enabled formulas are checked with PF2e's damage-roll parser before the zone can be created.
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
2. Select **Post Preview to Chat** to validate and send a readable summary privately to yourself without creating a Region.
3. Select **Create Zone** to create and activate it. For an Area, click the Scene to place its center. A GM can later drag the Region; Entry effects apply along the straight path between its old and new positions. Resizing applies Entry only to newly covered creatures.
4. Use **Manage Existing Zones** to dismiss a zone on the active Scene. Dismiss opens that zone's configuration in the builder so you can edit and recreate it. The current source selection stays in place.

As you edit, the footer shows **Ready to create** when the configuration has no blocking errors. It also reports **GM connected** for a GM, **Player creation available** when a player can reach an active GM, or **Source token changed** when you need to update the controlled source. Invalid fields receive an inline explanation; warnings remain visible in the validation and preview views but do not prevent creation.

### Save, import, and reuse configurations

Select **Save** to store the current configuration in the shared **PF2e Zone Library** Journal, inside the **PF2e Zone Automation** Journal Entries folder. Use **Save As** to create a new preset without changing the original. **Open** lists available presets. **Clear** resets the editor to a new blank configuration. When a zone was created from a saved preset, dismissing it restores that preset link; **Save** updates the same preset, subject to its creator permissions. **Save As** makes a separate copy. Zones created before this feature cannot recover a preset link automatically.

Eight ready-to-import configurations are included in [`examples/zone-configurations/`](examples/zone-configurations/): Shadow Raid, Frightful Presence, Ghonatine Stench, Courageous Anthem, Focusing Hum, Toxic Cloud, Soul Cutter - Soothe Souls, and Stoke the Fervent.

To use an example, open its JSON file, copy its contents, select a source token, open the builder, select **Import JSON**, paste the configuration, and select **Import**. Adjust the imported values for the selected Actor and encounter before creating the zone. Use **Export JSON** to copy a portable configuration for reuse.

## Included Macros

The **PF2e Zone Macros** compendium contains these hotbar-ready Script Macros. Both default to **Observer** ownership for players, and their commands call the module API so the underlying logic updates with the module.

| Macro | What it does |
| --- | --- |
| **Open PF2e Zone Builder** | Opens the zone builder for the one controlled source token. |
| **Shielding Taunt** | For a Guardian with Shielding Taunt and a wielded shield, raises the shield, applies PF2e's auditory Taunt effect to one targeted creature, and replaces that Guardian's prior Taunt. |