import { getPayPalConfig } from "@/server/config/env";
import { PayPalClient } from "@/server/integrations/paypal/client";

export function getPayPalClient() {
  return new PayPalClient(getPayPalConfig());
}
