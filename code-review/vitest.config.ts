import { defineConfig } from "vitest/config";

// Real-data tests only (no mocks): unit specs colocate in src/**/__tests__/.
// Network is stubbed only at the fetch boundary by replaying REAL recorded
// OpenRouter responses; git tests build real repos in temp dirs. The one module-level
// mock is the spy-mode wrap of @actions/core's logger (see clearMocks below), which
// keeps every implementation real and only makes the exports observable.
// Vite resolves the "@/*" -> src/* alias from tsconfig at test time.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    // Several suites drive REAL git through a PATH shim (a bash wrapper that logs
    // argv then execs the real binary) over repos with hundreds of changed files —
    // src/git/__tests__/spawncount.test.ts, diff.test.ts, batchRead.test.ts. Every
    // git call is two processes, so they are CPU-bound, not hung: under a fully
    // parallel run they exceed 30s while passing in seconds alone. 120s keeps a
    // genuinely stuck test failing without penalising an honest slow one.
    testTimeout: 120_000,
    // Clear every spy's call history before each test. The @actions/core logger is
    // spied through a spy-mode module mock (it is native ESM, so its namespace cannot be
    // patched directly), and since vitest 3 `vi.restoreAllMocks()` no longer clears the
    // history of such spies — without this, a warning emitted by one test counts against
    // the next test's "no warning" assertion.
    clearMocks: true,
  },
});
