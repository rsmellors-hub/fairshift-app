"use client";

import { useState } from "react";
import { openStatementLinkAction } from "@/app/tip-actions";

// Development only: creates a fresh statement link and opens it in this tab. The token travels in
// the action's response body and the URL fragment only, never in a request URL or a server log.
export function StatementLinkButton({ workerId }: { workerId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  return <span>
    <button type="button" className="text-button" data-statement-link={workerId} onClick={async () => {
      const result = await openStatementLinkAction(workerId);
      if ("path" in result) window.location.assign(result.path);
      else setMessage(result.error);
    }}>Open statement link (development only)</button>
    {message ? <small> {message}</small> : null}
  </span>;
}
