import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
    // Type errors in the tests, or in the sources they use, fail the run, so
    // the tests cannot drift from the code they test.
    typecheck: {
      enabled: true,
      include: ["test/**/*.test.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
});
