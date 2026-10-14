import Link from "next/link";

export default function CheckoutCancel() {
  return (
    <main className="centered-shell">
      <div className="brand"><span>F</span><strong>FairShift</strong></div>
      <div className="result-card">
        <span className="status pending">SANDBOX · CANCELLED</span>
        <h2>Buyer approval was cancelled</h2>
        <p>No PayPal capture was attempted and the FairShift transaction remains unverified.</p>
        <Link className="text-link" href="/">Return to FairShift</Link>
      </div>
    </main>
  );
}
