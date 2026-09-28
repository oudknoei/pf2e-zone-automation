# TODO

1. **Feature: Pending-save management.** Show unresolved saves in Manage Zones, with GM actions to repost or cancel them. Currently, an unanswered request can suppress future saves indefinitely.

2. **Feature: Support for Wall type areas.**

3. **Improvement: Limit retained runtime history and avoid unchanged writes.** Damage/healing roll caches, resolved-save records, and some applied-item references accumulate for the entire lifetime of a zone. Every state transaction writes the whole payload, and condition changes currently visit and rewrite all module zones even when most have no relevant watcher. For unlimited auras used across sessions, this increases stored data and network traffic. Prune records once no pending save needs them, remove stale Item references, and skip writes when nothing changed. This would improve responsiveness without changing the zone's rules. Code: [runtime.js](scripts/runtime.js).
