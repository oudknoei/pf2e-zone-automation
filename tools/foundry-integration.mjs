#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_ROOT = path.join(PROJECT_ROOT, ".foundry-integration");
const STATE_FILE = path.join(SERVER_ROOT, "server.json");
const WORLD_TEMPLATE = path.join(PROJECT_ROOT, "tests", "foundry", "world-template");
const WORLD_ID = "pf2e-zone-e2e";
const DEFAULT_PORT = 31_000;
const REQUIRED_MODULES = ["advanced-macros", "pf2e-flatcheck-helper", "lib-wrapper"];

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function envPath(name) {
  const value = String(process.env[name] ?? "").trim();
  return value ? path.resolve(value) : null;
}

function findFoundryInstall() {
  const requested = envPath("FOUNDRY_INSTALL_PATH");
  if (!requested) {
    fail("FOUNDRY_INSTALL_PATH must point to an extracted Foundry VTT Node installation.");
  }

  const candidates = [
    requested,
    path.join(requested, "resources", "app")
  ];
  for (const appRoot of candidates) {
    const packageFile = path.join(appRoot, "package.json");
    if (!fs.existsSync(packageFile)) continue;
    const manifest = readJson(packageFile);
    const main = path.resolve(appRoot, manifest.main ?? "main.js");
    if (!fs.existsSync(main)) continue;
    const release = manifest.release ?? {};
    return {
      appRoot,
      main,
      generation: Number(release.generation ?? 0),
      build: Number(release.build ?? 0),
      version: String(release.version ?? "")
    };
  }

  fail(`Could not find Foundry's package.json and main entry point below ${requested}.`);
}

function findSourceData() {
  const source = envPath("FOUNDRY_DATA_PATH");
  if (!source || !fs.existsSync(path.join(source, "Data", "systems", "pf2e", "system.json"))) {
    fail("FOUNDRY_DATA_PATH must contain Data/systems/pf2e/system.json and the module dependencies.");
  }
  const license = path.join(source, "Config", "license.json");
  if (!fs.existsSync(license)) {
    fail(`A pre-activated Foundry license is required at ${license}.`);
  }
  for (const id of REQUIRED_MODULES) {
    if (!fs.existsSync(path.join(source, "Data", "modules", id, "module.json"))) {
      fail(`Required module '${id}' is missing below ${path.join(source, "Data", "modules")}.`);
    }
  }
  return source;
}

function removeExact(target) {
  const resolved = path.resolve(target);
  const root = path.resolve(SERVER_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail(`Refusing to remove a path outside ${root}: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function linkOrCopy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  removeExact(destination);
  try {
    fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
  } catch {
    fs.cpSync(source, destination, { recursive: true });
  }
}

function copyModuleUnderTest() {
  const destination = path.join(SERVER_ROOT, "Data", "modules", "pf2e-zone-automation");
  removeExact(destination);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["module.json", "scripts", "styles", "packs"]) {
    const source = path.join(PROJECT_ROOT, name);
    if (!fs.existsSync(source)) fail(`Module asset is missing: ${source}`);
    fs.cpSync(source, path.join(destination, name), { recursive: true });
  }
}

async function buildWorld(install, sourceData) {
  const destination = path.join(SERVER_ROOT, "Data", "worlds", WORLD_ID);
  removeExact(destination);
  fs.mkdirSync(path.join(destination, "data"), { recursive: true });

  const world = readJson(path.join(WORLD_TEMPLATE, "world.json"));
  const coreVersion = install.version || [install.generation, install.build].filter(Boolean).join(".");
  if (coreVersion) {
    world.coreVersion = coreVersion;
    world.compatibility = { minimum: "14", verified: coreVersion };
  }
  const system = readJson(path.join(sourceData, "Data", "systems", "pf2e", "system.json"));
  world.systemVersion = system.version;
  writeJson(path.join(destination, "world.json"), world);

  const require = createRequire(path.join(PROJECT_ROOT, "package.json"));
  const { compilePack } = require("@foundryvtt/foundryvtt-cli");
  for (const entry of fs.readdirSync(WORLD_TEMPLATE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await compilePack(
      path.join(WORLD_TEMPLATE, entry.name),
      path.join(destination, "data", entry.name),
      { log: false }
    );
  }
}

async function bootstrap() {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    fail(`Foundry V14 integration tests require Node 24 or newer; current runtime is ${process.version}.`);
  }
  const install = findFoundryInstall();
  if (install.generation && install.generation !== 14) {
    fail(`This module supports Foundry V14, but FOUNDRY_INSTALL_PATH contains generation ${install.generation}.`);
  }
  const sourceData = findSourceData();
  const port = Number(process.env.PZA_FOUNDRY_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    fail(`PZA_FOUNDRY_PORT must be an integer from 1024 through 65535; received '${process.env.PZA_FOUNDRY_PORT}'.`);
  }

  fs.mkdirSync(path.join(SERVER_ROOT, "Config"), { recursive: true });
  fs.copyFileSync(
    path.join(sourceData, "Config", "license.json"),
    path.join(SERVER_ROOT, "Config", "license.json")
  );
  writeJson(path.join(SERVER_ROOT, "Config", "options.json"), {
    port,
    upnp: false,
    telemetry: false,
    hotReload: false,
    compressStatic: true,
    language: "en.core",
    world: WORLD_ID
  });

  linkOrCopy(
    path.join(sourceData, "Data", "systems", "pf2e"),
    path.join(SERVER_ROOT, "Data", "systems", "pf2e")
  );
  for (const id of REQUIRED_MODULES) {
    linkOrCopy(
      path.join(sourceData, "Data", "modules", id),
      path.join(SERVER_ROOT, "Data", "modules", id)
    );
  }
  copyModuleUnderTest();
  await buildWorld(install, sourceData);
  return { install, port };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return readJson(STATE_FILE);
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid) {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`
      ], { encoding: "utf8" });
    }
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function isOwnServer(state) {
  return Boolean(state?.pid && processAlive(state.pid) && processCommand(state.pid).includes(SERVER_ROOT));
}

