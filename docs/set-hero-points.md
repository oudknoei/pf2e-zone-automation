# Set Hero Points design

Implementation reviewed: 2026-10-12, module 0.1.60; point serialization and stale-retry handling updated 2026-10-13. This document covers point changes and the associated award reminders. Open issues are tracked in [TODO.md](../TODO.md).

## Purpose and access

Let a GM give, spend, or set Hero Points for explicitly selected player characters, with a preview before committing. Provide private reminders to award points later without automatically changing resources.

The **Set Hero Points** macro calls `game.modules.get("pf2e-zone-automation").api.promptSetHeroPoints()`. Its icon is `assets/macros/SetHeroPoints.webp`. Although the compendium macro has player Observer ownership, the dialog and mutation functions reject non-GMs.

Eligible recipients are world Actors of type `character` with `hasPlayerOwner`. They do not need a token on the viewed Scene. Sort by name. If none exist, show an error and do not open a dialog. Keep one rendered dialog per tab and bring it forward on another invocation.

## Dialog workflow

Use one **Hero points** dropdown:

| Choice | Operation |
| --- | --- |
| Give 1 hero point | Add one |
| Spend 1 hero point | Remove one |
| Set hero points to 0 / 1 / 2 / 3 | Replace the total |

List each character with a checkbox, **Current**, and **After** totals. Preselect all eligible characters whose tokens are controlled; duplicate tokens do not duplicate recipients. **Select all** and **Clear** change the checked set. The apply button uses the chosen operation's wording and remains above the **Award reminder** section with **Cancel**.

Changing the operation or recipients updates the preview. Disable Apply when no recipients are selected or no totals would change. Clamp values to zero through the smaller of the Actor's configured maximum and three. Update `system.resources.heroPoints.value`, rather than storing a separate module resource.

On Apply, freeze recipients, action, amount, and an operation ID, and prevent a second submission while writes are pending. Send Actor IDs through the authenticated worker transport to `game.users.activeGM`, including submissions from another GM tab. The worker checks that the requesting user is an active GM and each recipient remains an eligible player character. Calculate each total from the current resource inside a per-Actor queue. Independent changes to the same Actor run in order; an unrelated Actor does not wait for that queue. Recheck GM authority when queued work begins.

Collect write failures and whisper a summary of successfully changed totals to all GMs, attributed to the requesting GM. Announce only changes completed in that attempt. Summary delivery failure returns a warning after the resources have changed. If every write succeeds, close the dialog. Cancel before applying changes nothing.

When some writes fail, leave the dialog open with **Retry update**. The worker retains the before value, bounded maximum, preceding module-operation receipt, and exact target total for each attempted Actor. Retrying skips completed entries entirely, even if a later edit has changed their totals. For pending entries, compare the current resource and receipt with the original baseline before writing. A changed value, maximum, or intervening module operation rejects the stale entry instead of overwriting it. Return a fresh preview and require the GM to review and submit a new operation after a conflict. Changing the dropdown or recipients also deliberately starts a new operation.

Duplicate requests with the same requesting GM, operation ID, and immutable details join in-flight work or reuse its completed result. Reject reuse with different details. Store a small `Actor.flags["pf2e-zone-automation"].heroPointOperation` receipt in the same document update as the resource; this identifies a committed write when its acknowledgment is lost. Keep only the latest receipt per Actor. A matching resource total alone is insufficient proof of completion.

Retry plans are held in the authoritative GM tab for ten minutes after the last attempt. Reloading that tab or changing the active GM can lose them; a dialog refresh loses its retained request. A retry with an unavailable plan fails closed and asks the GM to review current totals. A late initial request with a matching committed receipt also fails closed. The per-Actor queues coordinate this module's changes; they do not provide a server transaction lock against other modules or character-sheet edits during an in-flight write.

## Public API compatibility

| API | Contract |
| --- | --- |
| `promptSetHeroPoints()` | Open or focus the guided GM dialog |
| `setHeroPoints(amount, character, { mode = "add", operationId, retry = false })` | Apply an integer amount in `add`, `remove`, or `set` mode; additive default preserves older callers. New calls generate an operation ID unless supplied. |
| `createHeroPointReminder(time)` | Persist a private reminder using a local `HH:mm` clock time |

