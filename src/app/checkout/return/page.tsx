import { requireOperator } from "@/server/auth/request";
import Link from "next/link";

import { CaptureOrder } from "@/app/components/capture-order";

export default async function CheckoutReturn({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  await requireOperator();
  const { token } = await searchParams;
  return (
    <main className="centered-shell">
      <div className="brand"><span>F</span><strong>FairShift</strong></div>
      {token ? (
        <CaptureOrder orderId={token} />
      ) : (
        <div className="result-card">
          <span className="status failed">FAILED</span>
          <h2>Missing PayPal order reference</h2>
          <p>The return URL did not contain the PayPal order token. No capture was attempted.</p>
          <Link className="text-link" href="/">Return to FairShift</Link>
        </div>
      )}
    </main>
  );
}
