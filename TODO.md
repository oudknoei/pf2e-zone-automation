1. ~~**Resolved: simultaneous preset saves preserve both changes.** Shared-library operations now run in order on the active GM, the Journal flag is replaced in one update, and overwrites or deletions with an outdated revision are rejected. A concurrent-save regression test covers both presets and a failed-write retry.~~

2. ~~**Resolved: continuous effects return after re-entry.** Ongoing Conditions and Effect Items are restored while a creature is inside, including after re-entry in the same round. **Once each round** and **Once for this zone** still limit chat alerts, damage, healing, and saves.~~

3. ~~**Resolved: spell damage cards no longer trigger another cast.** Spell-origin messages with roll data or follow-up roll context are ignored before spell-cast and trait-use matching. Cast cards, including no-defense spells such as Detect Magic, still trigger. Regression tests cover cast and damage cards.~~

4. ~~**Resolved: GM save resolution verifies the target and roller.** A result now needs a PF2e saving-throw roll for the pending identifier, DC, save type, and Actor. The chat author and roll creator must be a GM or own the target Actor; the same checks protect stale-save cleanup. Regression tests cover forged messages and valid owner/GM saves.~~

5. ~~**Resolved: finite zones use a recoverable expiration deadline.** Both creation paths store a combat-round deadline. The runtime catches skipped rounds, uses combat or world time when the source leaves initiative, carries remaining time into a new encounter, and checks overdue zones after reconnect. Older zones recover a deadline from their last recorded source turn.~~

6. ~~**Resolved: disabled Region behaviors stop zone automation.** Deactivation is persisted before owned effects are removed. Region, chat, combat, save, and movement dispatch check the saved flag and behavior state; startup reconciliation repairs older disabled zones. Re-enabling the behavior resumes automation.~~

7. ~~**Resolved: late saves respect current zone occupancy.** Exit-bound Conditions and Effect Items are skipped once the target is outside, and a final check removes items created during a movement race. Damage, healing, and longer-lasting results still resolve. Regression tests cover late saves, normal in-zone saves, and movement during item creation.~~

8. **Working as intended: Creator-only visibility.** Save requests and damage/healing cards remain public, and Manage Zones lists module zones as currently implemented. No change planned.

9. ~~**Resolved: invalid zone size and duration inputs stay visible for validation.** Zero or blank size fields and blank custom-duration fields now remain invalid in the editor, including after a rerender. Missing values in older saved configurations still receive their migration defaults. Regression tests cover both paths.~~

10. ~~**Resolved: Shielding Taunt uses PF2e token distance.** Range now uses the nearest occupied squares and includes elevation through PF2e's token distance calculation. Regression checks cover a Large target within range and an elevated target outside it. [Taunt range](E:/git/pf2e-zone-automation/scripts/shielding-taunt-worker.js:54), [PF2e distance implementation](https://github.com/foundryvtt/pf2e/blob/v14-dev/src/module/canvas/token/object.ts)~~

11. **Feature: Pending-save management.** Show unresolved saves in Manage Zones, with GM actions to repost or cancel them. Currently, an unanswered request can suppress future saves indefinitely.

12. **Feature: Effect selection by drag and drop.** Display the resolved effect’s name and image, and reject missing UUIDs or documents that aren’t Effects before creation.

13. ~~**Resolved: one shared configuration and creation implementation.** Builder and GM worker use the same defaults, normalization, validation, Region payload, initial state, runtime activation, and duration announcement. Preset saves also use the shared validation and source ownership checks. Each creation path keeps its appropriate area-placement interaction. Regression tests compare both paths and reject invalid worker requests.~~

14. **Feature: Build compendia during releases.** The release workflow packages committed compendium databases without running `build:packs`. Automating that step would prevent source JSON changes from being omitted from releases. [Release workflow](E:/git/pf2e-zone-automation/.github/workflows/release.yml:23)

15. **Feature: Support for Wall type areas**
