// Runs once when a Next.js server instance starts. The Pay Agent recovery sweep is started
// without waiting for it, so the server never waits on the model or the database to be ready.
// The import sits inside the NEXT_RUNTIME check (Next.js's documented pattern) so the Edge bundle
// of this file drops it entirely: an early return is not enough, and webpack would otherwise try
// to bundle the database driver for Edge and fail on Node built-ins.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPayAgentRecovery } = await import("@/server/pay-agent/service");
    startPayAgentRecovery();
  }
}