async function statusAt(url) {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(5_000) });
    const body = response.ok ? await response.json().catch(() => null) : null;
    if (body?.active) return "ready";
    const join = await fetch(`${url}/join`, { redirect: "follow", signal: AbortSignal.timeout(5_000) });
    const location = new URL(join.url).pathname;
    if (location.startsWith("/license")) return "license";
    if (location.startsWith("/setup")) return "setup";
    if (location.startsWith("/auth")) return "auth";
    return "booting";
  } catch {
    return "down";
  }
}

async function waitUntilReady(state) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (!isOwnServer(state)) {
      fail(`Foundry exited during startup. Inspect ${state.logFile}.`);
    }
    const status = await statusAt(state.url);
    if (status === "ready") return;
    if (status === "license") {
      fail("Foundry requires license/EULA interaction. Activate this isolated license state manually, or provide a current pre-activated Config/license.json.");
    }
    if (status === "setup") fail(`Foundry opened setup instead of world '${WORLD_ID}'. Inspect ${state.logFile}.`);
    if (status === "auth") fail("Foundry is asking for an administrator password; use a test data directory without one.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`Foundry did not become ready within 120 seconds. Inspect ${state.logFile}.`);
}

async function stop() {
  const state = readState();
  if (!isOwnServer(state)) return false;
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (processAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  writeJson(STATE_FILE, { ...state, pid: null });
  return true;
}

async function up() {
  const current = readState();
  if (isOwnServer(current) && await statusAt(current.url) === "ready") return current;
  if (isOwnServer(current)) await stop();

  const { install, port } = await bootstrap();
  const logFile = path.join(SERVER_ROOT, "foundry.log");
  const log = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [
    install.main,
    `--dataPath=${SERVER_ROOT}`,
    `--port=${port}`,
    `--world=${WORLD_ID}`,
    "--noupnp"
  ], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.closeSync(log);

  const state = {
    pid: child.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    world: WORLD_ID,
    logFile,
    root: SERVER_ROOT,
    foundryVersion: install.version || `${install.generation}.${install.build}`
  };
  writeJson(STATE_FILE, state);
  await waitUntilReady(state);
  return state;
}

function runPlaywright(url, args) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(command, [
    "exec", "playwright", "test",
    "--config", "tests/foundry/playwright.config.mjs",
    ...args.filter((arg) => arg !== "--")
  ], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    env: { ...process.env, FOUNDRY_URL: url }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "up": {
      const state = await up();
      console.log(`Foundry integration world ready at ${state.url}`);
      break;
    }
    case "down":
      console.log(await stop() ? "Foundry integration server stopped." : "Foundry integration server is not running.");
      break;
    case "status": {
      const state = readState();
      console.log(state ? `${state.url}: ${await statusAt(state.url)}` : "No Foundry integration environment has been created.");
      break;
    }
    case "test": {
      const external = String(process.env.FOUNDRY_URL ?? "").trim();
      const state = external ? { url: external } : await up();
      if (await statusAt(state.url) !== "ready") fail(`A launched Foundry world is not ready at ${state.url}.`);
      runPlaywright(state.url, args);
      break;
    }
    default:
      console.log("Usage: pnpm <foundry:up|foundry:status|foundry:down|test:foundry> [Playwright arguments]");
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`Foundry integration error: ${error?.message ?? error}`);
  process.exitCode = 1;
}
