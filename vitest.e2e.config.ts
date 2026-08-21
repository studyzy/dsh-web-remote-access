import { defineConfig } from 'vitest/config'

/**
 * E2E lane: spawns a REAL `dsh web` against an isolated $DSH_HOME and drives
 * the browser with Playwright. The default vitest lane (`vitest run`) excludes
 * `tests/e2e/**`; run this lane explicitly with `pnpm test:e2e`.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 300_000,
    hookTimeout: 240_000,
  },
})
