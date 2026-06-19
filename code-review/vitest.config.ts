import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Real-data tests only (no mocks): unit specs colocate in src/**/__tests__/.
// Network is stubbed only at the fetch boundary by replaying REAL recorded
// OpenRouter responses; git tests build real repos in temp dirs.
// tsconfigPaths() resolves the "@/*" -> src/* alias from tsconfig at test time.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
