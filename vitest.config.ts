import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["engine/**/*.test.ts"],
    exclude: [".worktrees/**", "src/**", "node_modules/**"],
  },
});
