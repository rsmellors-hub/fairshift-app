import { describe, expect, it } from "vitest";
import { brandedHtml, invitationHtml } from "@/server/notifications/templates";

// F15 (12 Nov 2026): every FairShift email uses the invitation email's layout, so a worker's booking,
// pay and sign-in emails look like the invitation that brought them in.
const invitation = invitationHtml({ business: "Test Cafe", inviter: "Sam", role: "TEAM_MEMBER", locations: ["Main"], expiresAt: new Date("2026-11-19T10:00:00Z") }, "https://example.test/invite");
const notice = brandedHtml({ heading: "You're booked", text: "Thu 12 Nov, 07:00–12:00.\n\nSee you there.", link: "https://example.test/shifts?a=1&b=2", action: "View shift" });
// The shell around the content: everything before the content cell opens, and after it closes.
const frame = (html: string) => { const open = html.indexOf('<td style="padding:28px">') + '<td style="padding:28px">'.length; return [html.slice(0, open), html.slice(html.lastIndexOf("</td></tr><tr><td style=\"padding:14px 28px"))]; };

describe("email templates", () => {
  it("wraps notifications in the same frame, header and footer as the invitation", () => {
    expect(frame(notice)).toEqual(frame(invitation));
    expect(notice).toContain("FairShift · PayPal Sandbox · no real money moves.");
  });

  it("keeps the heading, paragraphs, button and fallback link, escaped", () => {
    expect(notice).toContain(">You&#39;re booked</h1>");
    expect(notice.match(/<p style="margin:0 0 16px;font-size:16px/g)).toHaveLength(2);
    expect(notice).toContain('href="https://example.test/shifts?a=1&amp;b=2"');
    expect(notice).toContain(">View shift</a>");
    expect(notice).toContain("Or paste this link into your browser:");
    const hostile = brandedHtml({ heading: "<script>x</script>", text: "<img src=x onerror=1>" });
    expect(hostile).not.toMatch(/<script>|<img/);
    expect(hostile).not.toContain("Or paste this link");
  });
});
