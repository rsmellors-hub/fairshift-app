// Display formatting with no server or React dependencies, shared by server and client.
export function money(value: number, currency = "USD") {
  return new Intl.NumberFormat(currency === "GBP" ? "en-GB" : "en-US", { style: "currency", currency }).format(value / 100);
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
