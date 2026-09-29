const FOUNDRY_URL = process.env.FOUNDRY_URL || "http://127.0.0.1:31000";

export default async function globalSetup() {
  let status;
  try {
    const response = await fetch(`${FOUNDRY_URL}/api/status`, { signal: AbortSignal.timeout(5_000) });
    status = response.ok ? await response.json() : null;
  } catch {
    status = null;
  }
  if (!status?.active) {
    throw new Error(
      `A launched Foundry world is required at ${FOUNDRY_URL}. ` +
      "Set FOUNDRY_INSTALL_PATH and FOUNDRY_DATA_PATH, then run pnpm test:foundry."
    );
  }
}
