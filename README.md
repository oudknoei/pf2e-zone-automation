# PF2e Zone Automation

PF2e Zone Automation creates Foundry VTT Regions for Pathfinder Second Edition spells, hazards, and abilities with areas of effect. Build an emanation that follows its source token or a fixed circular or square area, then let the module manage the configured effects as creatures enter, leave, or remain in the zone.

## Features

- Create token-following emanations and fixed circular or square areas. Use **Move** for a fixed area to apply Entry effects to creatures it crosses, including those outside its final position.
- Show zones as colored outlines without an interior fill, so overlapping zones remain easy to distinguish. Existing zones use the same outline display after the Scene loads.
- Configure one or more Effect Blocks for each zone.
- Run an Effect Block when a zone is created, when a creature enters, during turns, while a creature is inside, when a creature casts a spell, when a watched trait is used, or when an occupant crosses an HP threshold.
- Resolve saves and outcome-specific damage, healing, conditions, chat alerts, and PF2e Effect Items.
- Set a fixed duration, or enter a dice formula such as `2d4` in the existing **X rounds** field. The active GM rolls a formula once when the zone is created, stores the result, and posts the duration to the creator for **Creator only** zones and publicly otherwise.
- Save, share, load, update, and delete presets through the PF2e Zone Library.
- Create, dismiss, and manage zones as a player who owns the selected source Actor while a GM is online. No world macros are required.
- Use **Set Hero Points** to give, spend, or set points and create personal reminders. Players manage only characters they own; GMs manage all player characters.
- Optionally extend Automatic Bonus Progression's attack potency to spell attack rolls through a miscellaneous module setting.
- Equip homebrew **Spell Potency Rings (+1, +2, +3)** from the supplied Equipment compendium for item bonuses to spell attack rolls, without investment.
- Keep GM-only Session Notes in editable Journals, add Quick Notes with portrait-based name insertion, and copy notes with a shared read-aloud recap prompt.

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

### Session Notes and Quick Note

Session Notes is **off by default**. A GM enables it under **Configure Settings → PF2e Zone Automation → Enable Session Notes**. The world setting takes effect immediately for connected clients. Turning it off removes the chat shortcuts, closes the session windows, and blocks the macros, runtime API calls, and new worker writes. Existing Journals, saved session state, and the recap prompt are retained. The prompt remains configurable while the runtime feature is off.

GMs can use the **Session Notes** and **Quick Note** buttons immediately above the chat input controls (the globe/whisper icon row), including in a popped-out chat window, or the macros from the supplied compendium. The shortcuts follow the message editor rather than scrolling with message history. Import the macros onto the hotbar as needed; both entry points call the installed module. An active GM must be online to save changes.

1. Open **Session Notes**, enter a title or session number (or both), campaign Day and time of day, and optionally select the participating characters under **Party**. **Select All** checks every listed character. A blank title becomes **Session X**, using the session number. Choose **Start Session**. One session can be active or paused at a time. Party names are included in the Journal overview and recap notes.
2. Run **Quick Note** during play. Enter inserts a newline. Click a visible Actor's portrait to append their name and return to typing; the list follows the current canvas viewport. Click **OK** to save and close, or **Cancel** to discard the draft.
3. Use **Set Day/Time** to update the manually maintained campaign context. F1 does not advance Foundry's clock, record gameplay automatically, or infer elapsed activity time.
4. **Pause Session** records a real-world break, and **Resume Session** continues the same session. Manual notes and Journal editing remain available during a break. Neither action changes the campaign clock.
5. Use **Open Journal** or a page button to inspect or edit saved notes. **Refresh** reloads saved session details and Journal page links, including changes made in the native editor or by another GM; it resets unsaved form fields. **End Session** records the ending Day/time and stops that session; **Add Addendum** deliberately adds a late note with a chosen occurrence Day/time.
6. Set your shared **Recap Prompt** under **Configure Settings → PF2e Zone Automation → Recap Prompt**. **Copy Notes** combines that prompt with current Journal text for your preferred external LLM. Paste the result into the Journal's **Recap** page.

