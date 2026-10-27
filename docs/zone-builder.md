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

`scripts/builder.js` remains the public entry point and delegates to `builder-controller.js`. The controller owns source selection, editor state, mutation reservations, validation, effect lookups, creation, canvas placement, event bindings, and close-time cleanup. A per-dialog editor facade lets the preset and manager controllers update configuration/preset state without owning the source or mutation guard. Preset operations retain their frozen uncertain save request inside their own controller; multiple open builders do not share retry state. The manager owns permission checks and active-zone actions, including closing its dialog and the originating builder before terminal Move placement.

The view module renders editor fields, summaries, previews, JSON/validation/activation dialogs, shared presets, and managed zones from supplied data. Capture source names/images, configuration, choices, and permission/selection results in an explicit rendering model. Views perform no document operations, read no Foundry globals, and do not mutate their inputs. The catalog adapter resolves current PF2e labels, and the controller captures source statistic choices; form readers preserve the existing normalized configuration contract. The DOM view adapter applies derived readiness, errors, effect details, visibility, and the editor's native-footer suppression. Controllers retain action-time validation and permission checks.

All static presentation rules are in `styles/pf2e-zone.css`, including the saved-zone/manager lists, JSON textareas, activation spacing, and preview opacity. Templates inject no style blocks or inline presentation rules. Dynamic visibility and canvas interaction still use their existing show/hide behavior. Preserve the exact labels, helper text, selectors, conditional controls, custom sticky footer, and terminal placement workflow.

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

`createPresetRepository` in `scripts/preset-repository.js` owns Journal/folder discovery and repair, flag replacement, index rendering, record permissions, and revision checks. Each worker creates one repository instance with its own ordered operation queue and ten-minute save cache. Requests receive their existing worker response shape at the dispatch boundary. The repository freezes and authenticates each save before reserving its operation; all list/save/delete operations read the current flag after preceding library work finishes. Region creation delegates its preset-origin existence check to the same discovery and repair path.

Each record carries ID, name, normalized config, creator/modifier identities, timestamps, and a revision. All active users can load presets through the GM worker without Journal write permission. Only the creator or a GM can overwrite/delete a record; require an exact expected revision. **Save As** creates a new record owned by the requester. The **Load** control uses that exact concise label.

Serialize library reads/writes on the active GM to avoid lost concurrent changes. Export/import JSON for portability; preserve unsupported condition/damage choices as visible validation issues where supported by the editor. A loaded configuration keeps its preset origin and revision. Dismissing a zone restores the revision it actually used, so an older zone cannot silently overwrite a newer preset.

Freeze a save operation ID and its full request before sending **Save** or **Save As**. A timeout, transport failure, or unconfirmed Journal write retains that attempt while the builder remains open. Enable the same save control to confirm the earlier request and disable switching to the other kind of save until confirmation. Retry the frozen request even if the editor has changed; apply its response only when the original editor snapshot is still current. Otherwise keep the newer edits and report that the earlier preset was saved. An ordinary worker rejection releases the attempt. Closing or reloading the builder loses its local pending attempt; review the library before starting a fresh save in that case.

Copy incoming requests before queueing. Matching requester/operation IDs join one GM-client request for ten minutes; reject reuse with different details. Canonical fingerprints include requester, record ID, expected revision, source Actor UUID, and the full accepted raw configuration. Sort object keys without changing array order or the existing creation fingerprint format.

Keep the library schema at version 1 and add an optional `saveOperations` map, empty for older libraries. Each completion receipt records the operation/requester IDs, fingerprint, completion time, and original client-visible record snapshot. Commit the receipt and preset together in one Journal flag replacement. Identified **Save As** requests use a stable record ID based on requester and operation, allowing independent workers to converge on one record. Validate receipt metadata and compare its fingerprint before returning a completion; missing or incomplete proof requires review rather than another creation or inferred success.

