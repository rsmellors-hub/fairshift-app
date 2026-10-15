import { getPayPalConfig } from "@/server/config/env";
import { PayPalClient } from "@/server/integrations/paypal/client";
import { getPayPalPayoutConfig } from "@/server/config/env";
import { PayPalPayoutClient } from "@/server/integrations/paypal/payout-client";

export function getPayPalClient() {
  return new PayPalClient(getPayPalConfig());
}

export function getPayPalPayoutClient() {
  return new PayPalPayoutClient(getPayPalPayoutConfig());
}