Session Journals are created in the **Session Notes** folder and are private to GMs. **Marked player-safe** is a review marker and does not share a page. Copy Notes creates a GM package that can contain secrets; review it before giving it to players or an external service. A failed clipboard write opens a selectable copy window. Notes marked **Exclude from recap** and the finished Recap page are omitted.

Unconfirmed Quick Note saves keep the original draft and disable editing so OK can retry exactly the same operation. Cancel can close that draft, but cannot undo a write already sent to Foundry; inspect the Journal before entering it again. Reload recovery covers saved session state and confirmed notes; an unsaved browser draft is not persisted across a tab reload.

The iterative design and live verification checklist are in [Session Notes](docs/session-notes.md).

### Miscellaneous options

Under **Settings → Configure Settings → PF2e Zone Automation → Miscellaneous**, the GM can enable **Apply ABP attack potency to spell attacks**. This optional house rule is off by default and requires the PF2e system's Automatic Bonus Progression variant to be enabled (either mode). Reload the world after changing the setting.

Characters receive a potency bonus to spell attack rolls of **+1 at level 2**, **+2 at level 10**, and **+3 at level 16**. The bonus follows character level automatically, uses normal potency stacking, and respects a character's **Disable ABP** flag. It does not increase spell DCs, spell damage, weapon attacks, or impulse attack rolls, and does not apply to NPCs. Disabling ABP or this option removes the bonus after actor preparation; no permanent Effect Items are added to characters.

### Spell Potency Rings

The **PF2e Zone Equipment** compendium contains three homebrew **Spell Potency Rings**. Drag a ring onto a character's inventory and wear it; no investment or activation is required. While worn, it grants its listed item bonus to spell attack rolls. Multiple rings use normal item-bonus stacking, so only the highest applicable item bonus applies. Spell DCs, spell damage, weapon attacks, and impulse attacks are unchanged.

| Item | Spell attack bonus | Level | Price |
| --- | --- | --- | --- |
| Spell Potency Ring (+1) | +1 item | 2 | 35 gp |
| Spell Potency Ring (+2) | +2 item | 10 | 935 gp |
| Spell Potency Ring (+3) | +3 item | 16 | 8,935 gp |

Each ring matches the corresponding **weapon potency rune** in level and price, and links to that rune in its description. You can upgrade a ring with the higher version's formula by paying the price difference: **900 gp** from +1 to +2, or **8,000 gp** from +2 to +3. Crafting proficiency requirements also match the corresponding runes. The rings do not hold weapon property runes.

PF2e suppresses equipment item bonuses while Automatic Bonus Progression applies to a character. In an ABP world, use the module's **Apply ABP attack potency to spell attacks** option above for the equivalent level-based bonus; the rings follow the system's normal ABP behavior.

### Open the builder

1. Select exactly one token with an Actor.
2. Click **PF2e Zone Builder** in Token Controls, or run the **Open PF2e Zone Builder** macro from the supplied compendium.
3. Confirm the source shown at the top of the builder. If the controlled token changed, select **Use Current Selection**.

A player can create a zone only from an Actor they own. An active GM must be connected when a player creates or dismisses a zone or changes the shared preset library.

### Set up the zone