An authenticated repeat request returns its original record ID and revision before revalidating source ownership or Effect Item references. This read-only recovery survives GM refresh, cache expiry, and handoff, and does not change later preset edits or recreate a deleted record. Retain completion receipts, including historical configuration snapshots, for the library's lifetime; deletion removes the current preset but not its receipt. The library therefore grows with completed saves.

If the write acknowledgment fails, confirm completion from the exact stored receipt. If the write remains unconfirmed, return the retryable `PF2E_ZONE_PRESET_SAVE_UNCERTAIN` error so the builder retains its request. Index rendering failures remain warnings after a confirmed commit. Legacy worker callers without an operation ID keep their existing behavior and do not receive retry guarantees. Queues serialize one active-GM client; a document write already dispatched by an earlier GM can still finish after handoff.

## Region creation and persistence

Both direct GM and worker creation call `createZoneDocument`. Repeat strict configuration validation and resolve Effect Item references on the mutation path. Resolve a dice-formula duration once, record its rounds, and announce the formula/result with the zone's visibility. Activation or announcement failure after Region creation returns the committed Region with a warning rather than inviting duplicate creation.

Use `RegionDocument.createTokenEmanation` for emanations and a placement adapter for fixed areas. New Region payloads include `displayMeasurements: true`, configured visibility/ownership, one module runtime behavior, and `flags.world.pf2eZone`:

| Payload field | Responsibility |
| --- | --- |
| `runtimeVersion` | Runtime migration compatibility |
| `config` | Normalized zone definition |
| `state` | Source and creator identity, creation operation and request fingerprint, preset origin/revision, duration clocks, activation progress, saves, repeats, immunities, applied items, HP baselines, and roll batches |

Region behavior events call the installed `api.handleRegionEvent` rather than embedding a frozen runtime implementation. Keep legacy Regions compatible with the shared singleton and retained world flags.

Player requests carry a frozen creation operation ID and area center. The worker copies the request before awaiting and uses one versioned, canonical JSON fingerprint for both its ten-minute cache and `state.creationFingerprint`, saved with `state.creationOperationId` in the initial Region payload. Include requester, Scene, source token, complete accepted configuration, preset ID/revision, activation choice, color, and area center. Sort object keys recursively, retain array order, and treat absent optional fields as null. Fingerprint the accepted raw configuration rather than repaired or subsequently edited Region data.

After refresh, cache expiry, or GM handoff, search Regions across all Scenes by operation ID and creator. Reuse a completion only when the full fingerprint and owning Scene match. Changed requests fail without creating another Region, repeating activation, rerolling duration, or undoing later movement or configuration edits. Recover the original stored duration result for an identical retry.

Older Regions without a usable fingerprint remain playable and manageable. Reject an uncertain creation retry against their operation marker with instructions to review **Manage Existing Zones** before creating another. Do not infer the original request from live Region data, backfill an unverified fingerprint, or create a duplicate to repair missing metadata. Requests without an operation ID retain their existing creation behavior.

Placement must use the intended Scene, release input listeners on completion/cancellation, and consume the placement click without moving a token. The GM uses Foundry Region placement; the player chooses a center before the GM constructs the fixed footprint.

## Runtime processing

`PF2EZoneRuntime` is a versioned singleton with one hook registry. Runtime upgrades tear down the old hooks/timers, retain compatible APIs, and avoid downgrading a newer runtime. Every client receives hooks, but only the active authoritative GM should apply zone effects.

Runtime 0.5.22 composes separate state, authority, lifecycle, hook, save, and effect services on the same singleton object. Service factories create fresh transient state only when constructing a runtime; their methods call other services through that shared receiver. Preserve all existing method names and fields, including methods used by legacy Region scripts and direct management. The entry point keeps explicit event dispatch, singleton reuse, upgrade retirement, and newer-runtime protection. Region creation and test stubs use the same version constant. Each runtime owns its own non-persisted authority-lease Symbol; services do not create independent lease identities or hook registries.

