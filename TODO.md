1. **Resolved: simultaneous preset saves preserve both changes.** Shared-library operations now run in order on the active GM, the Journal flag is replaced in one update, and overwrites or deletions with an outdated revision are rejected. A concurrent-save regression test covers both presets and a failed-write retry.

2. **Resolved: continuous effects return after re-entry.** Ongoing Conditions and Effect Items are restored while a creature is inside, including after re-entry in the same round. **Once each round** and **Once for this zone** still limit chat alerts, damage, healing, and saves.

3. **Resolved: spell damage cards no longer trigger another cast.** Spell-origin messages with roll data or follow-up roll context are ignored before spell-cast and trait-use matching. Cast cards, including no-defense spells such as Detect Magic, still trigger. Regression tests cover cast and damage cards.

4. **High: save resolution does not enforce ownership on the GM.** The save button checks ownership, but the GM’s result handler accepts the identifier and outcome without checking the message author. I reproduced resolution using a message with no roll, no Actor, and an unrelated author. Require an appropriate save roll, matching Actor, and an author authorized to roll for that Actor. [Save-result handling](E:/git/pf2e-zone-automation/scripts/runtime.js:1604)

5. **Medium: finite zones can last longer than intended.** Removing the source from initiative leaves a stale combatant ID that prevents the world-time fallback. Missed turns also count as only one turn: my reproduction left a two-round zone active at round six. Use a recoverable expiration calculation and explicitly handle missing combatants, reconnects, and combat changes. [Duration checks](E:/git/pf2e-zone-automation/scripts/runtime.js:1379)

6. **Medium: disabling a Region behavior does not fully disable its automation.** Cleanup changes a cloned payload but never persists `deactivated`. Global chat and combat hooks can therefore continue treating the zone as active. Persist deactivation for a surviving Region and make every dispatch path respect it. [Deactivation handling](E:/git/pf2e-zone-automation/scripts/runtime.js:2196)

7. **Medium: a late save can apply an “on exit” effect after the creature already left.** If the player rolls after exit cleanup has finished, resolution creates the effect on the outside creature. It can remain until another reconciliation or zone cleanup. Recheck occupancy when applying exit-bound results; damage or other lasting consequences can still resolve normally. [Pending-save resolution](E:/git/pf2e-zone-automation/scripts/runtime.js:1519)

8. **Working as intended: Creator-only visibility.** Save requests and damage/healing cards remain public, and Manage Zones lists module zones as currently implemented. No change planned.

9. **Resolved: invalid zone size and duration inputs stay visible for validation.** Zero or blank size fields and blank custom-duration fields now remain invalid in the editor, including after a rerender. Missing values in older saved configurations still receive their migration defaults. Regression tests cover both paths.

10. **Resolved: Shielding Taunt uses PF2e token distance.** Range now uses the nearest occupied squares and includes elevation through PF2e's token distance calculation. Regression checks cover a Large target within range and an elevated target outside it. [Taunt range](E:/git/pf2e-zone-automation/scripts/shielding-taunt-worker.js:54), [PF2e distance implementation](https://github.com/foundryvtt/pf2e/blob/v14-dev/src/module/canvas/token/object.ts)

11. **Feature: Pending-save management.** Show unresolved saves in Manage Zones, with GM actions to repost or cancel them. Currently, an unanswered request can suppress future saves indefinitely.

12. **Feature: Effect selection by drag and drop.** Display the resolved effect’s name and image, and reject missing UUIDs or documents that aren’t Effects before creation.

13. **Feature: One shared configuration and creation implementation.** The builder and GM worker duplicate normalization, Region creation, and initial state. Their validation already differs. Consolidating these paths would prevent player and GM behavior from drifting.

14. **Feature: Build compendia during releases.** The release workflow packages committed compendium databases without running `build:packs`. Automating that step would prevent source JSON changes from being omitted from releases. [Release workflow](E:/git/pf2e-zone-automation/.github/workflows/release.yml:23)

15. **Feature: Support for Wall type areas**
