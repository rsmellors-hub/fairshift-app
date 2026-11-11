// NEXT_PUBLIC_DESIGN_V2 switches the restyle (design, 10 Nov 2026) on or off. It is on unless set to
// "off", "false" or "0", and it changes only how pages look: markup, data and actions are the same.
export function designV2Enabled(value: string | undefined = process.env.NEXT_PUBLIC_DESIGN_V2) {
  return !["off", "false", "0"].includes((value ?? "").trim().toLowerCase());
}
