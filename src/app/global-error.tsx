"use client";

import "./styles.css";
import Link from "next/link";

import { AuthShell } from "@/app/components/auth-shell";

// Replaces the root layout when the layout itself fails, so it supplies its own html and body.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en">
    <body>
      <AuthShell title="Something went wrong">
        <p>FairShift couldn’t load just now. Nothing you saved has been lost.</p>
        {error.digest ? <p className="auth-switch">Reference: {error.digest}</p> : null}
        <button className="primary-button" type="button" onClick={() => reset()}>Try again</button>
        <p className="auth-switch"><Link href="/">Go to the home page</Link></p>
      </AuthShell>
    </body>
  </html>;
}
