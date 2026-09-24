1. **Resolved: simultaneous preset saves preserve both changes.** Shared-library operations now run in order on the active GM, the Journal flag is replaced in one update, and overwrites or deletions with an outdated revision are rejected. A concurrent-save regression test covers both presets and a failed-write retry.

2. **Resolved: continuous effects return after re-entry.** Ongoing Conditions and Effect Items are restored while a creature is inside, including after re-entry in the same round. **Once each round** and **Once for this zone** still limit chat alerts, damage, healing, and saves.

3. **High: spell damage cards can trigger another “spell cast.”** Detection treats any message with a spell origin as a cast. PF2e also attaches that origin to damage messages. I confirmed a damage card qualifies for both spell-cast and manipulate detection. With **Every time**, one cast can trigger multiple times; with limited repetition, the wrong message can consume the allowance. Distinguish cast cards from subsequent rolls while preserving Detect Magic support. [Detection](E:/git/pf2e-zone-automation/scripts/runtime.js:1682), [PF2e damage-message source](https://github.com/foundryvtt/pf2e/blob/v14-dev/src/module/system/damage/damage.ts)

4. **High: save resolution does not enforce ownership on the GM.** The save button checks ownership, but the GM’s result handler accepts the identifier and outcome without checking the message author. I reproduced resolution using a message with no roll, no Actor, and an unrelated author. Require an appropriate save roll, matching Actor, and an author authorized to roll for that Actor. [Save-result handling](E:/git/pf2e-zone-automation/scripts/runtime.js:1604)

5. **Medium: finite zones can last longer than intended.** Removing the source from initiative leaves a stale combatant ID that prevents the world-time fallback. Missed turns also count as only one turn: my reproduction left a two-round zone active at round six. Use a recoverable expiration calculation and explicitly handle missing combatants, reconnects, and combat changes. [Duration checks](E:/git/pf2e-zone-automation/scripts/runtime.js:1379)

6. **Medium: disabling a Region behavior does not fully disable its automation.** Cleanup changes a cloned payload but never persists `deactivated`. Global chat and combat hooks can therefore continue treating the zone as active. Persist deactivation for a surviving Region and make every dispatch path respect it. [Deactivation handling](E:/git/pf2e-zone-automation/scripts/runtime.js:2196)

7. **Medium: a late save can apply an “on exit” effect after the creature already left.** If the player rolls after exit cleanup has finished, resolution creates the effect on the outside creature. It can remain until another reconciliation or zone cleanup. Recheck occupancy when applying exit-bound results; damage or other lasting consequences can still resolve normally. [Pending-save resolution](E:/git/pf2e-zone-automation/scripts/runtime.js:1519)

8. **Medium: Creator-only visibility is inconsistent.** Save requests and damage/healing cards are public. Manage Zones also lists all module zones without filtering for the viewer. A hidden aura can therefore reveal its name, creator, or DC. Apply a consistent audience policy, with save prompts visible to the people who need to resolve them. [Save requests](E:/git/pf2e-zone-automation/scripts/runtime.js:564), [Manage Zones](E:/git/pf2e-zone-automation/scripts/builder.js:1984)

9. **Medium: normalization hides invalid input from validation.** I confirmed radius `0` silently becomes **15 feet**, and an empty custom-duration field becomes **1 round**; both pass validation. Preserve invalid form input until validation runs. Keep migration defaults separate from current user input. [Configuration normalization](E:/git/pf2e-zone-automation/scripts/builder.js:557)

10. **Medium: Shielding Taunt measures between token centers.** This can reject a Large creature whose nearest occupied square is in range, and the supplied points omit elevation. Use PF2e’s token-distance calculation, which accounts for token size and elevation. [Taunt range](E:/git/pf2e-zone-automation/scripts/shielding-taunt-worker.js:54), [PF2e distance implementation](https://github.com/foundryvtt/pf2e/blob/v14-dev/src/module/canvas/token/object.ts)

11. **Feature: Pending-save management.** Show unresolved saves in Manage Zones, with GM actions to repost or cancel them. Currently, an unanswered request can suppress future saves indefinitely.

12. **Feature: Effect selection by drag and drop.** Display the resolved effect’s name and image, and reject missing UUIDs or documents that aren’t Effects before creation.

13. **Feature: One shared configuration and creation implementation.** The builder and GM worker duplicate normalization, Region creation, and initial state. Their validation already differs. Consolidating these paths would prevent player and GM behavior from drifting.

14. **Feature: Build compendia during releases.** The release workflow packages committed compendium databases without running `build:packs`. Automating that step would prevent source JSON changes from being omitted from releases. [Release workflow](E:/git/pf2e-zone-automation/.github/workflows/release.yml:23)

15. **Feature: Support for Wall type areas**
