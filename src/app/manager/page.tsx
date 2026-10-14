import { ManagerForecast } from "@/app/components/manager-forecast";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { getManagerForecast } from "@/server/intelligence/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ManagerPage() {
  if (!getConfigurationStatus().databaseConfigured) {
    return <ManagerForecast result={null} error="PostgreSQL is not configured. Connect the database to read persisted commercial history." />;
  }
  let result;
  try {
    result = await getManagerForecast(getDatabase());
  } catch {
    return <ManagerForecast result={null} error="Commercial history could not be loaded or validated. Check the database connection and migrations." />;
  }
  return <ManagerForecast result={result} />;
}
