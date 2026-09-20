"""Extract the v0.5.13 macros into loadable Foundry ES modules.

The original macro files remain the reference for this first conversion pass.
Run this script again only after reviewing any manual changes in scripts/.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "original macro"
BUILDER = (SOURCE / "PF2e_Zone_Builder_v0.5.13.txt").read_text(encoding="utf-8")
WORKER = (SOURCE / "PF2e_Zone_GM_Worker_v0.5.13.txt").read_text(encoding="utf-8")
SCRIPTS = ROOT / "scripts"
STYLES = ROOT / "styles"
SCRIPTS.mkdir(exist_ok=True)
STYLES.mkdir(exist_ok=True)


def between(source: str, first: str, last: str) -> str:
    start = source.index(first)
    stop = source.index(last, start)
    return source[start:stop]


REGION_SCRIPT = '''return `
const api = game.modules.get("pf2e-zone-automation")?.api;
if (!api?.handleRegionEvent) throw new Error("PF2e Zone Automation module is not active.");
await api.handleRegionEvent({ behavior, event, region, scene: typeof scene !== "undefined" ? scene : region?.parent });
`;'''


runtime = between(
    BUILDER,
    "  async function zoneRuntimeEntrypoint(explicitContext = null) {",
    "  const COMMON_TRAITS = [",
)
runtime = runtime.replace(
    "  async function zoneRuntimeEntrypoint(explicitContext = null) {",
    "export async function zoneRuntimeEntrypoint(explicitContext = null) {",
    1,
)
runtime = runtime.replace(
    '''    const context = explicitContext ?? (
      typeof behavior !== "undefined" && typeof event !== "undefined" && typeof region !== "undefined"
        ? { behavior, event, region, scene: typeof scene !== "undefined" ? scene : region?.parent }
        : null
    );''',
    "    const context = explicitContext;",
    1,
)
(SCRIPTS / "runtime.js").write_text(
    "// Zone runtime extracted from PF2e Zone Builder v0.5.13.\n" + runtime,
    encoding="utf-8",
)


worker = WORKER
worker = worker.replace(
    "return await (async () => {",
    "export async function handleWorkerRequest(request) {",
    1,
)
worker = worker.replace(
    '''  const request = typeof pf2eZoneWorkerRequest !== "undefined"
    ? pf2eZoneWorkerRequest
    : null;

''',
    "",
    1,
)
worker = worker.replace(
    between(worker, "async function zoneRuntimeEntrypoint(explicitContext = null) {", "  async function createZone() {"),
    "",
    1,
)
worker = worker.replace(
    '''  function runtimeScriptSource() {
    return `await (${zoneRuntimeEntrypoint.toString()})();`;
  }''',
    "  function runtimeScriptSource() {\n    " + REGION_SCRIPT + "\n  }",
    1,
)
worker = worker.replace(
    between(worker, "/*\n * PF2e Zone GM Worker", "export async function handleWorkerRequest"),
    "/* GM-only actions adapted from PF2e Zone GM Worker v0.5.13. */\n\n",
    1,
)
assert worker.endswith("})();\n")
worker = worker[:-len("})();\n")] + "}\n"
(SCRIPTS / "worker.js").write_text(
    'import { zoneRuntimeEntrypoint } from "./runtime.js";\n\n' + worker,
    encoding="utf-8",
)


builder = BUILDER
builder = builder.replace("(async () => {", "export async function openZoneBuilder() {", 1)
builder = builder.replace(
    between(builder, "  async function zoneRuntimeEntrypoint(explicitContext = null) {", "  const COMMON_TRAITS = ["),
    "",
    1,
)
builder = builder.replace(
    '''    const worker = game.macros.getName(GM_WORKER_NAME);
    if (!worker) throw new Error(`Required macro '${GM_WORKER_NAME}' was not found.`);''',
    '''    const worker = game.user.isGM ? null : game.macros.getName(GM_WORKER_NAME);
    if (!game.user.isGM && !worker) throw new Error(`Required macro '${GM_WORKER_NAME}' was not found.`);''',
    1,
)
builder = builder.replace(
    "    const response = await worker.execute({ pf2eZoneWorkerRequest: request });",
    "    const response = game.user.isGM\n      ? await handleWorkerRequest(request)\n      : await worker.execute({ pf2eZoneWorkerRequest: request });",
    1,
)
builder = builder.replace(
    '''  function runtimeScriptSource() {
    return `await (${zoneRuntimeEntrypoint.toString()})();`;
  }''',
    "  function runtimeScriptSource() {\n    " + REGION_SCRIPT + "\n  }",
    1,
)
builder = builder.replace(
    between(builder, "  async function upgradeExistingZoneRuntimeScripts() {", "  function finiteDurationRounds(cfg) {"),
    "",
    1,
)
builder = builder.replace("  await upgradeExistingZoneRuntimeScripts();\n", "", 1)
builder = builder.replace(
    " * Builds portable zone configurations and creates self-contained Foundry V14\n * Regions with embedded Execute Script runtime behavior. The UI runs on the\n * invoking client; privileged player operations are delegated to the companion\n * PF2e Zone GM Worker macro through Advanced Macros.",
    " * Builds zone configurations and Foundry v14 Regions whose Execute Script\n * behaviors call this module. Player operations currently delegate to the\n * legacy GM Worker macro through Advanced Macros.",
    1,
)
style_match = re.search(r"\n      <style>\n(.*?)\n      </style>", builder, re.S)
assert style_match, "Could not find builder CSS"
style = "\n".join(line[8:] if line.startswith("        ") else line for line in style_match.group(1).splitlines())
(STYLES / "pf2e-zone.css").write_text(style + "\n", encoding="utf-8")
builder = builder[:style_match.start()] + builder[style_match.end():]
assert builder.endswith("})();\n")
builder = builder[:-len("})();\n")] + "}\n"
(SCRIPTS / "builder.js").write_text(
    'import { zoneRuntimeEntrypoint } from "./runtime.js";\n'
    'import { handleWorkerRequest } from "./worker.js";\n\n'
    + builder,
    encoding="utf-8",
)

print("Generated runtime.js, worker.js, builder.js, and pf2e-zone.css")
