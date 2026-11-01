"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { refreshSquareSalesAction, type SquareRefreshState } from "@/app/square-actions";

const POLL_MS = 10_000;
const time = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeStyle: "medium", timeZone }).format(new Date(iso));

// Keeps a page showing Square-attributed figures current through the normal sync. The page is
// reloaded only when its sales changed, whichever viewer's sync found them, so a half-completed form on it is not disturbed. When
// Square can't be read, it says so: the figures on the page are then older, not zero.
export function SquareLiveRefresh({ timeZone, initial }: { timeZone: string; initial: SquareRefreshState }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const shown = useRef(initial.revision);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const next = await refreshSquareSalesAction().catch(() => ({ revision: null, failed: true, lastCheckedAt: null }));
      if (stopped) return;
      setState(previous => ({ ...next, lastCheckedAt: next.lastCheckedAt ?? previous.lastCheckedAt }));
      if (next.revision && next.revision !== shown.current) { shown.current = next.revision; router.refresh(); }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [router]);
  return <p className="note" role={state.failed ? "alert" : "status"}>
    {state.failed ? "Square could not be checked just now. " : "Checking Square Sandbox for new sales automatically. "}
    {state.lastCheckedAt ? `Last checked ${time(state.lastCheckedAt, timeZone)}.` : "Not checked yet, so sales are not known."}
    {state.failed ? " These figures may be out of date. They do not mean no sales happened." : ""}
  </p>;
}