The state service owns payload normalization, complete flag replacement, retained roll/save history, Region locks, shared-world-state queues, and after-commit actions. The authority service owns generations and lease validation. The lifecycle service owns source/target resolution, activation, expiry, deletion/exit cleanup, condition dependencies, and coordinated startup/handoff recovery. Hooks, pending-save delivery/resolution, and applied Items/conditions/damage/healing each have their own service. Trigger, targeting, occupancy, immunity, and movement policy remain in `runtime.js`. This extraction changes code ownership without changing the stored `world.pf2eZone` format or gameplay rules.

Serialize state changes per Region. Capture the accepting GM's authority lease before waiting, read a current payload inside the lock, and retain that lease across nested calls and fresh payload reads. Revalidate when queued work starts, before Item/chat changes and Region/world-state persistence, and before deferred actions. Replace the complete persisted flag using Foundry v14 replacement semantics and execute deferred actions only after commit. Prune completed save and damage/healing history when no unresolved save needs it.

Observed active-GM or current-user changes invalidate earlier leases, cancel old timers, and clear transient occupancy/alert caches. Runtime retirement also invalidates accepted work. The new authority can start a fresh recovery pass and reconstruct activation deadlines and undelivered save cards. Direct GM dismissal remains deliberately unscoped so secondary-GM management works. A Foundry document operation already dispatched may still finish after handoff; the runtime cannot recall it, but stops subsequent effects, stale commits, and follow-up actions as control returns.

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
| `scripts/builder.js` | Stable public builder entry point |
| `scripts/builder-controller.js` | Editor/source state, mutation guards, validation, bindings, placement, creation, and cleanup |
| `scripts/builder-view.js` | Pure templates, dropdowns, summaries, previews, and auxiliary/list dialogs |
| `scripts/builder-dom-view.js` | Derived status, inline errors, effect details, visibility, and native-footer presentation |
| `scripts/builder-form.js` / `builder-catalog.js` | Form-to-configuration reads and current PF2e choice/label adapters |
| `scripts/builder-preset-controller.js` | Shared preset load/save/delete operations and per-dialog frozen retry state |
| `scripts/builder-manager-controller.js` | Existing-zone permissions, pending-save cancellation, dismissal, and terminal Move |
| `scripts/zone-config.js` / `config-input.js` | Schema, normalization, supported choices, and input validation |
| `scripts/zone-creation.js` | Shared validation, Region payload, duration resolution, and activation |
| `scripts/worker.js` / `transport.js` | GM operation dispatch, authenticated socket requests/responses, and creation/Taunt retries |
| `scripts/worker-action-policy.js` | One immutable action-to-handler and GM authority policy shared by dispatch and transport |
| `scripts/worker-permissions.js` | Active requester lookup and source-Actor ownership checks shared by worker and repository |
| `scripts/preset-repository.js` | Journal discovery/repair, flag replacement, index rendering, record authorization/revisions, library queue, and save recovery |
| `scripts/preset-save.js` / `utils.js` | Full preset-save fingerprints and stable JSON serialization shared with creation |
| `scripts/runtime.js` | Singleton composition, trigger/targeting/occupancy/immunity policy, movement, and event dispatch |
| `scripts/runtime-state.js` | Payload normalization/replacement, history, Region/shared-state locks, and after-commit ordering |
| `scripts/runtime-authority.js` | GM authority generations and transient leases |
| `scripts/runtime-lifecycle.js` | Activation, expiry, source/target resolution, cleanup, and coordinated recovery |
| `scripts/runtime-hooks.js` | Foundry hooks, chat buttons, and teardown |
| `scripts/runtime-saves.js` | Save authorization, pending cards, delivery recovery, cancellation, and resolution |
| `scripts/runtime-effects.js` | Owned Items/conditions, damage/healing rolls, outcome application, and effect-record deletion |
| `scripts/runtime-constants.js` / `runtime-helpers.js` | Shared version/flag identities, clocks, state keys, signatures, and version comparison |
| `scripts/area-shape.js` / `line-of-effect.js` / `targeting.js` | Geometry, swept movement, barriers, and recipient selection |
| `scripts/duration*.js` / `scene-combat.js` | Time and encounter clocks |
| `scripts/effect-items.js` / `dc.js` / `hp-threshold.js` | Item validation, source DCs, and HP crossings |
| `scripts/zone-outline.js` / `styles/pf2e-zone.css` | Canvas outline and dialog presentation |
| `scripts/main.js` / `packs/src/zone-macros/open-pf2e-zone-builder.json` | Registration and thin macro |

