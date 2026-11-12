// Reserved names (RFC 2606, RFC 6761): mail to them can never reach a real person. Demo, judge and test
// accounts use them, so FairShift never asks the email service to send to them (12 Nov 2026): a send
// would only bounce, and bounces count against the sending domain.
export function isReservedTestAddress(email: string | null | undefined) {
  const domain = email?.split("@")[1]?.trim().toLowerCase().replace(/>$/, "") ?? "";
  return /(^|\.)(test|example|invalid|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org)$/.test(domain);
}
export const RESERVED_TEST_ADDRESS = "RESERVED_TEST_ADDRESS";
