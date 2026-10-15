# Set Hero Points design

Implementation reviewed: 2026-10-14; player ownership and personal reminders added after point serialization, stale-retry handling, and reminder creation reservations. This document covers point changes and the associated award reminders. Open issues are tracked in [TODO.md](../TODO.md).

## Purpose and access

Let users give, spend, or set Hero Points for explicitly selected characters, with a preview before committing. GMs can manage all player characters; non-GMs can manage only characters they own. Provide personal reminders without automatically changing resources.

The **Set Hero Points** macro calls `game.modules.get("pf2e-zone-automation").api.promptSetHeroPoints()`. Its icon is `assets/macros/SetHeroPoints.webp`. Although the compendium macro has player Observer ownership, the dialog and mutation functions reject non-GMs.

Eligible recipients are world Actors of type `character` with `hasPlayerOwner`. Non-GMs additionally require `actor.testUserPermission(requester, "OWNER")`; GM access includes all eligible characters. Apply that filter to the dialog, name/ID/token resolution, and direct API calls. They do not need a token on the viewed Scene. Sort by name. If none are available, show an error and do not open a dialog. Keep one rendered dialog per tab and bring it forward on another invocation. Actor updates/deletion and current-user updates refresh the preview; remove rows whose character was deleted or whose ownership was revoked. Release all hooks on close.

## Dialog workflow

Use one **Hero points** dropdown:

| Choice | Operation |
| --- | --- |
| Give 1 hero point | Add one |
| Spend 1 hero point | Remove one |
| Set hero points to 0 / 1 / 2 / 3 | Replace the total |

List each character with a checkbox, **Current**, and **After** totals. Preselect all eligible characters whose tokens are controlled; duplicate tokens do not duplicate recipients. **Select all** and **Clear** change the checked set. The apply button uses the chosen operation's wording and remains above the **Award reminder** section with **Cancel**.

Changing the operation or recipients updates the preview. Disable Apply when no recipients are selected or no totals would change. Clamp values to zero through the smaller of the Actor's configured maximum and three. Update `system.resources.heroPoints.value`, rather than storing a separate module resource.

On Apply, freeze recipients, action, amount, and an operation ID, and prevent a second submission while writes are pending. Send Actor IDs through authenticated transport to `game.users.activeGM`, including player submissions and requests from another GM tab. The worker requires an active requester and checks ownership of every requested character before joining an operation or performing any write. Mixed owned/unowned requests fail before mutation. Calculate each total from the current resource inside a per-Actor queue. Independent changes to the same Actor run in order; an unrelated Actor does not wait for that queue. Recheck elected-GM authority, requester activity, and character ownership when queued work begins, including completed entries. Revoked ownership stops the operation with a non-retryable `PF2E_ZONE_HERO_POINTS_PERMISSION` error; omit unauthorized characters from returned plans/results.

Collect write failures and whisper a summary of successfully changed totals to the requester and all GMs, using Foundry v14's canonical `author` field to attribute the message to the requester. Other players receive no summary. Announce only changes completed in that attempt. Summary delivery failure returns a warning after the resources have changed. If every write succeeds, close the dialog. Cancel before applying changes nothing.

When some writes fail, leave the dialog open with **Retry update**. The worker retains the before value, bounded maximum, preceding module-operation receipt, and exact target total for each attempted Actor. Retrying skips completed entries entirely, even if a later edit has changed their totals. For pending entries, compare the current resource and receipt with the original baseline before writing. A changed value, maximum, or intervening module operation rejects the stale entry instead of overwriting it. Return a fresh preview and require the user to review and submit a new operation after a conflict. Changing the dropdown or recipients also deliberately starts a new operation.

Duplicate requests with the same requester, operation ID, and immutable details join in-flight work or reuse its completed result after fresh permission checks. Reject reuse with different details. Store a small `Actor.flags["pf2e-zone-automation"].heroPointOperation` receipt in the same document update as the resource; this identifies a committed write when its acknowledgment is lost. Keep only the latest receipt per Actor. A matching resource total alone is insufficient proof of completion.

Retry plans are held in the authoritative GM tab for ten minutes after the last attempt. Reloading that tab or changing the active GM can lose them; a dialog refresh loses its retained request. A retry with an unavailable plan fails closed and asks the user to review current totals. A late initial request with a matching committed receipt also fails closed. The per-Actor queues coordinate this module's changes; they do not provide a server transaction lock against other modules or character-sheet edits during an in-flight write.

## Public API compatibility

| API | Contract |
| --- | --- |
| `promptSetHeroPoints()` | Open or focus the guided dialog with only characters the current user can manage |
| `setHeroPoints(amount, character, { mode = "add", operationId, retry = false })` | Apply an integer amount in `add`, `remove`, or `set` mode; additive default preserves older callers. New calls generate an operation ID unless supplied. |
| `createHeroPointReminder(time)` | Persist a private reminder using a local `HH:mm` clock time |

`character` can be an eligible Actor, an array of Actors, an Actor ID, an unambiguous exact name, `selected`, or `target`. Reject ambiguous names, empty selections, NPCs, and characters without player ownership. The direct API returns changed Actor IDs, names, and before/after totals for the operation's completed entries. Failures expose `operationId`, `retryable`, and any available error `code` and `plan`. For a retryable failure, pass the same amount, mode, recipients, and `operationId` with `retry: true`; a call without that identity is an independent change. Socket timeouts are retryable. A stale or missing plan requires a reviewed new operation, not an automatic retry.

