import { applicationOrigin } from "@/server/notifications/email";
import { invitationHtml, invitationSubject, type InvitationEmail } from "@/server/notifications/templates";

// What a new team member will receive (design: OwnerLocation "Preview the invitation email"). The real
// template, with this location and the signed-in person as inviter; the link here goes nowhere.
export function InvitationPreview({ email }: { email: InvitationEmail }) {
  const html = invitationHtml(email, `${applicationOrigin()}/invite`);
  return <div className="product-page"><header className="owner-heading"><div><p className="eyebrow">Preview</p><h1>The invitation email</h1>
    <p className="panel-lede">From FairShift &lt;no-reply@notify.getafairshift.com&gt; · Subject: {invitationSubject(email)}</p></div></header>
    <iframe title="Invitation email preview" srcDoc={html} sandbox="" style={{ width: "100%", maxWidth: 640, height: 900, border: "1px solid var(--line, #ddd)", borderRadius: 12, background: "#fff" }} /></div>;
}
