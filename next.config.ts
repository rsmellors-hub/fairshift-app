import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  // Server Function arguments are never logged: some carry secrets, such as a staff statement
  // link token (src/app/staff-actions.ts), which must not reach logs or analytics.
  logging: { serverFunctions: false },
  async headers() { return [{source:"/:path*",headers:[{key:"Referrer-Policy",value:"no-referrer"},{key:"X-Content-Type-Options",value:"nosniff"}]}]; },
};

export default nextConfig;
