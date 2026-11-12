"use client";

import { useEffect, useState } from "react";

// The design's toast: a polite status message at the bottom of the screen after an action.
// It shows what the server already reported (for example the page's ?status= result); it never
// claims an outcome on its own. It hides after a while and can be dismissed sooner.
export function Toast({ message, hideAfterMs = 6000 }: { message?: string | null; hideAfterMs?: number }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!message || hideAfterMs <= 0) return;
    const timer = setTimeout(() => setDismissed(message), hideAfterMs);
    return () => clearTimeout(timer);
  }, [message, hideAfterMs]);
  if (!message || dismissed === message) return null;
  return <div className="fs-toast" role="status" aria-live="polite">
    <span>{message}</span>
    <button type="button" onClick={() => setDismissed(message)} aria-label="Dismiss message">Close</button>
  </div>;
}
