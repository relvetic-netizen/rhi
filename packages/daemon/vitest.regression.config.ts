import { defineConfig } from 'vitest/config'

// Regression suite-only config. Used by `npm run test:regression` to opt back
// into the Phase 0 fixtures that vitest.config.ts excludes from the default run.
// Phase 5 T5-0 wires this script into the CI gate once all four fixtures
// turn green (see docs/memory-hardening-sprint-2026-05-18-v3.md § Phase 5).
export default defineConfig({
  test: {},
})
