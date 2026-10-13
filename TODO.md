# TODO

- [ ] **Feature: Support for Wall type areas.** A wall-shaped Region would be useful mainly for effects on crossing, entering, beginning or ending a turn near a wall, and for cleanup when the spell ends. The module currently supports circular and square areas with entry/turn triggers, saves, damage, and conditions; it does not create Foundry Walls or model blocked movement, sight, cover, difficult terrain, or destructible sections. A wall footprint alone would therefore automate only part of most spells.

  | Spell | Rank (level) | How useful would this module be? |
  | --- | ---: | --- |
  | [Prismatic Wall (Legacy)](https://2e.aonprd.com/Spells.aspx?ID=234) | 8 | **High potential, substantial custom work.** A wall boundary and surrounding light area could prompt the initial Will save and track its 1-hour immunity, then request the seven saves when a creature crosses. The ordered color layers, their individual counteracts, and effects blocked by each layer need spell-specific state and interaction handling. |
  | [Chromatic Wall (Legacy)](https://2e.aonprd.com/Spells.aspx?ID=37) | 5 (7th heightened) | **High potential, substantial custom work.** Crossing detection could deliver the chosen color's save, damage, or condition. The random color, higher-rank options, color-specific counteracts, and selective blocking of ammunition, spells, or other effects are beyond a generic damage zone. |
  | [Wall of Thorns](https://2e.aonprd.com/Spells.aspx?ID=1752) | 3 | **High.** A wall-shaped footprint could apply piercing damage when a move action enters the brambles. This must be counted once per qualifying move action, not merely once per turn or once per Region entry; cover, difficult terrain, and section HP/breaches need separate support. |
  | [Wall of Flesh](https://2e.aonprd.com/Spells.aspx?ID=2042) | 5 | **Medium–high.** A 5-foot proximity band plus the existing end-of-turn trigger could request the Arms save and apply grabbed/restrained, or prompt the Mouths Strike. Eyes' remote sight, actual attack rolls, Escape, healing, and per-section HP are not generic zone effects. |
  | [Wall of Fire](https://2e.aonprd.com/Spells.aspx?ID=1748) | 4 | **Very high; best first example.** Its line or ring can use crossing/entry damage and start-of-turn damage with no save, matching existing effect types once wall geometry and reliable crossing detection exist. Concealment across the wall still requires separate sight handling. |
  | [Wall of Metal](https://2e.aonprd.com/Spells.aspx?ID=1379) | 6 | **Low.** This is chiefly a material barrier with per-section AC, Hardness, HP, and broken openings, not an occupant effect. It calls for Foundry Wall/object and breach integration more than the current zone runtime. |
  | [Wall of Stone](https://2e.aonprd.com/Spells.aspx?ID=1751) | 5 | **Low.** Its shaped, potentially nonvertical path, solid obstruction, section damage, and rubble/difficult terrain dominate. A Region could mark the footprint, but wall geometry, destruction, and terrain need other systems. |
  | [Wall of Virtue (Legacy)](https://2e.aonprd.com/Spells.aspx?ID=1127) | 3 | **High for its crossing/start-of-turn effect.** A line or ring could trigger its two damage components at the prescribed times using separate Effect Blocks. Its light and magical-darkness counteract need separate handling; the printed good/positive damage is Legacy terminology requiring a GM-approved Remaster interpretation before automation. |
  | [Wall of Water (Legacy)](https://2e.aonprd.com/Spells.aspx?ID=1028) | 3 | **Low–medium.** A wall footprint could warn on traversal or fire entering the wall, but Swim/aquatic combat, projectile restrictions, and counteracting fires require movement, attack, and spell-effect integration rather than ordinary zone damage. |
  | [Wall of Wind](https://2e.aonprd.com/Spells.aspx?ID=1753) | 3 | **Medium.** Crossing detection could request the Fortitude save for a creature trying to fly through and report the result. Enforcing stopped movement/pushes, ground difficult terrain, gas exclusion, and size-dependent projectile penalties needs dedicated movement and attack handling. |
  | [Wall of Force](https://2e.aonprd.com/Spells.aspx?ID=1749) | 6 | **Low.** This invisible wall mainly blocks movement and physical effects while allowing visual and teleportation effects, with its own HP/counteract rules. A Region provides lifecycle bookkeeping, but not the barrier behavior. |
  | [Wall of Shadow](https://2e.aonprd.com/Spells.aspx?ID=2373) | 3 | **Low.** Its effect is conditional visibility across the wall, including darkvision and heightened-rank differences; it has no creature-entry damage or condition for the current runtime to apply. It needs sight-system integration. |
  | [Wall of Mirrors](https://2e.aonprd.com/Spells.aspx?ID=2546) | 4 | **Medium if wall attacks become events.** Striking the wall calls for mental damage with a basic Will save, which the effect engine could resolve once it can detect a Strike against the wall. The solid barrier, section HP, and concealment across it remain separate features. |
  | [Wall of Radiance](https://2e.aonprd.com/Spells.aspx?ID=2372) | 3 (4th heightened) | **High.** A wall-crossing event could deliver fire damage with a basic Fortitude save; a separate 5-foot adjacency band could maintain dazzled while adjacent. The heightened concealment effect still needs sight handling. |
  | [Wall of Ice](https://2e.aonprd.com/Spells.aspx?ID=1750) | 5 | **Medium after breach support.** The module could damage creatures crossing a section destroyed by non-fire means and remove that effect when the spell ends. Tracking which section was destroyed, how it was destroyed, its remaining cold/difficult-terrain mass, and the opaque barrier requires wall-object state. |
  | [Wall of Shrubs](https://2e.aonprd.com/Spells.aspx?ID=1414) | 1 (3rd/5th heightened) | **Low.** There is no recurring save or damage to automate. Cover is the main effect; higher ranks add difficult terrain and a ring option, so useful support would be wall/terrain placement rather than the zone effect engine. |

  **Scope recommendation:** Start with passable, damaging walls—especially *Wall of Fire* and *Wall of Radiance*—using straight-line and ring footprints, crossing detection, and existing turn/save/damage/condition effects. Treat physical obstruction, cover/sight, difficult terrain, projectile interception, and destructible sections as explicit later integrations, not promises of a generic Wall shape. *Prismatic Wall*, *Chromatic Wall*, *Wall of Virtue*, and *Wall of Water* above are marked Legacy on Archives of Nethys and have no linked Remaster reprint there; this table retains their printed rules instead of inventing a replacement. In particular, do not map *Wall of Virtue*'s good/positive damage to new damage types without an approved rules decision.

## Code review — 2026-10-12

Completed feature designs are in [Shielding Taunt](docs/shielding-taunt.md), [Set Hero Points](docs/set-hero-points.md), [Ask a Question About](docs/ask-a-question-about.md), and [Zone Builder](docs/zone-builder.md). The former Recall Knowledge feature/design notes have moved out of this backlog.

Review scope: feature entry points, privileged transport/worker paths, saved operation markers, Hero Point scheduling, and selected runtime transactions/lifecycle paths. The five reproductions below used the actual module functions with isolated document/network-free mocks; they establish code-path behavior, not a live Forge reproduction. Application code was not changed during this review.

### Bugs and correctness gaps

- [ ] **[P1] Stop queued zone transactions after an active-GM handoff.** `scripts/runtime.js`: `handleRegionEvent`, `withState`, and `writePayload`.

  **Evidence:** Hold a Region state lock, enqueue a `tokenTurnEnd` event while this GM is authoritative, switch `game.users.activeGM`, then release the lock. The old GM still executes the queued trigger and commits its payload. The entry check happens before waiting; the transaction/commit does not revalidate authority. This can duplicate effects or overwrite the new GM's state.

  **Next step:** Introduce an authority generation/lease for authoritative transactions. Check it when queued work starts, before privileged effects and persistence, and before deferred actions. Preserve deliberate direct-GM management paths rather than indiscriminately blocking every secondary-GM call. Add queued and mid-await handoff regressions, then verify two GM clients on Forge.

- [x] **[P2] Serialize independent Hero Point changes and detect stale retry plans.** `scripts/hero-points.js`: `setHeroPoints` and the dialog request path; `scripts/hero-points-worker.js`: authoritative per-Actor queues and retained operations.

  **Review evidence (2026-10-12):** Two concurrent `setHeroPoints(1, actor)` calls from zero both planned a total of one and left one point instead of two. The dialog's busy flag protected one dialog, but the public API and other GM tabs did not share that guard. A retained partial-failure plan also had no conflict check against later external edits.

  **Resolution (2026-10-13):** Routed all point changes through the authenticated active-GM worker. Per-Actor queues calculate totals from the latest resource, join duplicate operation IDs, and preserve completed entries on retry. Pending retries check the original value, maximum, and preceding module receipt before writing; stale plans require a fresh review. Resource updates atomically include a receipt to identify committed writes after a lost acknowledgment. Missing or expired retry plans fail closed. Preserved the dropdown, recipient resolution, additive API default, bounded totals, and GM-only summaries; documented the retry options and ten-minute plan lifetime in `docs/set-hero-points.md`.

  **Validation:** All 299 automated tests and full ESLint pass. Added coverage for concurrent awards/spends, unrelated Actor queues, duplicate IDs, completed entries changed before retry, stale values/maxima/receipts, cancelled and uncertain writes, lost/expired plans, queued authority changes, authenticated two-GM routing, and player rejection. Live Forge checks remain in the validation checklist below.

- [ ] **[P2] Reserve reminder creation before awaiting the User update.** `scripts/hero-point-reminders.js`: `createHeroPointReminder`.

  **Evidence:** Two concurrent calls for the same GM and `HH:mm` value both miss the existing-record check and persist distinct IDs for the same `remindAt`. Fixed ChatMessage IDs prevent duplicate delivery of one record, but not delivery of these two different records. The current dialog guard does not protect direct API calls or another tab.

  **Next step:** Join identical in-flight scheduling requests and serialize creation through a single authority if multiple tabs are supported. Recheck saved state in the serialized operation. Add simultaneous-creation coverage, including delayed/lost save acknowledgments and subsequent delivery of exactly one reminder.

- [ ] **[P2] Validate the provenance of persisted completion markers before reusing them.** `scripts/recall-knowledge-worker.js`: `completedQuestion`; also inspect `scripts/shielding-taunt-worker.js`: `completedOperation`.

  **Evidence:** An authorized question request accepts a public, player-authored ChatMessage with matching `recallKnowledgeQuestion` operation/requester/fingerprint fields as a completed operation, returns its ID, and never makes the secret check. That lookup reads arbitrary flags without the GM-author/private-recipient validation used elsewhere. The Taunt completion lookup similarly accepts a matching chat marker without checking its author; that related path needs its own regression.

  **Next step:** Validate GM authorship, required marker fields, and question visibility/recipient constraints before trusting a durable completion record. Reuse or factor the existing private-question validator without weakening handoff recovery. Test forged/public/incomplete markers alongside genuine post-refresh completions. Verify Foundry's actual permission boundary for player-supplied chat flags.

- [ ] **[P2] Persist the full creation fingerprint for post-refresh zone retries.** `scripts/worker.js`: `oncePerCreationRequest` and `createZone`; `scripts/zone-creation.js`: `initialRuntimeState`.

  **Evidence:** A fresh worker accepts changed configuration under an existing `creationOperationId` and returns the original Region as success. Only the local ten-minute cache compares the full request; the durable lookup checks operation ID and creator. A reload or cache expiry therefore changes replay validation semantics.

  **Next step:** Persist a canonical fingerprint of the accepted request on new Regions and compare it before returning a durable completion. Include source, Scene, config, preset revision, activation choice, color, and placement. Define a compatibility policy for old Regions without that field. Test changed replays after worker reload/cache expiry, not only while the cache is populated.

- [x] **[P2] Restore the default prompt's explicit plain-text instruction.** `scripts/recall-knowledge-prompt.js`: `DEFAULT_KNOWLEDGE_PROMPT`; `tests/recall-knowledge-ai.mjs`: "the model receives plain-text instructions and leftover Markdown is removed before posting".

  **Review evidence (2026-10-12):** The pre-existing working-tree prompt edit omitted the plain-prose/no-Markdown instruction, causing the suite's contract assertion to fail. The response normalizer remained present, but the request no longer told the model to avoid formatting.

  **Resolution (2026-10-13):** Restored the explicit instruction to use plain text prose and ordinary paragraphs, without Markdown, HTML, headings, lists, tables, emphasis markers, backticks, or code fences. Preserved the other prompt wording and the formatting fallback. The existing regression and all 285 automated tests pass; full ESLint passes.

- [ ] **[P2, potential] Make preset saves retry-safe after an uncertain acknowledgment.** `scripts/builder.js`: `saveCurrentPreset`; `scripts/worker.js`: `saveLibraryPreset`.

  **Inspection:** Library requests carry no durable operation ID. After a Save As commits but its socket reply times out, another click sends `recordId: null` and can create a second preset. A committed overwrite can instead return a stale-revision error when retried. Per-client serialization does not identify an already completed logical operation. This scenario was identified by inspection, not reproduced live.

  **Next step:** Retain a save operation ID and frozen request across timeout retries, persist/join its result, and distinguish unknown acknowledgment from an ordinary rejected save. Add a worker commit/lost-reply test that verifies one preset and the original revision result.

### Refactoring opportunities

- [ ] **Extract Region state and lifecycle services from `scripts/runtime.js`.** Start with payload normalization/replacement, lock/authority management, and cleanup/recovery; then isolate save requests/resolution and effect application. Keep the versioned singleton, legacy `world.pf2eZone` payloads, exposed method contracts, after-commit ordering, and hook teardown stable. Extract one concern at a time with existing lifecycle/save/immunity tests as the compatibility check.

- [ ] **Separate builder rendering from its operation controller.** `scripts/builder.js` combines large HTML templates, inline styles, validation, preset storage, placement, and zone management. Extract pure view/summary helpers and distinct preset/manager controllers, move presentation styles to `styles/pf2e-zone.css`, and retain exact user wording, mutation snapshots, stale-response checks, and terminal Move behavior. Validate with `tests/builder-ui.mjs` and `tests/builder-workflow.mjs` plus live canvas placement.

- [ ] **Extract the preset repository and centralize worker action policy.** Move Journal discovery/repair, flag persistence, index rendering, record authorization, and revision checks out of the per-request closure in `scripts/worker.js`. Define action routing/authority policy once instead of separately extending the action switch and `activeGMAction` list in `scripts/transport.js`. Preserve authenticated sender checks and intentional direct-GM paths; retain library concurrency and transport regressions.

- [x] **Index question/answer recovery instead of scanning all chat history every second.** `scripts/recall-knowledge-ai.js`: `reconcileKnowledgeAI`, `postedAnswer`, and `registerKnowledgeAI`; `scripts/recall-knowledge-index.js`: `KnowledgeChatIndex`.

  **Review evidence (2026-10-12):** Reconciliation walked the complete ChatMessage collection every second, and answer lookup scanned it again.

  **Resolution (2026-10-13):** Built a startup index using the existing trusted question/answer validators. Chat create/update/delete hooks maintain pending cards and answer attempt keys; role updates revalidate only marked candidates. Timer checks use active jobs and indexed queued/thinking cards. Preserved reload/handoff recovery, public answer visibility, duplicate-answer recovery order, deletion handling, and manual-only paid retries. Teardown removes all lifecycle hooks and the index.

  **Validation:** All 307 automated tests and full ESLint pass. Eight new regressions cover startup recovery, message/flag/attempt changes, public answers, duplicate ordering, deletion, role/trust changes, failed recovery writes, teardown/rebuild, and large chat history. A 30,252-message history is traversed once at startup, with no additional history reads or traversals across 100 timer ticks, a role update, and answer recovery; authority checks still run each tick.

- [ ] **Reconcile unused prompt-setting helpers and make price-table maintenance explicit.** The existing edit in `scripts/recall-knowledge-prompt.js` reintroduces `registerKnowledgePromptSetting`, its textarea renderer, and `knowledgePromptInstructions`, but `scripts/main.js` does not call them and new questions use the built-in constant. Resolve that obsolete/draft path against the documented no-configurable-prompt decision before removal. Separately isolate the dated model/tier prices in `scripts/recall-knowledge-ai-cost.js` as auditable data with source/date metadata, keeping unknown-price behavior and never adding provider requests or credential-bearing logs to price refreshes.

### Validation snapshot and live checks

Review baseline on 2026-10-12: **284 of 285 automated tests passed; one existing plain-text prompt assertion failed**, as recorded above. Full ESLint passed. The five isolated probes reproduced the queued-GM-handoff, concurrent Hero Point, duplicate-reminder, untrusted-question-marker, and changed-zone-replay behaviors. Those probes were temporary review checks, not changes to the checked-in suite.

Follow-up on 2026-10-13: **All 285 automated tests and full ESLint pass** after restoring the default prompt's explicit plain-text instruction.

Hero Point follow-up on 2026-10-13: **All 299 automated tests and full ESLint pass**, including fourteen new concurrency, retry, and authorization regressions.

Knowledge recovery follow-up on 2026-10-13: **All 307 automated tests and full ESLint pass**, including eight new index lifecycle and large-history regressions.

- [ ] **Verify gameplay changes on the actual Forge world after their fixes.** Use GM/player and two-GM clients for handoff, authenticated socket identity, concurrent Hero Point changes and stale retries, saved-operation recovery, private questions, public answer-only messages, reminder delivery, and canvas movement/outline behavior. Existing local tests and the user's successful API calls do not establish all these cases. The optional local Foundry harness requires a separate licensed installation and is not a requirement that can be assumed for managed Forge hosting.
