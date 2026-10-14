import { getPayPalConfig } from "@/server/config/env";

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(getPayPalConfig().APP_BASE_URL).origin;
  if (!origin || origin !== expected) {
    throw new OriginError();
  }
}

export class OriginError extends Error {
  readonly status = 403;
  constructor() {
    super("Request origin was not accepted.");
    this.name = "OriginError";
  }
}
