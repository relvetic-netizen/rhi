// Vitest global setup — runs before any test module loads.
// Sets dummy values for env vars that src/config.ts reads at import time via
// requireEnv() (which calls process.exit(1) when missing). This keeps the test
// suite hermetic: no real secrets required in the environment.
process.env.DISCORD_BOT_TOKEN ||= "test-token";
