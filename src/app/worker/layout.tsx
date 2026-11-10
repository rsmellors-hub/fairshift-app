import { requireScope } from "@/server/auth/request";
import { getDatabase } from "@/server/db/client";
import { workerUnread } from "@/server/worker/inbox";
import { ProductShell } from "@/app/components/product-shell";
import { DemoBar, SandboxBar } from "@/app/demo/demo-bar";
import { isDemoOrganisation } from "@/server/demo/organisation";

// Design, 10 Nov 2026 (worker app): Home · Shifts · Inbox (unread badge) · Pay · Profile.
const navigation = (unread: number) => [
  { label: "Home", href: "/worker" },
  { label: "Shifts", href: "/worker/shifts" },
  { label: "Inbox", href: "/worker/inbox", count: unread },
  { label: "Pay", href: "/worker/pay" },
  { label: "Profile", href: "/worker/profile" },
];

export default async function WorkerLayout({ children }: { children: React.ReactNode }) {
  const scope=await requireScope(["TEAM_MEMBER"]);
  // The badge counts what the Inbox shows as new; if it can't be read, no badge rather than a wrong one.
  const unread = scope.demo ? 0 : await (async () => workerUnread(getDatabase(), scope))().catch(() => 0);
  return <ProductShell banner={scope.demo ? <DemoBar persona={scope.demo.persona} /> : undefined} notice={!scope.demo && isDemoOrganisation(scope.organisationId) ? <SandboxBar /> : undefined} role="Worker" context={scope.locationName} navigation={navigation(unread)} mobile>{children}</ProductShell>;
}
