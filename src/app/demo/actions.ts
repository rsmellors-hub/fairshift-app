"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_COOKIE, requireScope, SESSION_COOKIE, setSessionCookie } from "@/server/auth/request";
import { revokeSession } from "@/server/auth/identity";
import { getDatabase } from "@/server/db/client";
import { DEMO_HOME, demoConfig } from "@/server/demo/config";
import { planningChanged } from "@/server/intelligence/planning-cache";
import { UserFacingError } from "@/server/domain/errors";
import { resetDemo } from "@/server/demo/fixtures";
import { enterDemo, switchDemoPersona } from "@/server/demo/session";

// Only the persona's name is read from a form. Who that is comes from server configuration.
const persona = (form: FormData) => form.get("persona");

async function setDemoCookies(token: string, expiresAt: Date) {
  await setSessionCookie(token, expiresAt);
  // Holds no identity: it only lets an expired demo session return to the demo page.
  (await cookies()).set(DEMO_COOKIE, "1", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 24 * 3600 });
}

export async function enterDemoAction(form: FormData) {
  let destination: string;
  try {
    const session = await enterDemo(getDatabase(), demoConfig(), persona(form));
    await setDemoCookies(session.token, session.expiresAt);
    (await cookies()).delete("fairshift_location");
    destination = DEMO_HOME[session.persona];
  } catch { destination = "/demo?status=unavailable"; }
  redirect(destination);
}

export async function switchDemoPersonaAction(form: FormData) {
  let destination: string;
  try {
    const session = await switchDemoPersona(getDatabase(), demoConfig(), (await cookies()).get(SESSION_COOKIE)?.value, persona(form));
    (await cookies()).delete("fairshift_location");
    destination = DEMO_HOME[session.persona];
  } catch { destination = "/demo?status=expired"; }
  redirect(destination);
}

export async function resetDemoAction() {
  const scope = await requireScope(["OWNER", "MANAGER", "TEAM_MEMBER"], { demoWrite: true });
  const home = scope.demo ? DEMO_HOME[scope.demo.persona] : scope.role === "OWNER" ? "/owner" : scope.role === "MANAGER" ? "/manager" : "/worker";
  let status = "demo-reset";
  try { await resetDemo(getDatabase(), demoConfig(), scope); planningChanged(); }
  catch (error) { status = error instanceof UserFacingError ? error.feedback : "error"; }
  redirect(`${home}?status=${status}`);
}

export async function exitDemoAction() {
  const jar = await cookies(), token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(getDatabase(), token);
  jar.delete(SESSION_COOKIE); jar.delete(DEMO_COOKIE); jar.delete("fairshift_location");
  redirect("/demo");
}
