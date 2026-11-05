/** A date as the library prints it: 5 Nov 2026. Loans are `@db.Date`, so UTC is the school's own date. */
export const day = (value: Date | null) =>
  value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

/** `YYYY-MM-DD`, for crossing from a server page to a client component as plain text. */
export const isoDay = (value: Date) => new Date(value).toISOString().slice(0, 10);
