# Shielding Taunt design

Implementation reviewed: 2026-10-12, module 0.1.60. This document describes the implemented workflow and its intended guarantees. Open issues are tracked in [TODO.md](../TODO.md).

## Purpose and scope

Give a Guardian one macro that raises their wielded shield and applies the PF2e Taunt effect to the targeted creature. Use the system's action and Effect Item so PF2e owns the underlying modifiers and duration. The module handles selection, range, permissions, replacement, and recovery.

The macro is a convenience for performing the action. It does not spend an action, check the target's hearing, enforce encounter timing, or adjudicate every circumstance that can prevent an auditory action. Those decisions remain with the GM.

## Entry points and player workflow

The **Shielding Taunt** Script Macro in **PF2e Zone Macros** calls `game.modules.get("pf2e-zone-automation").api.openShieldingTaunt()`. Its icon is `assets/macros/shielding-taunt.webp`.

1. Control exactly one Guardian token and target exactly one creature.
2. Run the macro. There is no additional confirmation dialog.
3. The client sends the token UUIDs, requester identity, and operation ID to the authoritative GM.
4. The GM validates and applies the action, then posts a public action announcement. The requester receives success or an actionable error; a chat-only failure is a warning after mechanical success.

The public API also exposes `requestShieldingTaunt(sourceTokenUuid, targetTokenUuid, { operationId })` for callers that need an explicit operation identity.

## Mechanical processing

Before starting a new replacement, validate that the requester owns the Guardian's Actor or is a GM, both tokens have Actors and belong to the same Scene, and the Guardian is not the target Actor. Find **Shielding Taunt** by item slug, with an exact-name fallback. Require a wielded shield that is neither broken nor destroyed.

The implemented range is 30 feet, or 120 feet when the Guardian has **Long-Distance Taunt**. Measure from TokenDocuments on their owning Scene rather than the GM's viewed canvas. Square-grid measurement accounts for token bounds, small tokens, elevation, and PF2e diagonal distance. Other grids use the Scene grid's path measurement. Reject an unavailable or nonfinite measurement.

Load these system documents:

| Document | UUID |
| --- | --- |
| Taunt action | `Compendium.pf2e.actionspf2e.Item.4DYFJ4TUsNkgFBDb` |
| Taunt Effect Item | `Compendium.pf2e.feat-effects.Item.FlyWq9znOHvpISNW` |

Call PF2e's Raise a Shield action only when the shield is not already raised; the system action toggles its effect, so a second call must not lower it. Confirm that the raised state was applied before continuing.

Copy the Taunt Effect Item onto the target Actor. Set its traits to `auditory`, and set its PF2e origin and target context to the actual Guardian, source token, Taunt action, target Actor, and target token. Carry origin roll options from the Guardian and action. Retain the official item's rules and duration.

Create the replacement before removing previous Taunts from this Guardian. Search both world Actors and Scene token Actors, including synthetic Actors. Match the official Effect Item source ID and Guardian origin Actor UUID; preserve another Guardian's Taunt. After cleanup, only the chosen replacement from this Guardian should remain.

## Operation identity and failure handling

The client reserves an operation before awaiting the GM. Concurrent requests from the same source to the same target share the pending promise. After a timeout or explicitly retryable cleanup failure, retain the same operation ID and target. Prevent changing targets until that uncertain operation is retried. A deliberately supplied operation ID leaves retry identity management to the caller.

The worker joins identical requests in a ten-minute cache and rejects changed details under the same ID. A per-Guardian promise chain orders different Taunts in one GM client. Persist operation metadata on the replacement Effect Item and completed announcement:

| Flag | Role |
| --- | --- |
| `world.pf2eZoneShieldingTaunt` | Replacement identity, request details, and result on the Effect Item |
| `world.pf2eZoneShieldingTauntMessage` | Completed operation identity and result on the ChatMessage |

A retry can recover an existing replacement after interrupted cleanup, or return a completed operation after a refresh. It must not restore an older target after a newer Taunt has completed. Recovery compares requester, source token, target token, and Actor identities.

Trust a chat completion only when its actual author resolves to a GM in the world's User collection and its marker includes the full request identity and a valid Shielding Taunt result. Ignore player-authored, unknown-author, or incomplete markers before checking reused IDs. Announcements may be public. Inactive GM authors and legacy `user` fields remain valid when the canonical `author` field is absent; claiming a GM role inside flags or an author object does not grant trust. New announcements explicitly record the executing GM as author.

If deleting previous Taunts fails, inspect live state because the deletion might already have committed. If old Taunts remain, try to remove the replacement. A failed compensation is explicitly retryable using the same request. Raising the shield is not rolled back. Failure to post the announcement does not undo a successful Taunt.

These caches and queues are local to a GM tab; they are not a server transaction. Automated completion recovery covers refresh and handoff without restoring an older target. Handoff during effect replacement and the server's player-create/flag-update permission boundary still need live Foundry/Forge validation.

## Implementation map and validation

| File | Responsibility |
| --- | --- |
| `packs/src/zone-macros/shielding-taunt.json` | Thin macro and icon |
| `scripts/shielding-taunt.js` | Selection, request reservation, and user notifications |
| `scripts/shielding-taunt-worker.js` | Range, system action, effect replacement, and recovery |
| `scripts/worker.js` | Requester ownership and request cache |
| `scripts/transport.js` | Authenticated active-GM routing |
| `scripts/main.js` | Public API registration |

Automated coverage lives in `tests/shielding-taunt.mjs`, `tests/transport.mjs`, and `tests/macro-pack.mjs`. Preserve off-screen Scene measurement, range boundaries, replacement ordering, duplicate retries, cleanup compensation, ownership rejection, forged and incomplete completion rejection, genuine post-refresh/handoff recovery, and chat-failure isolation.

Live Foundry/Forge checks should include a player-owned Guardian on a Scene the GM is not viewing, an already raised shield, a broken shield, two Guardians, and a GM handoff during replacement. Verify the official PF2e effect actually expires and modifies rolls as intended; local document mocks do not establish that behavior.
