import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Database } from "@/server/db/client";
import * as schema from "@/server/db/schema";

// In-memory by default. With a data directory the database persists on disk, so a test can
// close it and open it again to check what survives a process restart.
export async function createTestDatabase(dataDir?: string) {
  const client = new PGlite(dataDir);
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "drizzle" });
  const db = database as unknown as Database;
  return { db, close: () => client.close() };
}
