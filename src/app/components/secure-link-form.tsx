"use client";
import { useEffect, useRef, useState } from "react";
// Fragments avoid sending bearer tokens in request URLs, referrers or access logs.
// The code stays a field so a link opened without its fragment can still be completed by hand,
// but someone who followed their link never has to see it. With remember, nothing is submitted:
// the code is only kept in this browser until the person has signed in.
export function SecureLinkForm({action,kind,password=false,remember=false}:{action?:(form:FormData)=>Promise<void>;kind:string;password?:boolean;remember?:boolean}) {
 const input=useRef<HTMLInputElement>(null);
 const [fromLink,setFromLink]=useState(false);
 useEffect(() => {
  const value=window.location.hash.slice(1) || sessionStorage.getItem(`fairshift-${kind}`) || "";
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment only exists in the browser
  if (value) {sessionStorage.setItem(`fairshift-${kind}`,value);if (input.current) input.current.value=value;setFromLink(true);window.history.replaceState(null,"",window.location.pathname);}
 },[kind]);
 if (remember) return null;
 return <form action={action} className="stack-form"><label className={fromLink ? "visually-hidden" : undefined}>Code from your email link<input ref={input} type="password" name="token" autoComplete="off" required /></label>{password ? <label>New password<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /><small>At least 12 characters</small></label>:null}<button className="primary-button">{password ? "Reset password":kind === "invitation" ? "Accept invitation":"Verify my email"}</button></form>;
}