`character` can be an eligible Actor, an array of Actors, an Actor ID, an unambiguous exact name, `selected`, or `target`. Reject ambiguous names, empty selections, NPCs, and characters without player ownership. The direct API returns changed Actor IDs, names, and before/after totals for the operation's completed entries. Failures expose `operationId`, `retryable`, and any available error `code` and `plan`. For a retryable failure, pass the same amount, mode, recipients, and `operationId` with `retry: true`; a call without that identity is an independent change. Socket timeouts are retryable. A stale or missing plan requires a reviewed new operation, not an automatic retry.

## Award reminders

The reminder section defaults to approximately one hour ahead. A valid `HH:mm` value means the next occurrence in the creating GM browser's local timezone, today or tomorrow. Convert it to an absolute timestamp before saving so other GMs deliver the same instant in their own timezones.

**Create reminder** saves a record, displays the chosen time, and keeps the dialog open. It does not use the selected character set or award any points. Sequential requests for the same user and timestamp reuse a saved reminder. Concurrent creation is a known gap in TODO.md.

Persist records under `User.flags["pf2e-zone-automation"].heroPointReminders`, keyed by a valid sixteen-character document ID. Each record contains `remindAt`. **Clear Reminders** appears when the current GM has pending records and removes only that GM's reminders with Foundry v14 deletion operators. Clearing does not delete already delivered chat messages or change Hero Points.

Only `game.users.activeGM` delivers reminders. Schedule a browser timer for the earliest saved reminder across GM users, with a maximum browser-timer delay. Listen for user updates and connection changes. On startup or handoff, recover future timers and deliver overdue records. Foundry must be open with an active GM; this is not a background service running while the world is offline.

For each due record, create one message with the reminder ID as its ChatMessage ID, `keepId: true`, and a whisper only to the creating GM. Store recipient and timestamp in `flags["pf2e-zone-automation"].heroPointReminder`. Confirm the matching message before removing the pending record. The fixed ID prevents duplicate delivery after a lost acknowledgment or flag-cleanup failure. Reject an unrelated message-ID collision. Retry failed deliveries after thirty seconds without blocking other due reminders.

The message says it is time to award everyone one Hero Point. **Award Hero Points** opens the same dialog; it does not auto-award. Only the creating GM receives that shortcut, and a chat-render hook restores it after a refresh. Recheck permission when clicked and suppress overlapping launches.

## Implementation map and validation

| File | Responsibility |
| --- | --- |
| `packs/src/zone-macros/set-hero-points.json` | Thin macro and icon |
| `scripts/hero-points.js` | Recipient resolution, preview, GM requests, and dialog retry workflow |
| `scripts/hero-points-rules.js` | Shared amount validation and bounded totals |
| `scripts/hero-points-worker.js` | Active-GM authorization, per-Actor queues, operation identity, receipts, and stale-plan checks |
| `scripts/transport.js`, `scripts/worker.js` | Authenticated routing and worker dispatch |
| `scripts/hero-point-reminders.js` | User flags, scheduler, delivery deduplication, and chat shortcut |
| `scripts/main.js` | APIs and reminder hook registration |
| `styles/pf2e-zone.css` | Dialog layout |

`tests/hero-points.mjs`, `tests/transport.mjs`, and `tests/hero-point-reminders.mjs` cover GM restrictions, off-scene characters, zero and maximum totals, independent concurrent awards/spends, unrelated Actor queues, duplicate requests, partial failures, stale values/maxima/receipts, cancelled and uncertain writes, expired or lost plans, two-GM routing, queued authority checks, private summaries, local times, reminder persistence, missed reminders, handoff delivery, collision handling, and reminder clearing.

Simultaneous reminder scheduling remains a separate open item. Live Forge checks should verify actual PF2e resource and receipt updates, two GM tabs, stale partial-update retries, reminders after reconnect, and the recipient-only shortcut without revealing reminder content to players.
