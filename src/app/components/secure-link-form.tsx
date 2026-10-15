"use client";
import { useEffect, useRef } from "react";
// Fragments avoid sending bearer tokens in request URLs, referrers or access logs.
export function SecureLinkForm({action,kind,password=false}:{action:(form:FormData)=>Promise<void>;kind:string;password?:boolean}) {
 const input=useRef<HTMLInputElement>(null);
 useEffect(() => {
  const value=window.location.hash.slice(1) || sessionStorage.getItem(`fairshift-${kind}`) || "";
  if (value && input.current) {sessionStorage.setItem(`fairshift-${kind}`,value);input.current.value=value;window.history.replaceState(null,"",window.location.pathname);}
 },[kind]);
 return <form action={action} className="workspace-form"><label>Secure link code<input ref={input} type="password" name="token" autoComplete="off" required /></label>{password ? <label>New password<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></label>:null}<button className="primary-button">{password ? "Reset password":kind === "invitation" ? "Redeem invitation":"Verify email"}</button></form>;
}
