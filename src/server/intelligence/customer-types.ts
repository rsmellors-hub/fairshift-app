// Who a location's customers are (design, Owner instruction 10 Nov 2026, section 3). A closed list: each
// type switches on fixed local-signal categories, so what the AI looks for at a location is decided in
// code, consistent and explainable. The optional note can only narrow a search, never widen it. Every
// finding records the type that triggered it, and the screen shows that reason.

export const CUSTOMER_TYPES = ["OFFICE", "STUDENTS", "TOURISTS", "THEATRE_EVENTS", "SPORTS", "FAMILIES", "SHOPPERS", "COMMUTERS", "NIGHT_OUT"] as const;
export type CustomerType = typeof CUSTOMER_TYPES[number];

export const SIGNAL_CATEGORIES = [
  "PUBLIC_HOLIDAYS", "OFFICE_CLOSURES", "TRANSPORT_STRIKES", "TERM_AND_EXAM_DATES", "CAMPUS_EVENTS", "FESTIVALS", "CRUISE_DAYS", "MAJOR_EVENTS",
  "NEARBY_SHOWS", "MATCH_DAYS", "SCHOOL_HOLIDAYS", "FAMILY_EVENTS", "PAYDAYS", "MALL_HOURS", "SALES", "TRANSPORT_DISRUPTIONS", "ROAD_CLOSURES",
  "LATE_EVENTS", "CONCERTS", "LONG_WEEKENDS",
] as const;
export type SignalCategory = typeof SIGNAL_CATEGORIES[number];

export const CUSTOMER_TYPE_SIGNALS: Record<CustomerType, readonly SignalCategory[]> = {
  OFFICE: ["PUBLIC_HOLIDAYS", "OFFICE_CLOSURES", "TRANSPORT_STRIKES"],
  STUDENTS: ["TERM_AND_EXAM_DATES", "CAMPUS_EVENTS"],
  TOURISTS: ["FESTIVALS", "CRUISE_DAYS", "MAJOR_EVENTS"],
  THEATRE_EVENTS: ["NEARBY_SHOWS"],
  SPORTS: ["MATCH_DAYS"],
  FAMILIES: ["SCHOOL_HOLIDAYS", "FAMILY_EVENTS"],
  SHOPPERS: ["PAYDAYS", "MALL_HOURS", "SALES"],
  COMMUTERS: ["TRANSPORT_DISRUPTIONS", "ROAD_CLOSURES"],
  NIGHT_OUT: ["LATE_EVENTS", "CONCERTS", "LONG_WEEKENDS"],
};

export const CUSTOMER_TYPE_LABEL: Record<CustomerType, string> = {
  OFFICE: "Office workers", STUDENTS: "Students", TOURISTS: "Tourists", THEATRE_EVENTS: "Theatre and event-goers", SPORTS: "Sports fans",
  FAMILIES: "Families", SHOPPERS: "Shoppers", COMMUTERS: "Commuters", NIGHT_OUT: "Night-out crowd",
};
export const CUSTOMER_TYPE_CHECKS: Record<CustomerType, string> = {
  OFFICE: "public holidays, office closures, strikes on transport routes", STUDENTS: "term and exam dates, campus events",
  TOURISTS: "festivals, cruise days, major events", THEATRE_EVENTS: "shows and events at nearby venues", SPORTS: "match days at nearby grounds",
  FAMILIES: "school holidays, family events", SHOPPERS: "paydays, mall trading hours, sales", COMMUTERS: "transport disruptions, road closures",
  NIGHT_OUT: "late events, concerts, long weekends",
};

export const SIGNAL_CATEGORY_LABEL: Record<SignalCategory, string> = {
  PUBLIC_HOLIDAYS: "public holidays", OFFICE_CLOSURES: "office closures", TRANSPORT_STRIKES: "strikes on transport routes", TERM_AND_EXAM_DATES: "term and exam dates",
  CAMPUS_EVENTS: "campus events", FESTIVALS: "festivals", CRUISE_DAYS: "cruise days", MAJOR_EVENTS: "major events", NEARBY_SHOWS: "shows at nearby venues",
  MATCH_DAYS: "match days at nearby grounds", SCHOOL_HOLIDAYS: "school holidays", FAMILY_EVENTS: "family events", PAYDAYS: "paydays", MALL_HOURS: "mall trading hours",
  SALES: "sales", TRANSPORT_DISRUPTIONS: "transport disruptions", ROAD_CLOSURES: "road closures", LATE_EVENTS: "late events", CONCERTS: "concerts", LONG_WEEKENDS: "long weekends",
};

