// Runs once when a Next.js server instance starts. The Pay Agent recovery sweep is started
// without waiting for it, so the server never waits on the model or the database to be ready.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPayAgentRecovery } = await import("@/server/pay-agent/service");
  startPayAgentRecovery();
}
