import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../helpers/database";
import { allocatedWork, payAgentCompany } from "../helpers/pay-agent";
import type { Scope } from "@/server/auth/access";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getDatabase } from "@/server/db/client";
import { confirmWork } from "@/server/scheduling/operations";
import { sendManagerMessage, sendWorkerMessage } from "@/server/worker/inbox";
import { raisePayQuery } from "@/server/worker/pay-queries";
import { WorkerWorkspace } from "@/app/worker/workspace";
import ShiftPayPage from "@/app/worker/pay/[payableId]/page";
import { ManagerWorkspace } from "@/app/manager/workspace";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn(), requireFinancialScope: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, notFound: () => { throw new Error("NOT_FOUND"); }, usePathname: () => "/worker" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// The worker app's screens render from real records (design, 10 Nov 2026, section 6), and the manager sees
// the other side: messages on Team and pay questions on Pay.
describe("worker app screens", () => {
  it("renders Home, Shifts (to do, Month, List), Inbox, Pay, a shift's pay page and Profile", async () => {
    const t = await createTestDatabase();
    try {
      vi.mocked(getDatabase).mockReturnValue(t.db);
      vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true, paypalPayoutConfigured: true } as ReturnType<typeof getConfigurationStatus>);
      const manager = (await payAgentCompany(t.db)).scopes[0];
      const { workerScope, offer, worker } = await allocatedWork(t.db, manager);
      const { payable } = await confirmWork(t.db, offer.id, manager);
      await sendWorkerMessage(t.db, workerScope, "Can I swap this shift?");
      await sendManagerMessage(t.db, manager, worker.id, "Yes, let's talk.");
      await raisePayQuery(t.db, workerScope, { payableId: payable!.id, topic: "HOURS", message: "I stayed late." });
      const render = async (scope: Scope, element: () => Promise<React.ReactNode>) => { vi.mocked(requireScope).mockResolvedValue(scope); return renderToStaticMarkup(await element()); };

      const home = await render(workerScope, () => WorkerWorkspace({ area: "home" }));
      expect(home).toContain("This week’s pay");
      expect(home).toContain("Next 7 days");
      expect(home).toContain("New in your Inbox");
      const month = await render(workerScope, () => WorkerWorkspace({ area: "shifts", view: "month" }));
      expect(month).toContain("month-grid");
      const list = await render(workerScope, () => WorkerWorkspace({ area: "shifts", view: "list" }));
      expect(list).toContain("Worked");
      expect(list).toContain(`/worker/pay/${payable!.id}`);
      const inbox = await render(workerScope, () => WorkerWorkspace({ area: "inbox" }));
      expect(inbox).toContain("Can I swap this shift?");
      expect(inbox).toContain("Yes, let&#x27;s talk.");
      expect(inbox).toContain("Running 10 minutes late");
      const pay = await render(workerScope, () => WorkerWorkspace({ area: "pay" }));
      expect(pay).toContain(`/worker/pay/${payable!.id}`);
      vi.mocked(requireScope).mockResolvedValue(workerScope);
      const page = renderToStaticMarkup(await ShiftPayPage({ params: Promise.resolve({ payableId: payable!.id }), searchParams: Promise.resolve({}) }));
      expect(page).toContain("This shift’s pay");
      expect(page).toContain("Query this shift’s pay");
      expect(page).toContain("I stayed late.");
      await expect(ShiftPayPage({ params: Promise.resolve({ payableId: "00000000-0000-4000-8000-000000000000" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
      const profile = await render(workerScope, () => WorkerWorkspace({ area: "profile" }));
      expect(profile).toContain("Sign out");

      const team = await render(manager, () => ManagerWorkspace({ area: "team", thread: worker.id }));
      expect(team).toContain("Messages from your team");
      expect(team).toContain("Can I swap this shift?");
      const review = await render({ ...manager, role: "OWNER" }, () => ManagerWorkspace({ area: "review" }));
      expect(review).toContain("Questions about pay · 1");
      expect(review).toContain("Send answer");
    } finally { await t.close(); }
  });
});
