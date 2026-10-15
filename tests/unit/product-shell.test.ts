import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ManagerLayout from "@/app/manager/layout";
import OwnerLayout from "@/app/owner/layout";
import OwnerPage from "@/app/owner/page";
import WorkerLayout from "@/app/worker/layout";
import WorkerPage from "@/app/worker/page";
import { StatePanel } from "@/app/components/product-ui";
import { getConfigurationStatus } from "@/server/config/env";

vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));

describe("shared product shell", () => {
  it("renders semantic manager navigation without presenting future destinations as links", () => {
    const html = renderToStaticMarkup(createElement(ManagerLayout, null, createElement("p", null, "Manager content")));

    expect(html).toContain('<nav class="product-nav" aria-label="Manager navigation">');
    expect(html).toContain('href="/manager"');
    expect(html).toContain("Forecast &amp; Staffing");
    expect(html).not.toContain('href="/manager/forecast"');
    expect(html).toContain("access controls are not yet implemented");
    expect(html).not.toContain("signed in");
  });

  it("renders the worker shell with current Home and mobile navigation", () => {
    const html = renderToStaticMarkup(createElement(WorkerLayout, null, createElement("p", null, "Worker content")));

    expect(html).toContain('aria-label="Worker navigation"');
    expect(html).toContain('aria-label="Worker mobile navigation"');
    expect(html).toContain('href="/worker"');
    expect(html).not.toContain('href="/worker/earnings"');
  });

  it("renders a truthful minimum owner context", () => {
    const html = renderToStaticMarkup(createElement(OwnerLayout, null, createElement(OwnerPage)));

    expect(html).toContain("Company overview");
    expect(html).toContain("PayPal Sandbox connected");
    expect(html).toContain("Zettle needs verification");
    expect(html).toContain("No multi-location figures are shown yet");
    expect(html).not.toContain("Zettle connected");
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

    const html = renderToStaticMarkup(createElement(WorkerLayout, null, await WorkerPage()));
    expect(html).toContain("Shift information is unavailable");
    expect(html).not.toContain("migration");
    expect(html).not.toContain("persisted");
  });

  it("provides reusable, semantic status panels", () => {
    const html = renderToStaticMarkup(createElement(StatePanel, { title: "Payment needs attention", tone: "danger" }, "Try again"));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Payment needs attention");
  });
});
