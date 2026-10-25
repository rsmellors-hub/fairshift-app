import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(directory, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each integration test boots and migrates an in-process PGlite (WASM Postgres).
    // Running files concurrently starves those instances of CPU and produces timeouts,
    // so files run one at a time; tests inside a file are already sequential.
    fileParallelism: false,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
