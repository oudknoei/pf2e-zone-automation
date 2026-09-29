# Real-Foundry lifecycle tests

This Playwright suite drives a disposable Foundry V14 world running the real PF2e system and this module. It deliberately stays separate from `pnpm test`: the fast Node suite uses mocks, while these tests verify browser sessions, sockets, ChatMessage visibility, Region hooks, synthetic Actors, and off-canvas document behavior.

## Local setup

The launcher needs Node 24 or newer and two paths:

- `FOUNDRY_INSTALL_PATH`: an extracted Foundry V14 Node installation.
- `FOUNDRY_DATA_PATH`: an existing Foundry data directory with a current `Config/license.json`, PF2e under `Data/systems/pf2e`, and the three dependencies declared by `module.json` under `Data/modules`.

Install Chromium once, then run the suite:

```powershell
pnpm exec playwright install chromium
$env:FOUNDRY_INSTALL_PATH = "C:\path\to\FoundryVTT"
$env:FOUNDRY_DATA_PATH = "C:\path\to\FoundryVTT-Data"
pnpm test:foundry
```

`pnpm foundry:up`, `pnpm foundry:status`, and `pnpm foundry:down` manage the isolated server separately. Set `FOUNDRY_URL` to test an already-running copy instead. Generated server data, traces, videos, and reports are ignored by Git.

The checked-in world contains four passwordless test users: two GMs and two players. Never expose this world to a public network. The launcher binds through Foundry's normal local defaults and copies the module into `.foundry-integration`; it does not change the source data directory.

## CI inputs

The `foundry-integration` workflow job runs after normal verification when both protected repository secrets exist:

- `FOUNDRY_RELEASE_URL`: the time-limited Foundry V14 Linux/Node download URL supplied to a license owner.
- `FOUNDRY_LICENSE_JSON_B64`: base64-encoded contents of a current, pre-activated `Config/license.json` belonging to that license owner.

Without both secrets, the job emits a notice and succeeds without claiming that the real-Foundry suite ran. CI downloads the latest PF2e release and the module's declared dependencies, so compatibility drift is exercised instead of hidden by a developer's long-lived world.

Four scenarios are currently marked as Playwright expected failures because they reproduce open P1 TODOs: shared-Actor on-exit ownership, both Shielding Taunt partial-failure boundaries, and full recovery after active-GM handoff. An unexpected pass fails the suite, signaling that the marker and corresponding TODO should be removed together.
