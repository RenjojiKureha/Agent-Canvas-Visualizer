/**
 * Validates env vars at startup. Throws with a clear message when required
 * config is missing (e.g. AGENT_PROVIDER=api without an API key).
 */
export function assertEnv(): void {
  const provider = (process.env.AGENT_PROVIDER || "api").toLowerCase();

  if (provider === "api") {
    const apiKey =
      process.env.AGENT_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "AGENT_PROVIDER=api but no API key found. " +
          "Set AGENT_API_KEY (or DEEPSEEK_API_KEY / OPENAI_API_KEY) in .env.",
      );
    }
  } else if (provider === "claude") {
    // Claude CLI mode only needs `claude` on PATH — no env key required.
    // AGENT_COMMAND is optional; defaults to "claude".
  } else {
    throw new Error(
      `Unknown AGENT_PROVIDER "${provider}". Expected "api" or "claude".`,
    );
  }

  if (process.env.PORT && !Number.isFinite(Number(process.env.PORT))) {
    throw new Error(`PORT must be numeric; got "${process.env.PORT}"`);
  }
}