The automated suite covers editor/source races, validation, library concurrency/revisions, creation retries, saves and authorization, source conditions, immunity, duration recovery, deletion, movement, line of effect, and outlines. Creation fingerprint regressions cover every changed request field after fresh worker imports, cache expiry, object-key ordering, raw-config repair, request snapshots, legacy metadata, creator isolation, GM handoff, rolled duration recovery, and later Region edits. Twenty-three preset-save regressions cover lost/unconfirmed acknowledgments, joined operations, repeated overwrites, changed fingerprints, historical results after deletion, incomplete receipts, queued snapshots, independent workers, GM handoff, index warnings, and builder retries that preserve newer edits. All 421 tests and full ESLint pass on 2026-10-13. Refactoring must preserve those contracts and add regressions for the review findings.

Service extraction verified on 2026-10-14: all 426 automated tests and full ESLint pass. A one-time parser comparison confirmed that all 182 runtime members retained their definitions during extraction. Three additional regressions cover singleton re-entry with explicit event dispatch, upgrade retirement of queued work and timer/hook state, and preserving a newer installed runtime. Existing tests continue to cover legacy payload normalization, replacement/no-op writes, after-commit ordering, handoff, cleanup retries, save authorization/delivery, condition ownership, and shared immunity.

Builder separation verified on 2026-10-14: all 433 automated tests and full ESLint pass. Seven additional regressions cover rendering frozen models without Foundry globals, form round-trip preservation, literal text and list permissions, computed stylesheet rules, independent uncertain saves in two open builders, and both successful and cancelled terminal Move selection. Synthetic canvas tests verify that both dialogs stay closed, live resized/rotated shapes are translated, cursor/input handling is restored, and ordinary play clicks are no longer intercepted. A one-time parser comparison preserved the logic of 17 critical operation functions, accounting only for references through the editor facade. Existing DOM workflows continue to cover exact wording, Item drops/lookups, import, validation, preview, saved revisions, retries, and close-time hook cleanup.

Preset repository and worker policy extraction verified on 2026-10-14: all 441 automated tests and full ESLint pass. Eight additional regressions cover creator/GM record permissions and stale deletion revisions, inactive requesters on cached completions, ordered reads after an outstanding save, folder/index repair with escaped preset text, routing all shared actions through the active GM, direct GM zone operations without a socket, dispatch coverage and the no-active-GM fallback, and rejecting inherited action names. A one-time parser comparison preserved 15 repository operation bodies, two permission helpers, and six zone operation bodies, allowing only explicit request parameters, response wrapping, shared permission calls, and delegated preset lookup. Existing concurrency and retry tests continue to exercise separate worker instances, refresh/handoff recovery, lost acknowledgments, and durable receipts.

`scripts/worker-action-policy.js` defines each supported action once with its handler and GM authority. Shared-library, save-cancellation, Shielding Taunt, Hero Point, and reminder requests go to the active GM when one is elected. Zone creation, movement, dismissal, and ping retain direct GM execution. A GM without an elected active GM still takes the existing direct fallback; feature workers can enforce stricter authority requirements. Player requests always use the GM socket. Unknown actions are rejected before handler lookup, and feature-specific requester permissions remain in their operation/repository checks. The socket still authenticates its sender independently of the request's claimed user ID and accepts replies only from the addressed GM.

The user reported live Forge verification complete on 2026-10-14 for the implementation preceding these refactors. The runtime, builder, and repository/policy refactors were verified locally; no live Foundry session was run during these extractions. The optional local integration harness in `tests/foundry` requires a licensed installation; it is not an installation requirement for a Forge user.
