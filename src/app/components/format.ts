// Display formatting with no server or React dependencies, shared by server and client.
// Rand is written the South African way, "R135.00", as on the price list: workers and owners see rand
// first (Owner decision, 8 November 2026). The ISO code "ZAR" belongs only in technical and audit fields.
export function rand(value: number, options: { whole?: boolean } = {}) {
  const digits = options.whole ? 0 : 2;
  return `${value < 0 ? "-" : ""}R${new Intl.NumberFormat("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(value) / 100)}`;
}

export function money(value: number, currency = "USD", options: { whole?: boolean } = {}) {
  if (currency === "ZAR") return rand(value, options);
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", { style: "currency", currency, ...(options.whole ? { maximumFractionDigits: 0 } : {}) }).format(value / 100);
}

// A converted amount PayPal pays, shown after the rand amount and always labelled with its currency.
export function labelledMoney(value: number, currency: string) {
  if (currency === "USD") return `US$${new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100)}`;
  return `${money(value, currency)} (${currency})`;
}

export function scheduledHours(startsAt: Date, endsAt: Date) {
  const hours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000;
  return `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(hours)} ${hours === 1 ? "hour" : "hours"}`;
}

// Enough of an address to recognise it, for anyone who can see this screen.
export function maskedEmail(value: string) {
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}•••@${domain}`;
}
