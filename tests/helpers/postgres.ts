import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import type { Database } from "@/server/db/client";
import * as schema from "@/server/db/schema";

// A disposable database on a real PostgreSQL server, for unique-constraint and concurrency
// checks across separate connections, which the in-process PGlite (one connection) cannot
// exercise. Used only when FAIRSHIFT_TEST_POSTGRES_URL names a scratch server on which tests may
// create and drop their own uniquely named databases; never an application database.
export const TEST_POSTGRES_URL = process.env.FAIRSHIFT_TEST_POSTGRES_URL;

async function admin<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: TEST_POSTGRES_URL, application_name: "fairshift-test-admin" });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

export async function createPostgresTestDatabase() {
  if (!TEST_POSTGRES_URL) throw new Error("FAIRSHIFT_TEST_POSTGRES_URL is not set.");
  const name = `fairshift_test_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await admin(client => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(TEST_POSTGRES_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 16, application_name: "fairshift-test" });
  const db = drizzle(pool, { schema }) as unknown as Database;
  await migrate(db, { migrationsFolder: "drizzle" });
  return {
    db, name,
    close: async () => {
      await pool.end();
      await admin(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
