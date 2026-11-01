import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import OwnerPage from "@/app/owner/page";
import OwnerLoading from "@/app/owner/loading";
import { OwnerOverview } from "@/app/owner/overview";
import { requireScope } from "@/server/auth/request";
import { getConfigurationStatus } from "@/server/config/env";
import { getOwnerOverview, ownerForecastSummary, ownerStaffingSummary, type OwnerOverviewData } from "@/server/product/owner-overview";
import { getWeeklyForecast } from "@/server/intelligence/weekly";
import { getWeeklyStaffing } from "@/server/intelligence/staffing";

vi.mock("@/server/auth/request", () => ({ requireScope: vi.fn() }));
vi.mock("@/server/config/env", () => ({ getConfigurationStatus: vi.fn() }));
vi.mock("@/server/db/client", () => ({ getDatabase: () => ({}) }));
vi.mock("@/server/product/owner-overview", () => ({ getOwnerOverview: vi.fn(), ownerForecastSummary: vi.fn(), ownerStaffingSummary: vi.fn() }));
vi.mock("@/server/intelligence/weekly", () => ({ getWeeklyForecast: vi.fn() }));
vi.mock("@/server/intelligence/staffing", () => ({ getWeeklyStaffing: vi.fn() }));
const empty: OwnerOverviewData = { locations: [{ id: "one", name: "One location", timezone: "UTC", active: true }], series: [], attention: [], payables: { awaitingApproval: 0, needsAttention: 0 }, salesUnavailable: false };
afterEach(() => vi.resetAllMocks());

describe("Owner Overview route and states", () => {
  it("requires Owner scope before configuration or data access", async () => {
    vi.mocked(requireScope).mockRejectedValue(new Error("REDIRECT:/account"));
    await expect(OwnerPage({})).rejects.toThrow("REDIRECT:/account");
    expect(requireScope).toHaveBeenCalledWith(["OWNER"]);
    expect(getConfigurationStatus).not.toHaveBeenCalled();
    expect(getOwnerOverview).not.toHaveBeenCalled();
  });
  it("shows a recoverable page error when organisation data fails", async () => {
    vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
    vi.mocked(getOwnerOverview).mockRejectedValue(new Error("private diagnostic detail"));
    const html = renderToStaticMarkup(await OwnerPage({}));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Reload Overview");
    expect(html).not.toContain("private diagnostic detail");
  });
  it("passes only authenticated scope to the data service", async () => {
    const scope = { organisationId: "authenticated-tenant", role: "OWNER" } as Awaited<ReturnType<typeof requireScope>>;
    vi.mocked(requireScope).mockResolvedValue(scope);
    vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
    vi.mocked(getOwnerOverview).mockResolvedValue(empty);
    expect(renderToStaticMarkup(await OwnerPage({}))).toContain("One location");
    expect(getOwnerOverview).toHaveBeenCalledWith({}, scope);
  });
  it("keeps the factual Overview when the weekly forecast fails, without inventing demand", async () => {
    vi.mocked(requireScope).mockResolvedValue({ organisationId: "tenant", role: "OWNER" } as Awaited<ReturnType<typeof requireScope>>);
    vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
    vi.mocked(getOwnerOverview).mockResolvedValue(empty);
    vi.mocked(getWeeklyForecast).mockRejectedValue(new Error("forecast store offline"));
    const html = renderToStaticMarkup(await OwnerPage({}));
    expect(html).toContain("One location");
    expect(html).toContain("The weekly forecast could not be loaded. No demand has been assumed.");
    expect(html).not.toContain("forecast store offline");
    expect(ownerForecastSummary).not.toHaveBeenCalled();
  });
  it("keeps the factual Overview when staffing coverage fails, without showing a zero gap", async () => {
    vi.mocked(requireScope).mockResolvedValue({ organisationId: "tenant", role: "OWNER" } as Awaited<ReturnType<typeof requireScope>>);
    vi.mocked(getConfigurationStatus).mockReturnValue({ databaseConfigured: true } as ReturnType<typeof getConfigurationStatus>);
    vi.mocked(getOwnerOverview).mockResolvedValue(empty);
    vi.mocked(getWeeklyStaffing).mockRejectedValue(new Error("coverage store offline"));
    const html = renderToStaticMarkup(await OwnerPage({}));
    expect(html).toContain("One location");
    expect(html).toContain("Coverage could not be loaded. No gap has been assumed.");
    expect(html).not.toContain("coverage store offline");
    expect(html).not.toMatch(/>0 h</);
    expect(ownerStaffingSummary).not.toHaveBeenCalled();
  });
  it("does not represent missing sales, forecast, or staffing as zero", () => {
    const html = renderToStaticMarkup(createElement(OwnerOverview, { data: empty }));
    expect(html).toContain("No sales history available");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("Covered");
    expect(html).toContain("Not available");
    expect(html).not.toMatch(/>0 h</);
    expect(html).toContain("No incentive approvals or failed payments recorded");
    expect(html).toContain('href="/owner/locations/one"');
    for (const route of ["reporting", "forecast", "payments"]) expect(html).toContain(`href="/owner/${route}"`);
  });
  it("shows meaningful loading text with stable placeholder regions", () => {
    const html = renderToStaticMarkup(createElement(OwnerLoading));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading organisation overview");
    expect(html).toContain("owner-loading-chart");
  });
});
