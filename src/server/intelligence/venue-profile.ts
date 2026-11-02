import { z } from "zod";

// FS-CONTEXT-SIGNALS-DEC-001 D-S1. The closed set of venue profiles. A profile is product context
// the model may reason with. It is never a coefficient: no code here or elsewhere applies a
// weather or event effect by profile. No profile means unknown, never assumed.
export const VENUE_PROFILES = ["STADIUM_DISTRICT", "WATERFRONT_OUTDOOR", "BUSINESS_DISTRICT", "STATION_COMMUTER", "SHOPPING_CENTRE"] as const;
export type VenueProfile = typeof VENUE_PROFILES[number];
export const VENUE_PROFILE_LABEL: Readonly<Record<VenueProfile, string>> = { STADIUM_DISTRICT: "Stadium district", WATERFRONT_OUTDOOR: "Waterfront and outdoor", BUSINESS_DISTRICT: "Business district", STATION_COMMUTER: "Station and commuter", SHOPPING_CENTRE: "Shopping centre" };
export const venueProfileOf = (value: string | null | undefined): VenueProfile | null => VENUE_PROFILES.includes(value as VenueProfile) ? value as VenueProfile : null;

const blankIsNull = (value: unknown) => typeof value === "string" && value.trim() === "" ? null : value;
const coordinate = (limit: number) => z.preprocess(blankIsNull, z.coerce.number().min(-limit).max(limit).nullable());

// What an Owner states for a location. Coordinates come as a pair or not at all.
export const venueContextSchema = z.object({
  venueProfile: z.preprocess(blankIsNull, z.enum(VENUE_PROFILES).nullable()),
  latitude: coordinate(90),
  longitude: coordinate(180),
}).strict().refine(value => (value.latitude === null) === (value.longitude === null), "Enter both coordinates or neither.");
