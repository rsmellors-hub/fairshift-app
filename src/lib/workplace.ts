import { z } from "zod";

const requiredText = (max: number, message: string) => z.string().trim().min(1, message).max(max, `Use ${max} characters or fewer.`);
export const personalDetails = z.object({
  title: z.enum(["Mr", "Mrs", "Ms", "Dr", "Other"]).nullable().optional(),
  firstName: requiredText(100, "Enter your first name."),
  surname: requiredText(100, "Enter your last name."),
  position: requiredText(150, "Enter your job title."),
  telephone: z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/, "Enter a phone number with 6–30 characters."),
});
export const addressDetails = z.object({
  businessAddress: requiredText(300, "Enter the street address."),
  city: requiredText(100, "Enter the city."),
  province: z.string().trim().max(100).optional(),
  postalCode: requiredText(30, "Enter the postcode."),
  country: requiredText(100, "Enter the country."),
});
export const workplaceDetails = personalDetails.extend({
  name: requiredText(150, "Enter your business name."),
  locationName: requiredText(150, "Enter your location name."),
  locationAddress: requiredText(300, "Enter the location’s street address."),
  locationCity: requiredText(100, "Enter the location’s city."),
  locationProvince: z.string().trim().max(100).optional(),
  locationPostalCode: requiredText(30, "Enter the location’s postcode."),
  locationCountry: requiredText(100, "Enter the location’s country."),
  sameAddress: z.boolean(),
  businessAddress: z.string().trim().max(300).optional(),
  city: z.string().trim().max(100).optional(),
  province: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(30).optional(),
  country: z.string().trim().max(100).optional(),
}).strict().superRefine((value, context) => {
  if (!value.sameAddress) {
    const result = addressDetails.safeParse(value);
    if (!result.success) for (const issue of result.error.issues) context.addIssue({code: "custom", path: issue.path, message: issue.message});
  }
});
export type WorkplaceInput = z.input<typeof workplaceDetails>;
export type WorkplaceFormState = {errors?: Record<string, string>; message?: string};
export function workplaceErrors(input: unknown): Record<string, string> {
  const result = workplaceDetails.safeParse(input);
  return result.success ? {} : Object.fromEntries(result.error.issues.map(issue => [String(issue.path[0]), issue.message]));
}
