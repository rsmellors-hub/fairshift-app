"use client";

import { useState } from "react";

// Password managers and paste keep working; the toggle lets someone check what they typed.
export function PasswordField({ label, autoComplete, minLength, hint }: { label: string; autoComplete: "new-password" | "current-password"; minLength?: number; hint?: string }) {
  const [shown, setShown] = useState(false);
  return <div className="password-field">
    <label htmlFor="password">{label}</label>
    <div className="password-field-row">
      <input id="password" name="password" type={shown ? "text" : "password"} required minLength={minLength} maxLength={128} autoComplete={autoComplete} aria-describedby={hint ? "password-hint" : undefined} />
      <button type="button" className="link-button" aria-pressed={shown} onClick={() => setShown(value => !value)}>{shown ? "Hide" : "Show"}<span className="visually-hidden"> password</span></button>
    </div>
    {hint ? <small id="password-hint">{hint}</small> : null}
  </div>;
}