1. Give the zone a clear name. A name is required.
2. Choose **Emanation** for a circle that follows the source token, **Area - Circle** for a fixed circle, or **Area - Square** for a fixed square. Fixed areas are placed on the Scene after selecting **Create Zone**.
3. Enter the radius for an emanation or circle, or the full side length for a square (for example, **10 feet** for a 10-foot square). Check any combination of **Allies**, **Enemies**, and **Self (Source Actor)**. Select at least one. Previously saved circles and squares reopen with the matching Zone Type and target boxes selected.
4. Leave **Respect line of effect** selected for normal PF2e areas and auras. Closed physical walls and closed doors then prevent a creature from being affected even when its Token is geometrically inside the Region. Opening the barrier makes the creature enter the effective zone; closing it removes effects configured to end on exit. Choose **Ignore line of effect** only when an ability explicitly works through physical barriers. Older saved configurations default to respecting line of effect.
5. Choose **Visible to everyone** or **Creator only**, then add any applicable traits. Creator-only zones and their module chat alerts are visible to the creator; Foundry GMs retain their normal access. Traits begin unchecked.
6. Set the duration. Choose **X rounds** for a positive whole number such as `6` or a dice formula such as `2d4`, or choose **Unlimited** for a zone that remains until ended. Foundry checks the formula syntax before creation. A formula is rolled once when the zone is created, and its result is recorded in a chat message that matches the zone visibility. The source owner can always dismiss a zone early from **Manage Existing Zones**.

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
| **While a creature is inside** | The No Save result should be maintained for occupants, such as an ongoing Effect Item. This trigger cannot share an Effect Block with a saving throw; use a separate block for Entry or another save trigger. Verify damage and healing carefully before using this trigger. |
| **When a creature casts a spell** | A creature inside the zone casts any spell, regardless of its individual traits. Use this for reactions that trigger on spellcasting itself; later attack, damage, or healing roll cards from that cast do not trigger it again. |
| **When a creature uses a selected trait** | A creature inside the zone uses an item, spell, or ability with one of the selected traits. |
| **When a creature drops to or below a Hit Point amount** | An eligible occupant's HP changes from above the entered amount to that amount or lower. Put this trigger in its own Effect Block. It does not fire just because a creature starts inside the zone at low HP. |

If an older preset combines **While a creature is inside** with a saving throw, open it and split those behaviors into separate Effect Blocks. Dismiss and recreate any zone already active with that combination: earlier processing may have applied an unsaved result or spent its repeat allowance. The runtime skips further continuous processing of the combined block.

