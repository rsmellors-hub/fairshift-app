import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ManagerLayout from "@/app/manager/layout";
import OwnerLayout from "@/app/owner/layout";
import WorkerLayout from "@/app/worker/layout";
import WorkerPage from "@/app/worker/page";
import OperatorLayout from "@/app/operator/layout";
import { StatePanel } from "@/app/components/product-ui";
import { getConfigurationStatus } from "@/server/config/env";

vi.mock("@/server/auth/request",()=>({requireScope:async()=>({organisationName:"Demo",locationName:"Rosebank Kitchen"}),requireOperator:async()=>({id:"operator"})}));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/worker/earnings" }));

describe("shared product shell", () => {
  it("links all manager functions inside the manager workspace", async () => {
    const html = renderToStaticMarkup(await ManagerLayout({children:createElement("p", null, "Manager content")}));

    expect(html).toContain('<nav class="product-nav" aria-label="Manager navigation">');
    expect(html).toContain('href="/manager"');
    expect(html).toContain("Today");
    expect(html).not.toContain("Worker Pool");
    for (const area of ["plan", "team", "review"]) expect(html).toContain(`href="/manager/${area}"`);
    expect(html).not.toContain("Coming next");
    expect(html).not.toContain('href="/worker');
    expect(html).not.toContain('href="/operator');
    expect(html).not.toContain("signed in");
  });

  it("renders the worker shell with current Home and mobile navigation", async () => {
    const html = renderToStaticMarkup(await WorkerLayout({children:createElement("p", null, "Worker content")}));

    expect(html).toContain('aria-label="Worker navigation"');
    expect(html).toContain('aria-label="Worker mobile navigation"');
    expect(html).toContain('href="/worker"');
    for (const area of ["shifts", "earnings", "profile"]) expect(html).toContain(`href="/worker/${area}"`);
    expect(html).toContain('aria-current="page" href="/worker/earnings"');
    expect(html).not.toContain('aria-current="page" href="/worker"');
    expect(html).not.toContain('href="/manager');
  });

  it("renders a truthful minimum owner context", async () => {
    const html = renderToStaticMarkup(await OwnerLayout({children:"Owner content"}));
    for (const area of ["locations", "forecast", "reporting", "workforce", "policies", "payments", "settings"]) expect(html).toContain(`href="/owner/${area}"`);
    expect(html).toContain("Owner mobile navigation");
    expect(html).toContain("Skip to content");
    expect(html).toContain("Incentives<small>Not available</small>");
    expect(html).not.toContain('href="/owner/incentives"');
    expect(html).toContain('href="/account"');
    expect(html).not.toContain('href="/manager');
  });

  it("keeps the existing worker route usable when its data is unavailable", async () => {
    vi.mocked(getConfigurationStatus).mockReturnValue({
      databaseConfigured: false,
      paypalConfigured: false,
      paypalPayoutConfigured: false,
      aiConfigured: false,
      environment: "NOT CONFIGURED",
      currency: "USD",
      amount: "5.00",
    });

    const html = renderToStaticMarkup(await WorkerLayout({children:await WorkerPage()}));
    expect(html).toContain("Workspace information is unavailable");
    expect(html).not.toContain("migration");
    expect(html).not.toContain("persisted");
  });

  it("keeps environment controls in a distinct operator shell", async () => {
    const html = renderToStaticMarkup(await OperatorLayout({children:"Operator content"}));
    expect(html).toContain('aria-label="Operator navigation"');
    expect(html).toContain('href="/operator/environment"');
    expect(html).toContain('href="/operator/integrations"');
    expect(html).not.toContain('href="/manager');
  });

  it("provides reusable, semantic status panels", async () => {
    const html = renderToStaticMarkup(createElement(StatePanel, { title: "Payment needs attention", tone: "danger" }, "Try again"));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Payment needs attention");
  });
});
