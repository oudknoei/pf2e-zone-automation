# Zone Builder design

Implementation reviewed: 2026-10-12, module 0.1.60. This document covers the editor, shared preset library, Region creation and management, and the runtime that makes those configurations work. Open issues and Wall proposals are tracked in [TODO.md](../TODO.md).

## Purpose and scope

Build reusable PF2e emanations and fixed areas, then automate configured creature effects through Foundry v14 Regions. Preserve compatibility with older zone configurations and existing `world.pf2eZone` Regions. Players can operate zones from Actors they own while a GM is online; GMs can operate directly.

The builder configures explicit triggers and outcomes. It does not infer a complete spell from its name, spend actions, maintain Sustain automatically, or create physical Foundry Walls. Damage and healing produce PF2e chat roll cards; applying the resulting HP changes remains part of the normal system workflow.

## Entry and editor workflow

Open from **PF2e Zone Builder** in Token Controls or the **Open PF2e Zone Builder** macro, which calls `game.modules.get("pf2e-zone-automation").api.openBuilder()`. The macro uses `assets/macros/pf2e-zone-builder.webp`. Require PF2e, an active canvas Scene, and exactly one controlled token with an Actor.

Capture the source Actor and token. Show their identity and require **Use Current Selection** if the controlled token changes. A player's privileged request must confirm source ownership on the GM client. Footer status distinguishes valid configuration, changed source, and availability of player-to-GM creation.

1. Name the zone and choose its geometry, targets, visibility, traits, and duration.
2. Add one or more Effect Blocks, each with explicit triggers, repeat policy, and results.
3. Validate inline or use **Validate** for the complete errors/warnings. **Post Preview to Chat** privately shows a human-readable summary without creating a Region.
4. Save a reusable preset, or use **Create Zone** to place and activate it.
5. Use **Manage Existing Zones** for movement, dismissal, or GM pending-save cleanup.

Errors prevent mutation; warnings remain visible without preventing creation. Freeze click-time configuration, source, Scene, preset revision, and editor revision before asynchronous validation. Guard duplicate clicks and ignore obsolete responses after a later editor change. Do not overwrite newer edits with an earlier Save response.

## Configuration model

Configurations use schema version 16 in `scripts/zone-config.js`. Normalization supplies missing legacy fields and repairs duplicate/missing Effect Block IDs. Strict import/creation validation rejects unsupported supplied choices rather than silently substituting defaults. Older one-round and until-dismissed duration choices migrate to current equivalents.

| Configuration area | Behavior |
| --- | --- |
| Geometry | Source-following emanation, fixed circle, or fixed square; radius for circles, full side length for squares |
| Targeting | Explicit Allies, Enemies, and Self selection; require at least one; default to respecting line of effect |
| Visibility | Everyone or creator only, with normal GM access preserved |
| Traits | Explicit zone trait slugs; no initial selections |
| Duration | Unlimited or positive rounds/dice formula; legacy one/ten-minute types remain supported in normalization |
| Activation choice | Optional shared damage type chosen once for the whole activation |
| Effects | Independently identified blocks containing triggers, repeat policy, save, chat alert, damage/healing, outcomes, and immunity |

Each block starts without an enabled trigger or hidden payload. The default repeat limit is once per round. Supported triggers are activation, entry, target turn start/end, source turn start, continuous presence, spellcasting, watched trait use, and crossing an HP threshold from above to at-or-below.

HP threshold triggers belong in their own block and use observed HP changes; a creature that begins inside at low HP does not trigger immediately. Spellcasting and trait-use detection use PF2e chat context to avoid repeating the same cast on later attack/damage cards.

An enabled save uses a selected save statistic or permitted choice and a custom/source-statistic DC. Basic saves provide the usual damage multipliers; outcome-specific conditions and Effect Items can still be configured. Continuous presence must use No Save and cannot share a block with a saving throw. Older active zones with that invalid combination skip further continuous processing until corrected and recreated.

