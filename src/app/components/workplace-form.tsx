"use client";

import { useActionState, useEffect, useState } from "react";
import { completeWorkplaceAction } from "@/app/auth-actions";
import { workplaceErrors, type WorkplaceInput } from "@/lib/workplace";

export function WorkplaceForm({initial, email}: {initial: WorkplaceInput; email: string}) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [state, action, pending] = useActionState(completeWorkplaceAction, {});
  useEffect(() => {
    const first = Object.keys(state.errors ?? {})[0];
    if (first) document.getElementById(first)?.focus();
  }, [state]);
  function field(name: keyof WorkplaceInput, label: string, autoComplete: string, maxLength: number, type = "text") {
    const error = errors[name] ?? state.errors?.[name];
    return <div className="workplace-field" key={name}>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type={type} value={String(values[name] ?? "")} required maxLength={maxLength}
        autoComplete={autoComplete} inputMode={type === "tel" ? "tel" : undefined} readOnly={pending}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-error` : undefined}
        onChange={event => {setValues({...values, [name]: event.target.value}); setErrors(previous => ({...previous, [name]: ""}));}}
        onBlur={() => setErrors(previous => ({...previous, [name]: workplaceErrors(values)[name] ?? ""}))}/>
      {error ? <p className="field-error" id={`${name}-error`}>{error}</p> : null}
    </div>;
  }
  return <form className="workplace-form" action={action} noValidate onSubmit={event => {
    if (pending) {event.preventDefault(); return;}
    const next = workplaceErrors(values);
    setErrors(next);
    if (Object.keys(next).length) {event.preventDefault(); document.getElementById(Object.keys(next)[0])?.focus();}
  }}>
    <section aria-labelledby="about-you"><h2 id="about-you">About you</h2><div className="workplace-grid">
      {field("firstName", "First name", "given-name", 100)}{field("surname", "Last name", "family-name", 100)}
      {field("position", "Job title", "organization-title", 150)}{field("telephone", "Phone", "tel", 30, "tel")}
    </div><p className="verified-email">Verified email · {email}</p></section>
    <section aria-labelledby="your-business"><h2 id="your-business">Your business</h2>
      {field("name", "Business name", "organization", 150)}
    </section>
    <section aria-labelledby="your-location"><h2 id="your-location">Your first location</h2>
      <p className="field-intro">A location sets its own currency and time zone from its country, and has its own manager and workers.</p>
      <div className="workplace-grid">
        <div className="full-width">{field("locationName", "Location name", "section-location organization", 150)}</div>
        <div className="full-width">{field("locationAddress", "Address", "section-location street-address", 300)}</div>
        {field("locationCity", "City", "section-location address-level2", 100)}
        {field("locationPostalCode", "Postcode", "section-location postal-code", 30)}
        <div className="full-width">{field("locationCountry", "Country", "section-location country-name", 100)}</div>
      </div>
      <label className="same-address"><input name="sameAddress" type="checkbox" checked={values.sameAddress} disabled={pending}
        onChange={event => setValues({...values, sameAddress:event.target.checked})}/>Use this location as my business address</label>
    </section>
    {!values.sameAddress ? <section aria-labelledby="business-address"><h2 id="business-address">Business address</h2><div className="workplace-grid">
      <div className="full-width">{field("businessAddress", "Address", "section-business street-address", 300)}</div>
      {field("city", "City", "section-business address-level2", 100)}{field("postalCode", "Postcode", "section-business postal-code", 30)}
      <div className="full-width">{field("country", "Country", "section-business country-name", 100)}</div>
    </div></section> : null}
    {state.message ? <p role="alert" className="form-message">{state.message}</p> : null}
    {Object.values(errors).some(Boolean) ? <p role="alert" className="form-message">Check the highlighted details and try again.</p> : null}
    <button className="primary-button" disabled={pending}>{pending ? "Preparing your workplace…" : "Continue to FairShift"}</button>
    <span role="status" className="visually-hidden">{pending ? "Saving your workplace." : ""}</span>
  </form>;
}
