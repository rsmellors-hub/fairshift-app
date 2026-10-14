import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Database } from "@/server/db/client";
import * as schema from "@/server/db/schema";

export async function createTestDatabase() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "drizzle" });
  const db = database as unknown as Database;
  return { db, close: () => client.close() };
}
