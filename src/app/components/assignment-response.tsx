"use client";
import { useState } from "react";
import { respondAssignmentAction } from "@/app/operations-actions";

// Only the offer and the version seen are sent: pay and times are never taken from here.
export function AssignmentResponse({ offerId, version, canAccept = true }: { offerId: string; version: number; canAccept?: boolean }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <form action={respondAssignmentAction} className="workspace-form" data-demo-write="">
    <input type="hidden" name="offerId" value={offerId} /><input type="hidden" name="termsVersion" value={version} />
    {canAccept ? <label className="acceptance-check"><input type="checkbox" name="acknowledged" value="yes" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> I’ve read the details above and agree to this work and pay.</label> : null}
    <div className="worker-shift-actions">{canAccept ? <button className="primary-button" name="response" value="ACCEPTED" disabled={!acknowledged}>Accept shift</button> : null}<button className="secondary-button" name="response" value="DECLINED">Decline</button></div>
  </form>;
}
