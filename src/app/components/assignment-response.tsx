"use client";
import { useState } from "react";
import { respondAssignmentAction } from "@/app/operations-actions";

export function AssignmentResponse({ offerId, version }: { offerId: string; version: number }) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <form action={respondAssignmentAction} className="workspace-form">
    <input type="hidden" name="offerId" value={offerId} /><input type="hidden" name="termsVersion" value={version} />
    <label className="acceptance-check"><input type="checkbox" name="acknowledged" value="yes" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> I have reviewed and accept the terms of this work assignment, including the location, department, scheduled time, earnings terms and applicable incentive terms.</label>
    <div className="inline-form"><button className="primary-button" name="response" value="ACCEPTED" disabled={!acknowledged}>Accept shift</button><button className="secondary-button" name="response" value="DECLINED">Decline offer</button></div>
  </form>;
}