Damage and healing formulas are validated with the available roll parsers before committing. Conditions carry values where appropriate and explicit removal policies. Effect Items must resolve to a PF2e Item of type `effect`; preserve source/target context for each copy and avoid inherited aura/grant links. Temporary immunity starts on configured results and can be scoped to a block or an explicitly named shared immunity group.

## Preset library

Store shared presets in **PF2e Zone Library**, inside the **PF2e Zone Automation** Journal folder, with a readable index page. The authoritative data is the Journal's `world.pf2eZoneLibrary` flag; index rendering failure must not hide an already committed save. The worker repairs older library placement and page metadata as needed.

Each record carries ID, name, normalized config, creator/modifier identities, timestamps, and a revision. All active users can load presets through the GM worker without Journal write permission. Only the creator or a GM can overwrite/delete a record; require an exact expected revision. **Save As** creates a new record owned by the requester. The **Load** control uses that exact concise label.

Serialize library reads/writes on the active GM to avoid lost concurrent changes. Export/import JSON for portability; preserve unsupported condition/damage choices as visible validation issues where supported by the editor. A loaded configuration keeps its preset origin and revision. Dismissing a zone restores the revision it actually used, so an older zone cannot silently overwrite a newer preset.

Library serialization currently prevents overlap within one active-GM client but does not make a timed-out Save As idempotent. Track operation identity and uncertain acknowledgments as described in TODO.md.

## Region creation and persistence

Both direct GM and worker creation call `createZoneDocument`. Repeat strict configuration validation and resolve Effect Item references on the mutation path. Resolve a dice-formula duration once, record its rounds, and announce the formula/result with the zone's visibility. Activation or announcement failure after Region creation returns the committed Region with a warning rather than inviting duplicate creation.

Use `RegionDocument.createTokenEmanation` for emanations and a placement adapter for fixed areas. New Region payloads include `displayMeasurements: true`, configured visibility/ownership, one module runtime behavior, and `flags.world.pf2eZone`:

| Payload field | Responsibility |
| --- | --- |
| `runtimeVersion` | Runtime migration compatibility |
| `config` | Normalized zone definition |
| `state` | Source and creator identity, creation operation, preset origin/revision, duration clocks, activation progress, saves, repeats, immunities, applied items, HP baselines, and roll batches |

Region behavior events call the installed `api.handleRegionEvent` rather than embedding a frozen runtime implementation. Keep legacy Regions compatible with the shared singleton and retained world flags.

Player requests carry a frozen creation operation ID and area center. Join concurrent identical requests and reuse the ID on timeout retry; locate an already-created Region using persisted operation and creator identity after a GM refresh. The current durable lookup does not persist/check the complete request fingerprint, which is an open correctness issue in TODO.md.

Placement must use the intended Scene, release input listeners on completion/cancellation, and consume the placement click without moving a token. The GM uses Foundry Region placement; the player chooses a center before the GM constructs the fixed footprint.

## Runtime processing

`PF2EZoneRuntime` is a versioned singleton with one hook registry. Runtime upgrades tear down the old hooks/timers, retain compatible APIs, and avoid downgrading a newer runtime. Every client receives hooks, but only the active authoritative GM should apply zone effects.

Serialize state changes per Region. Read a current payload inside the lock, perform the transaction, replace the complete persisted flag using Foundry v14 replacement semantics, and execute deferred actions only after commit. Prune completed save and damage/healing history when no unresolved save needs it. Local locks need authority rechecks across handoff; the reproduced queued-work gap is in TODO.md.

For each trigger, check operational state, target eligibility, physical line of effect, temporary immunity, and repeat policy. Continuous effects restore maintained conditions/Effect Items after re-entry even when repeat limits suppress new alerts or damage/healing. Preserve conditions from unrelated sources and let PF2e determine the effective strongest value.