// The signal categories a location's customer types switch on, each with the type that switched it on
// (the first, in the fixed list order, when two types share one).
export function signalCategoriesFor(types: readonly string[]): { category: SignalCategory; triggeredBy: CustomerType }[] {
  const chosen = CUSTOMER_TYPES.filter(type => types.includes(type));
  const seen = new Map<SignalCategory, CustomerType>();
  for (const type of chosen) for (const category of CUSTOMER_TYPE_SIGNALS[type]) if (!seen.has(category)) seen.set(category, type);
  return [...seen].map(([category, triggeredBy]) => ({ category, triggeredBy }));
}

// Suggested types from an Owner's earlier free-text description, for the Owner to confirm. Word matches
// only; nothing is applied until the Owner saves.
const HINTS: Record<CustomerType, RegExp> = {
  OFFICE: /\boffice|business district|corporate|workers? (at|from) (offices|work)|lunch crowd\b/i,
  STUDENTS: /\bstudents?|campus|universit|college\b/i,
  TOURISTS: /\btourist|visitors?|holidaymakers?|cruise\b/i,
  THEATRE_EVENTS: /\btheatre|theater|show|concert hall|event-?goers?|arts? centre\b/i,
  SPORTS: /\bsports?|stadium|match|fans?\b/i,
  FAMILIES: /\bfamil(y|ies)|kids|children|parents\b/i,
  SHOPPERS: /\bshoppers?|shopping|mall|retail\b/i,
  COMMUTERS: /\bcommuters?|station|gautrain|train|bus|taxi rank|transport\b/i,
  NIGHT_OUT: /\bnight|evening crowd|bar crowd|late\b/i,
};
export function suggestCustomerTypes(text: string): CustomerType[] {
  return CUSTOMER_TYPES.filter(type => HINTS[type].test(text));
}

// The AI's search categories (local-intelligence contract) each customer-type category maps to, and the
// categories searched at every venue whatever its customers: whether it can open (local service
// disruptions, extreme weather).
import type { InfluenceCategory } from "@/server/intelligence/local-intelligence-contract";
export const SEARCH_CATEGORY: Record<SignalCategory, InfluenceCategory> = {
  PUBLIC_HOLIDAYS: "PUBLIC_HOLIDAY", OFFICE_CLOSURES: "NEWS_POLITICAL", TRANSPORT_STRIKES: "ACCESS_DISRUPTION", TERM_AND_EXAM_DATES: "SCHOOL_CALENDAR",
  CAMPUS_EVENTS: "FESTIVAL_CONCERT_CULTURAL", FESTIVALS: "FESTIVAL_CONCERT_CULTURAL", CRUISE_DAYS: "OTHER", MAJOR_EVENTS: "FESTIVAL_CONCERT_CULTURAL",
  NEARBY_SHOWS: "FESTIVAL_CONCERT_CULTURAL", MATCH_DAYS: "SPORT", SCHOOL_HOLIDAYS: "SCHOOL_CALENDAR", FAMILY_EVENTS: "FESTIVAL_CONCERT_CULTURAL",
  PAYDAYS: "PAYDAY_MONTH_END", MALL_HOURS: "COMMEMORATIVE_COMMERCIAL", SALES: "COMMEMORATIVE_COMMERCIAL", TRANSPORT_DISRUPTIONS: "ACCESS_DISRUPTION",
  ROAD_CLOSURES: "ACCESS_DISRUPTION", LATE_EVENTS: "FESTIVAL_CONCERT_CULTURAL", CONCERTS: "FESTIVAL_CONCERT_CULTURAL", LONG_WEEKENDS: "PUBLIC_HOLIDAY",
};
export const ALWAYS_SEARCHED: readonly InfluenceCategory[] = ["SERVICE_DISRUPTION", "EXTREME_WEATHER"];
export type TriggeredBy = CustomerType | "ALWAYS";

// The categories a location's customer types switch on, each with what to look for and why; null when
// the location has no customer types yet (the search then covers every category, as before).
export function searchCategoriesFor(types: readonly string[], allowed: readonly InfluenceCategory[]) {
  const chosen = signalCategoriesFor(types);
  if (!chosen.length) return null;
  const byCategory = new Map<InfluenceCategory, { focus: string[]; triggeredBy: TriggeredBy }>();
  for (const { category, triggeredBy } of chosen) {
    const search = SEARCH_CATEGORY[category];
    const entry = byCategory.get(search) ?? { focus: [], triggeredBy };
    entry.focus.push(SIGNAL_CATEGORY_LABEL[category]);
    byCategory.set(search, entry);
  }
  for (const category of ALWAYS_SEARCHED) if (!byCategory.has(category)) byCategory.set(category, { focus: [], triggeredBy: "ALWAYS" });
  return [...byCategory].filter(([category]) => allowed.includes(category)).map(([category, entry]) => ({ category, focus: entry.focus, triggeredBy: entry.triggeredBy }));
}
export const triggeredByLabel = (value: string | null | undefined) =>
  !value ? null : value === "ALWAYS" ? "Checked at every venue: can it open?" : `Because you picked ${CUSTOMER_TYPE_LABEL[value as CustomerType] ?? value}`;
