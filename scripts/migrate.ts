import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

const databaseUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"))
  .parse(process.env.DATABASE_URL);

const pool = new Pool({ connectionString: databaseUrl, application_name: "fairshift-migrate" });

try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  console.log("FairShift database migrations completed.");
} finally {
  await pool.end();
}
