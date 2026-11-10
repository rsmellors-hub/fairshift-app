import { completeInvitationAction, openInvitationAction } from "@/app/people-actions";

// Joining by invitation through the real actions (Day 6, 10 Nov 2026): open the invitation, then complete
// sign-up with the person's details. Server actions end in a redirect, which tests see as a thrown
// "REDIRECT:<path>" (the tests' next/navigation mock); this returns the final one.
const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
const redirectOf = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.startsWith("REDIRECT:")) return message; throw error; } return "NO_REDIRECT"; };

export const WORKER_SIGN_UP = { firstName: "Casey", surname: "Person", telephone: "", payoutEmail: "casey.sandbox@example.test", confirmPayoutEmail: "casey.sandbox@example.test",
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`day${i + 1}`, "AVAILABLE"])) };

export async function joinByInvitation(token: string, details: Record<string, string> = WORKER_SIGN_UP) {
  const opened = await redirectOf(() => openInvitationAction(form({ token })));
  if (opened !== "REDIRECT:/invite?step=details") return opened;
  return redirectOf(() => completeInvitationAction(form(details)));
}
