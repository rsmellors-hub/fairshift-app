import { assertSandboxDeployment } from "@/server/config/deployment";
import { getPayPalConfig } from "@/server/config/env";
import { PayPalClient } from "@/server/integrations/paypal/client";
import { getPayPalPayoutConfig } from "@/server/config/env";
import { PAYPAL_SANDBOX_API_BASE_URL, PayPalPayoutClient } from "@/server/integrations/paypal/payout-client";
import type { PayoutCredentials } from "@/server/payments/business-paypal";

export function getPayPalClient() {
  assertSandboxDeployment();
  return new PayPalClient(getPayPalConfig());
}

// The platform app by default; a business's own app when the payout was reserved under it.
// Sandbox negative-test notes are only ever sent through the platform app.
export function getPayPalPayoutClient(credentials: PayoutCredentials = { kind: "PLATFORM" }) {
  assertSandboxDeployment();
  if (credentials.kind === "PLATFORM") return new PayPalPayoutClient(getPayPalPayoutConfig());
  return new PayPalPayoutClient({ PAYPAL_CLIENT_ID: credentials.clientId, PAYPAL_CLIENT_SECRET: credentials.secret, apiBaseUrl: PAYPAL_SANDBOX_API_BASE_URL }, fetch, 10_000, false);
}
