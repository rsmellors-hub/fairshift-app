// The official FairShift emails (Day 6, 10 Nov 2026 Owner decision): one plain-text and one branded HTML
// version of the same words. Every value is escaped; nothing here is model-written.

const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export type InvitationEmail = { business: string; inviter: string; role: "MANAGER" | "TEAM_MEMBER"; locations: string[]; expiresAt: Date; timezone?: string };

const roleText = (role: InvitationEmail["role"]) => role === "MANAGER" ? "a Manager" : "a casual worker";
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const day = (date: Date, timezone?: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone ?? "UTC", timeZoneName: "short" }).format(date);

export function invitationSubject(input: Pick<InvitationEmail, "business">) {
  return `${input.business || "A business"} invited you to FairShift`;
}

// The body stored with the notification (the outbox record) and sent as the plain-text email.
export function invitationText(input: InvitationEmail) {
  return [
    `${input.inviter} has invited you to join ${input.business} on FairShift as ${roleText(input.role)} at ${list(input.locations)}.`,
    "Open the link below to create your account: you'll set a password and confirm your details" + (input.role === "TEAM_MEMBER" ? ", your availability and the PayPal email you're paid at." : "."),
    `The link expires on ${day(input.expiresAt, input.timezone)}. If it has expired, ask ${input.inviter} to send a new one.`,
    "If you weren't expecting this, you can ignore this email: nothing happens unless you open the link and sign up.",
  ].join("\n\n");
}

// Wraps any notification's text and link in FairShift's email layout.
export function brandedHtml(input: { heading: string; text: string; link?: string; action?: string }) {
  const paragraphs = input.text.split(/\n\n+/).map(p => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#1f2a24">${escape(p)}</p>`).join("");
  const button = input.link ? `<p style="margin:24px 0"><a href="${escape(input.link)}" style="display:inline-block;background:#0f6b4f;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${escape(input.action ?? "Open FairShift")}</a></p><p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#5b6660">Or paste this link into your browser:<br><span style="word-break:break-all">${escape(input.link)}</span></p>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f6f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;border:1px solid #dfe5e2"><tr><td style="padding:20px 28px;border-bottom:1px solid #dfe5e2"><strong style="font-size:18px;color:#0f6b4f">FairShift</strong></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#1f2a24">${escape(input.heading)}</h1>${paragraphs}${button}</td></tr><tr><td style="padding:16px 28px;border-top:1px solid #dfe5e2;font-size:12px;color:#5b6660">FairShift · workforce planning and transparent pay</td></tr></table></td></tr></table></body></html>`;
}
