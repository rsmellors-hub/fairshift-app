import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { Database } from "@/server/db/client";
import * as schema from "@/server/db/schema";

export async function createTestDatabase() {
  const client = new PGlite();
  const migration = await readFile(path.resolve("drizzle/0000_fairshift_paypal_inbound.sql"), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
  const db = drizzle(client, { schema }) as unknown as Database;
  return { db, close: () => client.close() };
}
