import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "@/server/config/env";
import * as schema from "@/server/db/schema";

export type Database = NodePgDatabase<typeof schema>;
// Shared operations available on both a connection and a Drizzle transaction.
export type DatabaseSession = Pick<Database, "select" | "insert" | "update">;

const globalForDatabase = globalThis as unknown as {
  fairshiftPool?: Pool;
  fairshiftDatabase?: Database;
};

export function getDatabase(): Database {
  if (globalForDatabase.fairshiftDatabase) {
    return globalForDatabase.fairshiftDatabase;
  }

  const { DATABASE_URL } = getDatabaseConfig();
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: process.env.NODE_ENV === "test" ? 2 : 10,
    application_name: "fairshift",
  });

  const database = drizzle(pool, { schema });

  // One pool per process in every environment. Creating a pool per call exhausts
  // PostgreSQL connections under normal navigation; the global also survives
  // development hot reloads.
  globalForDatabase.fairshiftPool = pool;
  globalForDatabase.fairshiftDatabase = database;

  return database;
}
