import { localDate, shiftDate } from "@/server/intelligence/forecast";

// South African public holidays: a committed, rule-based reference, so planning has no live
// dependency. A holiday is a contextual fact about a date. It says nothing about whether sales
// rise or fall, and nothing here changes a forecast, a transaction or a staffing figure.
//
// Rules (Public Holidays Act 36 of 1994): the fixed-date holidays of Schedule 1, Good Friday and
// Family Day from the date of Easter, the following Monday whenever a public holiday falls on a
// Sunday (section 2(1)), and any further day proclaimed under section 2A. Dates are Africa/Johannesburg
// local dates. Outside the checked range the reference says nothing, rather than "no holiday".

export const SA_PUBLIC_HOLIDAYS_VERSION = "fs-za-public-holidays-v1";
export const SA_PUBLIC_HOLIDAYS_TIMEZONE = "Africa/Johannesburg";
// The dates whose classification was checked against the official list below.
export const SA_PUBLIC_HOLIDAYS_RANGE = { from: "2026-08-01", through: "2027-03-31" } as const;

export const SA_PUBLIC_HOLIDAYS_SOURCE = {
  publisher: "South African Government",
  title: "Public holidays",
  url: "https://www.gov.za/about-sa/public-holidays",
  act: "Public Holidays Act 36 of 1994",
  actUrl: "https://www.gov.za/documents/public-holidays-act",
  // The page shows no revision date of its own.
  retrievedOn: "2026-11-06",
} as const;

export type SaHolidayKind = "STATUTORY" | "SUNDAY_OBSERVED" | "PROCLAIMED";
export type SaHolidayVerification = "VERIFIED_OFFICIAL_LIST" | "OWNER_SUPPLIED_NOT_VERIFIED";
export type SaPublicHoliday = {
  date: string;
  name: string;
  kind: SaHolidayKind;
  // For a Monday holiday: the Sunday holiday it follows.
  observes: string | null;
  authority: string;
  sourceUrl: string;
  verification: SaHolidayVerification;
};

// Schedule 1, fixed dates (month-day).
const FIXED: readonly (readonly [string, string])[] = [
  ["01-01", "New Year’s Day"], ["03-21", "Human Rights Day"], ["04-27", "Freedom Day"], ["05-01", "Workers’ Day"],
  ["06-16", "Youth Day"], ["08-09", "National Women’s Day"], ["09-24", "Heritage Day"],
  ["12-16", "Day of Reconciliation"], ["12-25", "Christmas Day"], ["12-26", "Day of Goodwill"],
];

// Exceptional days declared under section 2A. The Owner supplied this proclamation; the official
// pages read on the retrieval date didn't list it, so it is recorded as not independently verified.
const PROCLAIMED: readonly { date: string; name: string; authority: string }[] = [
  { date: "2026-11-04", name: "Local Government Elections", authority: "Proclamation 346, Government Gazette 55352" },
];

// Gregorian Easter Sunday (anonymous algorithm), as a local date.
function easterSunday(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const isSunday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (date: string) => ISO_DATE.test(date) && shiftDate(date, 0) === date;

// Every public holiday of one calendar year, one record per date.
function holidaysOfYear(year: number): SaPublicHoliday[] {
  const official = { authority: SA_PUBLIC_HOLIDAYS_SOURCE.act, sourceUrl: SA_PUBLIC_HOLIDAYS_SOURCE.url, verification: "VERIFIED_OFFICIAL_LIST" as const };
  const easter = easterSunday(year);
  const primary: SaPublicHoliday[] = [
    ...FIXED.map(([monthDay, name]) => ({ date: `${year}-${monthDay}`, name, kind: "STATUTORY" as const, observes: null, ...official })),
    { date: shiftDate(easter, -2), name: "Good Friday", kind: "STATUTORY", observes: null, ...official },
    { date: shiftDate(easter, 1), name: "Family Day", kind: "STATUTORY", observes: null, ...official },
    ...PROCLAIMED.filter(row => row.date.startsWith(`${year}-`)).map(row => ({ date: row.date, name: row.name, kind: "PROCLAIMED" as const, observes: null,
      authority: row.authority, sourceUrl: SA_PUBLIC_HOLIDAYS_SOURCE.actUrl, verification: "OWNER_SUPPLIED_NOT_VERIFIED" as const })),
  ];
  const byDate = new Map<string, SaPublicHoliday>();
  for (const holiday of primary) if (!byDate.has(holiday.date)) byDate.set(holiday.date, holiday);
  // Section 2(1): a Sunday holiday makes the following Monday a public holiday. A Monday that is
  // already a holiday stays one holiday, never two.
  for (const holiday of [...byDate.values()].filter(row => isSunday(row.date))) {
    const monday = shiftDate(holiday.date, 1);
    if (!byDate.has(monday)) byDate.set(monday, { ...holiday, date: monday, name: `${holiday.name} observed`, kind: "SUNDAY_OBSERVED", observes: holiday.date, authority: `${SA_PUBLIC_HOLIDAYS_SOURCE.act}, section 2(1)` });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The public holidays between two local dates, inclusive, inside the checked range only.
export function saPublicHolidays(from: string = SA_PUBLIC_HOLIDAYS_RANGE.from, through: string = SA_PUBLIC_HOLIDAYS_RANGE.through): SaPublicHoliday[] {
  if (!isRealDate(from) || !isRealDate(through)) throw new Error("Dates must be YYYY-MM-DD.");
  const start = from < SA_PUBLIC_HOLIDAYS_RANGE.from ? SA_PUBLIC_HOLIDAYS_RANGE.from : from;
  const end = through > SA_PUBLIC_HOLIDAYS_RANGE.through ? SA_PUBLIC_HOLIDAYS_RANGE.through : through;
  if (start > end) return [];
  const years = Array.from({ length: Number(end.slice(0, 4)) - Number(start.slice(0, 4)) + 1 }, (_, i) => Number(start.slice(0, 4)) + i);
  return years.flatMap(holidaysOfYear).filter(row => row.date >= start && row.date <= end);
}

export type SaHolidayClassification =
  | { status: "PUBLIC_HOLIDAY"; date: string; holiday: SaPublicHoliday; version: typeof SA_PUBLIC_HOLIDAYS_VERSION }
  | { status: "NOT_A_PUBLIC_HOLIDAY"; date: string; version: typeof SA_PUBLIC_HOLIDAYS_VERSION }
  // Outside the checked range FairShift doesn't know, and says so.
  | { status: "OUTSIDE_REFERENCE"; date: string; version: typeof SA_PUBLIC_HOLIDAYS_VERSION };

// One local date's classification. Context only: it carries no demand effect.
export function classifySaDate(date: string): SaHolidayClassification {
  if (!isRealDate(date)) throw new Error("Dates must be YYYY-MM-DD.");
  const version = SA_PUBLIC_HOLIDAYS_VERSION;
  if (date < SA_PUBLIC_HOLIDAYS_RANGE.from || date > SA_PUBLIC_HOLIDAYS_RANGE.through) return { status: "OUTSIDE_REFERENCE", date, version };
  const holiday = saPublicHolidays(date, date)[0];
  return holiday ? { status: "PUBLIC_HOLIDAY", date, holiday, version } : { status: "NOT_A_PUBLIC_HOLIDAY", date, version };
}

// The classification of the Africa/Johannesburg local date an instant falls on.
export function classifySaInstant(instant: Date) {
  return classifySaDate(localDate(instant, SA_PUBLIC_HOLIDAYS_TIMEZONE));
}
