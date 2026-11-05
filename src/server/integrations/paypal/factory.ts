import { assertSandboxDeployment } from "@/server/config/deployment";
import { getPayPalConfig } from "@/server/config/env";
import { PayPalClient } from "@/server/integrations/paypal/client";
import { getPayPalPayoutConfig } from "@/server/config/env";
import { PayPalPayoutClient } from "@/server/integrations/paypal/payout-client";

export function getPayPalClient() {
  assertSandboxDeployment();
  return new PayPalClient(getPayPalConfig());
}

export function getPayPalPayoutClient() {
  assertSandboxDeployment();
  return new PayPalPayoutClient(getPayPalPayoutConfig());
}
