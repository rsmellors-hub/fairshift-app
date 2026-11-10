// The official FairShift emails (Day 6, 10 Nov 2026 Owner decision): one plain-text and one branded HTML
// version of the same words. Every value is escaped; nothing here is model-written.

const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export type InvitationEmail = { business: string; inviter: string; inviterRole?: "OWNER" | "MANAGER"; invitee?: string; role: "MANAGER" | "TEAM_MEMBER"; locations: string[]; expiresAt: Date; timezone?: string };

const roleText = (role: InvitationEmail["role"]) => role === "MANAGER" ? "Manager" : "Casual worker";
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const day = (date: Date, timezone?: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: timezone ?? "UTC" }).format(date);

// Design (EmailInvite, 10 Nov 2026) and the Owner's subject decision of the same day.
export function invitationSubject(input: Pick<InvitationEmail, "business">) {
  return `You're invited to work shifts at ${input.business || "your workplace"}`;
}
function invitationParts(input: InvitationEmail) {
  const business = input.business || "your workplace";
  const by = `${input.inviter}${input.inviterRole ? `, ${input.inviterRole === "OWNER" ? "Owner" : "Manager"}` : ""}`;
  return {
    heading: `${input.inviter} invited you to work shifts at ${business}`,
    intro: `Hi${input.invitee ? ` ${input.invitee}` : ""}, ${business} uses FairShift to offer shifts fairly and pay you through PayPal after each shift. Accept the invitation to set up your account.`,
    rows: [["Business", business], [input.locations.length > 1 ? "Locations" : "Location", list(input.locations)], ["Role", roleText(input.role)], ["Invited by", by]] as [string, string][],
    expiry: `This link expires on ${day(input.expiresAt, input.timezone)} (7 days). If it expires, ask ${input.inviterRole === "OWNER" ? "the owner" : "your manager"} to resend it.`,
    next: ["Confirm your email and choose a password.", input.role === "TEAM_MEMBER" ? "Add when you can work and the PayPal email you want your pay sent to." : "Confirm your name and contact details.",
      input.role === "TEAM_MEMBER" ? `You'll start receiving shift offers for ${list(input.locations)}.` : `You'll manage shifts at ${list(input.locations)}.`],
    footer: `You received this because ${business} added this email to their team on FairShift. Not expecting it? Ignore this email and no account is created.`,
  };
}

// The body stored with the notification (the outbox record) and sent as the plain-text email.
export function invitationText(input: InvitationEmail) {
  const part = invitationParts(input);
  return [part.heading, part.intro, part.rows.map(([k, v]) => `${k}: ${v}`).join("\n"), part.expiry,
    `What happens next\n${part.next.map((line, i) => `${i + 1}. ${line}`).join("\n")}`,
    "We never ask for your home address, ID number or bank details.", part.footer].join("\n\n");
}

export function invitationHtml(input: InvitationEmail, link: string, reportLink?: string) {
  const part = invitationParts(input);
  const rows = part.rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#65635E;font-size:14px;width:120px">${escape(k)}</td><td style="padding:6px 0;font-size:14px;color:#121110">${escape(v)}</td></tr>`).join("");
  const steps = part.next.map(line => `<li style="margin:0 0 6px">${escape(line)}</li>`).join("");
  return shell(`<p style="margin:0 0 6px;font:500 11px/1 monospace;letter-spacing:.08em;text-transform:uppercase;color:#65635E">Team invitation</p>
    <h1 style="margin:0 0 16px;font:400 28px/1.15 Georgia,serif;color:#121110">${escape(part.heading)}</h1>
    <p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#3A3936">${escape(part.intro)}</p>
    <table role="presentation" width="100%" style="border-top:1px solid #DEDCD6;border-bottom:1px solid #DEDCD6;margin:0 0 20px">${rows}</table>
    <p style="margin:0 0 12px"><a href="${escape(link)}" style="display:inline-block;background:#121110;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Accept invitation and sign up</a></p>
    <p style="margin:0 0 20px;font-size:13px;color:#65635E">${escape(part.expiry)}</p>
    <p style="margin:0 0 6px;font-weight:600;font-size:14px">What happens next</p><ol style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#3A3936">${steps}</ol>
    <p style="margin:0 0 16px;font-size:13px;color:#65635E">We never ask for your home address, ID number or bank details.</p>
    <p style="margin:0;font-size:12px;color:#8C8A84">${escape(part.footer)}${reportLink ? ` <a href="${escape(reportLink)}" style="color:#65635E">Report this invitation</a>.` : ""}</p>`);
}

function shell(content: string) {
  return `<!doctype html><html><body style="margin:0;background:#F4F3EF;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #DEDCD6"><tr><td style="padding:18px 28px;border-bottom:1px solid #DEDCD6"><strong style="font-size:17px;color:#121110">FairShift</strong></td></tr><tr><td style="padding:28px">${content}</td></tr><tr><td style="padding:14px 28px;border-top:1px solid #DEDCD6;font-size:12px;color:#8C8A84">FairShift · PayPal Sandbox · no real money moves.</td></tr></table></td></tr></table></body></html>`;
}

// Wraps any notification's text and link in FairShift's email layout.
export function brandedHtml(input: { heading: string; text: string; link?: string; action?: string }) {
  const paragraphs = input.text.split(/\n\n+/).map(p => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2a24">${escape(p)}</p>`).join("");
  const button = input.link ? `<p style="margin:24px 0"><a href="${escape(input.link)}" style="display:inline-block;background:#0f6b4f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${escape(input.action ?? "Open FairShift")}</a></p><p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#5b6660">Or paste this link into your browser:<br><span style="word-break:break-all">${escape(input.link)}</span></p>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #dfe5e2"><tr><td style="padding:20px 28px;border-bottom:1px solid #dfe5e2"><strong style="font-size:18px;color:#0f6b4f">FairShift</strong></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#1f2a24">${escape(input.heading)}</h1>${paragraphs}${button}</td></tr><tr><td style="padding:16px 28px;border-top:1px solid #dfe5e2;font-size:12px;color:#5b6660">FairShift · workforce planning and transparent pay</td></tr></table></td></tr></table></body></html>`;
}
