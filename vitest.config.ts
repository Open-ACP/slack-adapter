import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@openacp/cli": resolve(__dirname, "node_modules/@openacp/cli/dist/index.js"),
    },
  },
  test: {
    environment: "node",
  },
});
