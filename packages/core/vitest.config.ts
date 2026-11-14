import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        // Principio 3: el guard va 100% cubierto.
        "src/guard/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
