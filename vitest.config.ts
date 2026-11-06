import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Never load .env, .env.local, .env.test or .env.test.local into tests: with Vite's default
  // envDir, VITE_-prefixed values from those files reach process.env and import.meta.env.
  // Tests must not pick up a developer's local credentials or configuration.
  envDir: false,
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
    // Long multi-role journeys can pass 5 seconds on a busy machine without anything being wrong.
    testTimeout: 30_000,
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
