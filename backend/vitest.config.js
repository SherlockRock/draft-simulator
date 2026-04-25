import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    testTimeout: 30000,
    server: {
      deps: {
        // .node native modules can't be transformed by Vite — externalize so
        // they pass through Node's require() unchanged.
        external: ["@draft-sim/engine-node"],
      },
    },
  },
});
