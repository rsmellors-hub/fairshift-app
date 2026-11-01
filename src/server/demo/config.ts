import { z } from "zod";

export const DEMO_PERSONAS = ["OWNER", "MANAGER", "WORKER"] as const;
export type DemoPersona = typeof DEMO_PERSONAS[number];
export const demoPersona = z.enum(DEMO_PERSONAS);
export const DEMO_MEMBERSHIP_ROLE: Record<DemoPersona, string> = { OWNER: "OWNER", MANAGER: "MANAGER", WORKER: "TEAM_MEMBER" };
export const DEMO_HOME: Record<DemoPersona, string> = { OWNER: "/owner", MANAGER: "/manager", WORKER: "/worker" };
export const DEMO_SESSION_MS = 2 * 60 * 60_000;

const uuid = z.uuid();

// Public demo access is off unless every value is present and valid. The identities come only
// from here, so nothing in a request can name a user, a membership or an organisation.
export function demoConfig(env: Record<string, string | undefined> = process.env) {
  if (env.FAIRSHIFT_PUBLIC_DEMO !== "enabled") return null;
  const parsed = z.object({ organisationId: uuid, OWNER: uuid, MANAGER: uuid, WORKER: uuid }).safeParse({
    organisationId: env.FAIRSHIFT_DEMO_ORGANISATION_ID,
    OWNER: env.FAIRSHIFT_DEMO_OWNER_MEMBERSHIP_ID,
    MANAGER: env.FAIRSHIFT_DEMO_MANAGER_MEMBERSHIP_ID,
    WORKER: env.FAIRSHIFT_DEMO_WORKER_MEMBERSHIP_ID,
  });
  if (!parsed.success || new Set([parsed.data.OWNER, parsed.data.MANAGER, parsed.data.WORKER]).size !== 3) return null;
  return parsed.data;
}
export type DemoConfig = NonNullable<ReturnType<typeof demoConfig>>;
