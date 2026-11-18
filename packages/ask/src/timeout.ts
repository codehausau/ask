export const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;

/** Explicit flag wins over the environment (exported, or from a settings file).
 * The SDK takes milliseconds, the user seconds.
 */
export function responseTimeoutMs(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = flag ?? env["ASK_TIMEOUT"];
  if (raw === undefined) return DEFAULT_RESPONSE_TIMEOUT_MS;
  const milliseconds = Number(raw) * 1000;
  if (!raw.trim() || !Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
    throw new Error(`${flag === undefined ? "ASK_TIMEOUT" : "--timeout"} must be positive seconds (at least 0.001, at most 2147483.647).`);
  }
  return milliseconds;
}

/** Validate configured seconds and convert them for the SDK. */
export function timeoutSecondsToMs(seconds: number): number {
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2_147_483_647) {
    throw new Error("timeout must be positive seconds (at least 0.001, at most 2147483.647).");
  }
  return milliseconds;
}
