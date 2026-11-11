"use client";

import Link from "next/link";

import { AuthShell } from "@/app/components/auth-shell";

// Shown when a page fails on the server or in the browser. It never shows the error itself:
// the digest lets support find the server log without exposing details to the visitor.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AuthShell title="Something went wrong">
    <p>This page couldn’t load just now. Nothing you saved has been lost.</p>
    {error.digest ? <p className="auth-switch">Reference: {error.digest}</p> : null}
    <button className="primary-button" type="button" onClick={() => reset()}>Try again</button>
    <p className="auth-switch"><Link href="/">Go to the home page</Link></p>
  </AuthShell>;
}
