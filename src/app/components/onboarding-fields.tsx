import type { users, organisations } from "@/server/db/schema";

type Personal = Partial<Pick<typeof users.$inferSelect, "title" | "firstName" | "surname" | "position" | "telephone">>;
export function PersonalFields({value = {}}: {value?: Personal}) {
  return <>
    <label>Title<select name="title" defaultValue={value.title ?? ""} required><option value="" disabled>Select title</option>{["Mr", "Mrs", "Ms", "Dr", "Other"].map(title => <option key={title}>{title}</option>)}</select></label>
    <label>First name<input name="firstName" defaultValue={value.firstName ?? ""} maxLength={100} required autoComplete="given-name" /></label>
    <label>Surname<input name="surname" defaultValue={value.surname ?? ""} maxLength={100} required autoComplete="family-name" /></label>
    <label>Position / job title<input name="position" defaultValue={value.position ?? ""} maxLength={150} required autoComplete="organization-title" /></label>
    <label>Telephone number<input name="telephone" type="tel" defaultValue={value.telephone ?? ""} maxLength={30} required autoComplete="tel" /></label>
  </>;
}
type Business = Partial<Pick<typeof organisations.$inferSelect, "name" | "businessAddress" | "city" | "province" | "postalCode" | "country">>;
export function BusinessFields({value = {}}: {value?: Business}) {
  return <>
    <label>Business / trading name<input name="name" defaultValue={value.name ?? ""} maxLength={150} required autoComplete="organization" /></label>
    <label>Business address<input name="businessAddress" defaultValue={value.businessAddress ?? ""} maxLength={300} required autoComplete="street-address" /></label>
    <label>City / suburb<input name="city" defaultValue={value.city ?? ""} maxLength={100} required autoComplete="address-level2" /></label>
    <label>Province / state<input name="province" defaultValue={value.province ?? ""} maxLength={100} required autoComplete="address-level1" /></label>
    <label>Postal code<input name="postalCode" defaultValue={value.postalCode ?? ""} maxLength={30} required autoComplete="postal-code" /></label>
    <label>Country<input name="country" defaultValue={value.country ?? ""} maxLength={100} required autoComplete="country-name" /></label>
  </>;
}