For [*Cyclone Rondo*](https://2e.aonprd.com/Spells.aspx?ID=1301), choose **Area - Square** with a 10-foot side length and two Effect Blocks: **When the zone is created** for a Reflex save that applies prone on failure or critical failure, and **When a creature enters after creation** for `4d6` damage with a basic Reflex save. Set the damage block to **Every time this happens** if the square may be moved more than once in a round. Use **Move** when the spell is Sustained, and dismiss it if the spell ends before its one-minute maximum. The builder does not track Sustain actions or choose a movement direction automatically.

For **Trait Use Trigger**, select one or more common traits or enter another trait slug. It begins with no selection. The supplied choices cover common reactive-aura cases: energy and healing (**vitality**, **void**, **healing**), sanctification and spirit (**holy**, **unholy**, **spirit**, **divine**), and action or mental effects (**auditory**, **concentrate**, **manipulate**, **move**, **emotion**, **fear**, **mental**).

For an HP reminder about a creature's surrender or flight, select **Self (Source Actor)** for a source-centered emanation, add an Effect Block with the HP trigger, enter the threshold, and enable **Chat Alert**. Use **Once for this zone** when the reminder should appear only once. Chat text can include `{hp}`, `{previousHp}`, and `{threshold}`. Healing above the threshold rearms the crossing when the repeat setting allows it.

For a troop, use two HP Effect Blocks, one for each segment-loss threshold. A troop with 240 HP and printed thresholds of 160 and 80 should use trigger amounts of **159** and **79**, because [Troop Defenses](https://2e.aonprd.com/MonsterAbilities.aspx?ID=86) removes a segment when HP falls *below* a threshold. The module can post the reminders, including both if one hit crosses both thresholds. Choose and remove the affected segment in Foundry yourself; this trigger does not reshape the troop or adjust its maximum HP.

Then choose how often the block can trigger: every time the event happens, once each round, or once for the zone's lifetime. New Effect Blocks default to **Once each round**. For **While a creature is inside**, ongoing Conditions and Effect Items are restored as needed after re-entry; this choice still limits new chat alerts, damage, and healing.

### Define the result

Within an Effect Block, enable only the result sections the ability needs:

- **Chat Alert** posts a message when the block runs. It supports the listed placeholders such as `{creature}`, `{zone}`, and `{item}`.
- **Saving Throw** requests the selected save against a custom DC or a statistic from the source Actor. A custom DC begins blank and is required only when the saving throw is enabled. Select **Basic save** for the normal 0 / half / full / double progression.
- **Damage** and **Healing** post normal PF2e roll cards. Enabled formulas are checked with PF2e's damage-roll parser before the zone can be created.
- **Degree-of-success payloads** apply Conditions or PF2e Effect Items for each save result, or under **No Save** when no save is enabled. Each Condition has its own removal rule. **Normal PF2e handling** leaves it on the Actor after the zone ends; temporary rules remove only the Condition created by that zone. PF2e uses the strongest active value when multiple sources apply the same Condition.
- **Temporary Immunity** prevents later applications for the chosen duration after the selected result.

To apply an Effect Item, drag it from an Actor sheet, the Items list, or a compendium into the relevant result. The builder shows its name and image after resolving it. You can also paste its Item UUID. A missing UUID or an Item that is not a PF2e Effect is rejected before saving or creating a zone. Actor sheet references depend on that Actor remaining available, so use a compendium Effect when you want a reusable template. Each copy uses the zone's source and current target for its PF2e effect context; it does not inherit the original Item's aura or grant links. The supplied Effects are available in the **PF2e Zone Effects** compendium:

| Effect | UUID |
| --- | --- |
| Shadow Raid - Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.WGhBnNhQNH3uVgP1` |
| Focusing Hum Protection | `Compendium.pf2e-zone-automation.zone-effects.Item.j42JjZYGnRM1wf6R` |
| Toxic Cloud – Obscured Vision | `Compendium.pf2e-zone-automation.zone-effects.Item.Qz16EDTu2GVTtUPV` |

Choose the Effect Item removal rule that matches the ability: keep the item's own duration, remove it when the creature exits, or remove it when the zone ends.

### Review, create, and manage the zone

1. Select **Validate** to check the configuration.
2. Select **Post Preview to Chat** to validate and send a readable summary privately to yourself without creating a Region.
3. Select **Create Zone** to create and activate it. For an Area, click the Scene to place its center. Entry effects apply along the straight path between a fixed area's old and new positions. Resizing applies Entry only to newly covered creatures.
4. Use **Manage Existing Zones** to move or dismiss a zone on the active Scene. **Move** is available for fixed areas to the GM and the source Actor's owners; click it, then click the area's new center on the Scene. The module never moves an area automatically. **Dismiss** opens that zone's configuration in the builder so you can edit and recreate it. The current source selection stays in place. If cleanup fails, the zone stays inactive and shows **Cleanup pending**; select **Retry Dismiss** after the underlying problem is resolved. The GM runtime also retries unfinished cleanup after reconnecting.
5. A GM can also see pending saving throws there. Select **Cancel request** to remove an unanswered save without applying an outcome. Its old chat button stops working, and a later eligible trigger can request a new save. If a valid roll is already in chat, its result is applied instead of discarded.

Each save request's chat card has a **Ping target** button. It uses the exact Token for that request and pings its current position, so identically named creatures can be distinguished. This is Foundry's ordinary shared ping: everyone viewing the Scene sees it, even if the Token itself is hidden. After a save is accepted and applied, its card says **save completed** and removes the save buttons, but keeps **Ping target**. View the target's Scene before clicking; unanswered requests that are no longer active and deleted Tokens cannot be pinged.

As you edit, the footer shows **Ready to create** when the configuration has no blocking errors. It also reports **GM connected** for a GM, **Player creation available** when a player can reach an active GM, or **Source token changed** when you need to update the controlled source. Invalid fields receive an inline explanation; warnings remain visible in the validation and preview views but do not prevent creation.

### Save, import, and reuse configurations

Select **Save** to store the current configuration in the shared **PF2e Zone Library** Journal, inside the **PF2e Zone Automation** Journal Entries folder. Use **Save As** to create a new preset without changing the original. **Open** lists available presets. **Clear** resets the editor to a new blank configuration. When a zone was created from a saved preset, dismissing it restores that preset link; **Save** updates the same preset, subject to its creator permissions. **Save As** makes a separate copy. If a preset changes after you open it or create a zone from it, **Save** asks you to reopen the latest version; use **Save As** to keep your current edits separately. Older zones with a preset link but no recorded revision also require **Save As** or **Open** before saving. Zones created before preset linking cannot recover a link automatically.

Eight ready-to-import configurations are included in [`examples/zone-configurations/`](examples/zone-configurations/): Shadow Raid, Frightful Presence, Ghonatine Stench, Courageous Anthem, Focusing Hum, Toxic Cloud, Soul Cutter - Soothe Souls, and Stoke the Fervent.

To use an example, open its JSON file, copy its contents, select a source token, open the builder, select **Import JSON**, paste the configuration, and select **Import**. Adjust the imported values for the selected Actor and encounter before creating the zone. Use **Export JSON** to copy a portable configuration for reuse. Unknown durations and conditions remain visible with validation errors until you choose supported values. Other unsupported choices stop the import with an explanation instead of silently changing it. Older one-round and until-dismissed durations are converted to their current equivalents. On import or opening a saved configuration, the first Effect Block with a given ID keeps it; later duplicates and blocks with missing or blank IDs receive new IDs. Save or export the configuration to keep those repaired IDs. A zone that was already active before this fix keeps its old IDs until you dismiss and recreate it.

## Included Macros

The **PF2e Zone Macros** compendium contains these hotbar-ready Script Macros. They default to **Observer** ownership for players, and their commands call the module API so the underlying logic updates with the module.

| Macro | What it does |
| --- | --- |
| **Open PF2e Zone Builder** | Opens the zone builder for the one controlled source token. |
| **Shielding Taunt** | For a Guardian with Shielding Taunt and a wielded shield, raises the shield, applies PF2e's auditory Taunt effect to one targeted creature, and replaces that Guardian's prior Taunt. |
| **Set Hero Points** | Give, spend, or set an exact total, with current and resulting totals shown before applying. Players see only characters they own; GMs see all player characters. Create reminders whispered only to their creator. |

Run **Set Hero Points** from the **PF2e Zone Macros** compendium or drag it to your hotbar. Choose **Give 1 hero point**, **Spend 1 hero point**, or **Set hero points to 0**, **1**, **2**, or **3** from the single **Hero points** dropdown. Players see and can change only characters they own; GMs can manage all player-owned characters. Check the characters to update, review the **After** column, then apply. Eligible characters with selected tokens are checked automatically; **Select all** and **Clear** change the selection. Characters do not need a token on the current Scene. If no eligible characters are available, the macro displays an error instead of opening the dialog. Changes are processed by the active GM and summarized privately to the requester and GMs. The apply and **Cancel** buttons stay above **Award reminder** while the character controls scroll.

To receive a private award reminder, enter **Reminder time (local)** and click **Create reminder**. This uses your computer's clock and the next occurrence of that time, today or tomorrow. The reminder whispers only to its creator. A GM reminder says it is time to award everyone 1 Hero Point; a player reminder says it is time to award their characters 1 Hero Point. The reminder button opens the same **Set Hero Points** dialog with that user's permitted characters. Creating a reminder keeps the dialog open and does not change anyone's points. Reminders survive refreshes; Foundry must have an active GM online to save, clear, and deliver them, and missed reminders appear when a GM returns.

When you have pending reminders, **Clear Reminders** appears beside **Create reminder**. It removes all your pending Hero Point reminders and keeps the dialog open.
