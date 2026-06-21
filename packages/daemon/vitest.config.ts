import { defineConfig, configDefaults } from 'vitest/config'

// Default `npm test` runs the standard suite. The Phase 0 regression suite
// under test/regression/** is intentionally pre-fix RED and is excluded here
// so CI for Phase 1-5 PRs (which branch from main) stays green. It is run
// separately via `npm run test:regression`. Phase 5 T5-0 wires it back into
// the CI gate once all four fixtures turn green.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/regression/**'],
  },
})
