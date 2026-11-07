"use server";

import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { UserFacingError } from "@/server/domain/errors";
import { readStatement, updateStatementDestination } from "@/server/tips/statement";

// The staff statement's only entry points. They take the link token in the request body (it is
// never in a URL the server sees) and return plain data; every failure is the same message.
const UNAVAILABLE = "This link has expired or isn't valid. Ask your employer for a new one.";

export async function loadStatementAction(token: string) {
  if (!getConfigurationStatus().databaseConfigured) return { error: UNAVAILABLE };
  try {
    const statement = await readStatement(getDatabase(), token);
    return statement ? { statement: JSON.parse(JSON.stringify(statement)) as typeof statement } : { error: UNAVAILABLE };
  } catch { return { error: UNAVAILABLE }; }
}

export async function updateDestinationAction(token: string, action: "CONFIRM" | "CHANGE", email?: string) {
  if (!getConfigurationStatus().databaseConfigured) return { error: UNAVAILABLE };
  try {
    const result = await updateStatementDestination(getDatabase(), token, { action: action === "CHANGE" ? "CHANGE" : "CONFIRM", email });
    return { done: result.kind };
  } catch (error) {
    return { error: error instanceof UserFacingError && error.feedback !== "statement-unavailable" ? error.message : UNAVAILABLE };
  }
}
