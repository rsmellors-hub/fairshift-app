import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// Regression for local environment leakage into tests (finding A of the Pay Agent review): with
// Vite's default envDir, a developer's .env files put VITE_-prefixed values into process.env and
// import.meta.env of every test worker. The repository Vitest configuration must load none of
// the four files. Synthetic canary values only.
it("loads no .env, .env.local, .env.test or .env.test.local into test workers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fs-vitest-env-canary-"));
  try {
    mkdirSync(path.join(root, "tests"));
    copyFileSync("vitest.config.ts", path.join(root, "vitest.config.ts"));
    copyFileSync("package.json", path.join(root, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const names = ["OPENAI_API_KEY", "PAYPAL_CLIENT_SECRET", "DATABASE_URL", "VITE_OPENAI_API_KEY", "VITE_PAYPAL_CLIENT_SECRET", "VITE_DISK_CANARY"];
    for (const file of [".env", ".env.local", ".env.test", ".env.test.local"]) {
      writeFileSync(path.join(root, file), names.map(name => `${name}=synthetic-disk-canary`).join("\n"));
    }
    writeFileSync(path.join(root, "tests/observer.test.ts"), `import { expect, it } from "vitest";
it("sees none of the disk canaries", () => {
  for (const name of ${JSON.stringify(names)}) {
    expect(Object.hasOwn(process.env, name), name).toBe(false);
    expect(Object.hasOwn(import.meta.env, name), name).toBe(false);
  }
});
`);
    const child = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--root", root], {
      cwd: root, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stdout).toMatch(/1 passed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