Persist a pending-save identity before posting its actionable chat card. Route valid rolls back to that exact pending record, checking Actor, identifier, author/ownership, and outcome. Complete a save once and update its card. Recover failed save-card delivery and already completed rolls after reconnect. Keep **Ping target** tied to the exact token and current Scene position, subject to existing request validity.

Tie duration clocks to the source's matching Scene combat, not the GM's unrelated viewed encounter. Store world-time expiry and combat progress/deadlines, recover missed turn updates, and avoid restarting duration when combat changes. End finite zones at the deadline and source-following emanations when their source disappears.

Startup/handoff reconciliation repairs linked conditions, orphaned Items, shared immunities, retained history, unfinished dismissal/exit cleanup, completed/undelivered saves, durations, activation, and HP baselines. Isolate errors in each repair step so one failure does not prevent the remaining recovery work.

## Manage Existing Zones and display

List only module Regions on the active Scene. Allow a GM or source Actor owner to dismiss; fixed-area **Move** uses the same ownership rule and is unavailable for emanations or a zone awaiting cleanup.

Move closes the manager and builder before selecting a new center. Escape or successful placement returns to normal play. Translate the Region's live shapes to preserve resizing, dimensions, and rotation; never rebuild geometry from the saved config. Normal Region updates drive swept-path Entry processing, including creatures crossed between the old and new positions. Boundary suppression avoids double delivery from corresponding native events.

Dismiss stops new work, drains accepted state changes, persists inactive/cleanup-requested state, removes only zone-owned linked effects, and then deletes the Region. Failure leaves a quiet Region marked **Cleanup pending** with **Retry Dismiss**; reconnect also retries unfinished cleanup. Successful dismissal reopens the definition for editing without changing the selected source.

GMs can see pending save rows and use **Cancel request**. Remove only the exact unresolved save and its repeat marker. If a valid completed roll is already in chat, apply it rather than discard it. A later eligible trigger can create a fresh request, and the old card no longer accepts saves.

Draw module Regions as a dark outer boundary with a colored inner boundary and no interior fill. Wrap Foundry's rendering through libWrapper, redraw on geometry/Scene changes, and suppress native fill only when an outline exists. Fall back to native rendering on failure; unrelated Regions retain their normal rendering. Accept Foundry Color objects, numbers, and CSS hex colors.

## Implementation map and validation

| File | Responsibility |
| --- | --- |
| `scripts/builder.js` | Editor, validation presentation, preview, placement, library and manager dialogs |
| `scripts/zone-config.js` / `config-input.js` | Schema, normalization, supported choices, and input validation |
| `scripts/zone-creation.js` | Shared validation, Region payload, duration resolution, and activation |
| `scripts/worker.js` / `transport.js` | Authenticated GM operations, library authorization, and retries |
| `scripts/runtime.js` | Trigger processing, state transactions, saves, applied effects, and lifecycle recovery |
| `scripts/area-shape.js` / `line-of-effect.js` / `targeting.js` | Geometry, swept movement, barriers, and recipient selection |
| `scripts/duration*.js` / `scene-combat.js` | Time and encounter clocks |
| `scripts/effect-items.js` / `dc.js` / `hp-threshold.js` | Item validation, source DCs, and HP crossings |
| `scripts/zone-outline.js` / `styles/pf2e-zone.css` | Canvas outline and dialog presentation |
| `scripts/main.js` / `packs/src/zone-macros/open-pf2e-zone-builder.json` | Registration and thin macro |

The automated suite covers editor/source races, validation, library concurrency/revisions, creation retries, saves and authorization, source conditions, immunity, duration recovery, deletion, movement, line of effect, and outlines. Refactoring must preserve those contracts and add regressions for the review findings.

Live Forge checks remain necessary for actual Region containment, token-following emanations, placement cancellation, moved/resized/rotated areas, physical barriers, PF2e condition interaction, outline appearance, and multi-client GM handoff. The optional local integration harness in `tests/foundry` requires a licensed installation; it is not an installation requirement for a Forge user.
