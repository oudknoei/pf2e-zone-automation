# PF2e 8.7.0 compatibility review

Reviewed November 5, 2026 against the current module working tree (module version 0.1.74), including the existing local Hero Points and Session Notes edits.

## Scope and sources

Compared the released PF2e 8.6.1 and 8.7.0 sources, including runtime changes, migrations, and compendium changes, against the module's system integrations and authored pack data.

- [PF2e 8.7.0 release notes](https://github.com/foundryvtt/pf2e/releases/tag/pf2e-8.7.0)
- [Complete upstream comparison](https://github.com/foundryvtt/pf2e/compare/pf2e-8.6.1...pf2e-8.7.0)
- [Released distance-measurement implementation](https://github.com/foundryvtt/pf2e/blob/pf2e-8.7.0/src/module/canvas/helpers.ts)
- [Released token implementation](https://github.com/foundryvtt/pf2e/blob/pf2e-8.7.0/src/module/scene/token-document/document.ts)

## Issue fixed

PF2e removed `ActorPF2e.dimensions` and changed cuboid distance measurement to use `TokenDocument.depth` in grid units. Shielding Taunt still read `actor.dimensions.height`. On a square grid, different elevations therefore produced a non-finite distance and aborted the action with "The distance to the Taunt target could not be measured."

`scripts/shielding-taunt-worker.js` now converts token depth to scene pixels in the same way as PF2e. It retains the old actor-height fallback when token depth is absent. Range measurement also reads prepared token geometry before `_source`, so actor-driven size overrides are respected. It still uses the tokens' owning Scene and does not require rendered tokens or the GM to view that Scene.

Six regression cases reproduced failures before the fix and pass afterward. They cover targets above and below the Guardian, in-range and out-of-range elevation differences, different source/target depths, and prepared geometry that differs from stored data. Existing legacy actor-height coverage also passes.

## Other integrations reviewed

| Upstream area | Module assessment |
| --- | --- |
| Token management moved to core ActiveEffect processing | No calls to the removed `simulateUpdate` or `syncTokenDimensions` APIs, or the removed token override fields. Normal token lifecycle hooks remain in use. |
| Nullable land speed and movement inference | Module scripts and authored pack rules do not dereference land-speed statistics. |
| Actor AppV2 base sheet and sheet styling | Module does not subclass PF2e actor sheets or invoke their drop handlers; its dialogs use separate implementations. |
| NPC class DC becomes a Statistic | Existing DC helpers accept `actor.classDC.dc.value` and `getStatistic("class-dc")`. |
| Ignored RollOption resolution | Authored RollOptions use fixed option strings; no dependency on resolving ignored options was found. |
| NPC weapon/rune inheritance and migrations | Module does not generate NPC weapon attacks or manage linked-weapon flags. The new migrations target NPC melee items and Untethered predicates. |
| ABP spell attacks and spell potency equipment | The ABP interfaces and spell-attack selector used by the module were not changed in this release. |
| Saves, DamageRoll, conditions, and effect context | No incompatible change found in the interfaces used by the runtime. The builder already reads the installed system's condition catalog. |
| PF2e's template level restriction | Change is in PF2e's item-template placement helper; the module uses its own Region placement and core token emanations. |
| Hero Points and Session Notes | No conflicting PF2e interface change found; their existing local edits were preserved. |

## Validation and limits

- `pnpm test`: **452 passed, 0 failed**, including compiled-pack checks.
- `pnpm lint`: passed.
- `git diff --check`: passed.
- `pnpm test:foundry`: could not start because `FOUNDRY_INSTALL_PATH` is not configured. This is not a completed live Foundry/Forge verification.

No additional incompatibility was identified by source review and local tests. The remaining live check is to use Shielding Taunt on PF2e 8.7.0 between tokens at different elevations, including a size-changing effect, then check zone entry/exit and an ordinary save/damage flow. This review does not mark the manifest as live-verified or publish a release.
