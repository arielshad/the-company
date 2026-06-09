import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    environmentMatchGlobs: [["apps/web/**", "jsdom"]],
    setupFiles: ["./apps/web/src/test-setup.ts"],
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx", "e2e/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/**/src/**", "apps/**/src/**"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "apps/web/src/main.tsx",
        "apps/web/src/server/**",
        "apps/web/src/app/**/*.tsx",
        "apps/web/src/app/lib/platform.ts"
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70
      }
    }
  }
});