## Award reminders

The reminder section defaults to approximately one hour ahead. A valid `HH:mm` value means the next occurrence in the creator's browser timezone, today or tomorrow. Convert it to an absolute timestamp before saving so GMs deliver the same instant in their own timezones.

**Create reminder** saves a record, displays the chosen time, and keeps the dialog open. It does not use the selected character set or award any points. Send the absolute timestamp through authenticated transport to the active GM, retaining the requester as the sole private recipient. Accept active players and GMs; reject inactive requesters and recheck elected-GM authority before a queued save begins. Ignore supplied recipient IDs: the recipient always comes from the authenticated requester.

Reserve matching recipient/time requests synchronously before any asynchronous work. Join concurrent submissions and serialize creation per recipient. Inside that queue, read the current saved flags; after deriving an ID, recheck permissions and saved flags before writing. Reuse existing records, including their legacy random IDs. New reminders use a stable sixteen-character ID derived from the module namespace, recipient, and absolute timestamp. Separate instances of the elected GM's browser and handoff retries therefore write the same flag key rather than adding distinct records. Reject a conflicting ID instead of overwriting its record.

Confirm persistence before reporting success. If an acknowledgment fails, the exact stored ID/timestamp can confirm the save. Otherwise return the save error and release the reservation; a retry derives the same ID even if the earlier update arrives late. The fixed ChatMessage ID also prevents a late reminder-flag update from producing a second delivery. A User update already sent to Foundry may finish during handoff; queued updates recheck the elected GM before dispatch.

Persist records under `User.flags["pf2e-zone-automation"].heroPointReminders`, keyed by a valid sixteen-character document ID. Each record contains `remindAt`. **Clear Reminders** appears when the current user has pending records. Route clearing through the authenticated active-GM worker in the same recipient queue as creation, recheck authority/activity, and remove only that requester's records with Foundry v14 deletion operators. Confirm removal from live flags, including after a lost acknowledgment. Clearing does not delete already delivered chat messages or change Hero Points.

Only `game.users.activeGM` delivers reminders. Schedule a browser timer for the earliest saved reminder across all users, with a maximum browser-timer delay. Player clients never install delivery hooks. Listen for user updates and connection changes. On startup or handoff, recover future timers and deliver overdue records, including reminders for offline recipients. Foundry must be open with an active GM; this is not a background service running while the world is offline.

For each due record, create one message with the reminder ID as its ChatMessage ID, `keepId: true`, and a whisper only to its creator. Use the canonical `author` field; a player's reminder is authored by that player, so the worker GM is neither author nor recipient. Store recipient and timestamp in `flags["pf2e-zone-automation"].heroPointReminder`. Confirm the matching message before removing the pending record. The fixed ID prevents duplicate delivery after a lost acknowledgment or flag-cleanup failure. Reject an unrelated message-ID collision. Retry failed deliveries after thirty seconds without blocking other due reminders.

GM messages say it is time to award everyone one Hero Point and retain **Award Hero Points**. Player messages refer to their own characters and offer **Set Hero Points**. Both shortcuts open the same permission-filtered dialog without applying points. Accept completion markers and shortcuts only from a GM or the player recipient's own message, with exactly that recipient in the whisper. Forged authors, public cards, or mismatched recipients remain collisions rather than inferred successful delivery. A chat-render hook restores valid shortcuts after a refresh. Recheck recipient identity when clicked and suppress overlapping launches.

## Implementation map and validation

| File | Responsibility |
| --- | --- |
| `packs/src/zone-macros/set-hero-points.json` | Thin macro and icon |
| `scripts/hero-points.js` | Owned-character filtering, preview, authenticated requests, and dialog retry workflow |
| `scripts/hero-points-rules.js` | Shared eligibility/ownership, amount validation, and bounded totals |
| `scripts/hero-points-worker.js` | Active-GM authorization, per-Actor queues, operation identity, receipts, and stale-plan checks |
| `scripts/transport.js`, `scripts/worker.js` | Authenticated routing and worker dispatch |
| `scripts/hero-point-reminders.js` | User flags, scheduler, delivery deduplication, and chat shortcut |
| `scripts/hero-point-reminder-worker.js` | Reminder authorization, synchronous reservations, per-User queues, stable IDs, and save confirmation |
| `scripts/main.js` | APIs and reminder hook registration |
| `styles/pf2e-zone.css` | Dialog layout |

`tests/hero-points.mjs`, `tests/transport.mjs`, and `tests/hero-point-reminders.mjs` cover player dialog filtering and all six choices, shared ownership, forged/mixed recipient requests, revoked permissions before queued writes and cached results, live removal of inaccessible rows, hook cleanup, off-scene characters, bounded totals, independent concurrent awards/spends, unrelated Actor queues, duplicate requests, partial failures, stale baselines, lost/expired plans, and private summaries. Reminder tests cover player recipient-only delivery and shortcuts, authenticated player routing, clearing only the requester, concurrent create/clear ordering, lost clearing acknowledgments, elected-GM checks, stable IDs, local times, refresh/handoff delivery, missed reminders, forged completions, and collisions. The full suite passes 449 tests with ESLint on 2026-10-14.

Player access was verified with synthetic clients and DOM tests; it has not been deployed or verified in a live Forge session. Live checks should verify owned/shared/unowned character lists, permission revocation, all six operations, canonical chat authorship, player-only reminder visibility, clearing, and reminders after reconnect or GM handoff.
