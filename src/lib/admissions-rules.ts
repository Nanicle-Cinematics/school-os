import type { ApplicationStatus, Gender, GuardianRelationship } from "@prisma/client";
import { normaliseName, phoneKey } from "@/lib/duplicate-detect";
import { checkScore } from "@/lib/score-limits";
import { normalisePhone } from "@/lib/sms-shared";

/**
 * The rules of admissions, with no database and no `server-only`, so the screens, the actions, the public
 * form's route and `verify:admissions` all read one answer.
 *
 * An application is a child who has asked for a place and is not a pupil yet. It is its own record on
 * purpose: an applicant must not take an admission number, count against the plan's pupil cap or appear in
 * a class list, and most applicants are never admitted.
 */

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  APPLIED: "Applied",
  TESTING: "Test or interview",
  WAITLISTED: "Waiting list",
  OFFERED: "Offered a place",
  ACCEPTED: "Accepted",
  ADMITTED: "Admitted",
  REJECTED: "Not offered",
  WITHDRAWN: "Withdrawn",
};

/** The order a head reads the pipeline in. */
export const STATUS_ORDER: ApplicationStatus[] = [
  "APPLIED",
  "TESTING",
  "WAITLISTED",
  "OFFERED",
  "ACCEPTED",
  "ADMITTED",
  "REJECTED",
  "WITHDRAWN",
];

/** Applications still being decided: the working queue. */
export const OPEN_STATUSES: ApplicationStatus[] = ["APPLIED", "TESTING", "WAITLISTED", "OFFERED", "ACCEPTED"];

/** A seat is promised to the family from the moment of the offer until they are admitted or let it go. */
export const HOLDS_SEAT: ApplicationStatus[] = ["OFFERED", "ACCEPTED"];

/**
 * Where an application may be moved BY HAND. ADMITTED is not in any list: it is reached only by admitting,
 * which creates the pupil, and an admitted application never moves again (the pupil is the record now).
 *
 * An ended application (not offered, withdrawn) can be reopened, because a family that rings back in
 * September is a real case and "make a new application" would lose the test result.
 */
const MOVES: Record<ApplicationStatus, ApplicationStatus[]> = {
  APPLIED: ["TESTING", "WAITLISTED", "OFFERED", "REJECTED", "WITHDRAWN"],
  TESTING: ["APPLIED", "WAITLISTED", "OFFERED", "REJECTED", "WITHDRAWN"],
  WAITLISTED: ["APPLIED", "TESTING", "OFFERED", "REJECTED", "WITHDRAWN"],
  OFFERED: ["ACCEPTED", "WAITLISTED", "REJECTED", "WITHDRAWN"],
  ACCEPTED: ["OFFERED", "WITHDRAWN"],
  ADMITTED: [],
  REJECTED: ["APPLIED"],
  WITHDRAWN: ["APPLIED"],
};

export const movesFrom = (status: ApplicationStatus): ApplicationStatus[] => MOVES[status];

export function canMove(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return MOVES[from].includes(to);
}

/** Can this application still be edited, tested or deleted by the office? An admitted one is a pupil now. */
export const isSettled = (status: ApplicationStatus) => status === "ADMITTED";

/* ───────────────────────────── seats ───────────────────────────── */

export type SeatInput = {
  /** The capacity of each class under the level, in order; null where a class has no limit set. */
  capacities: (number | null)[];
  /** Pupils already enrolled in those classes for the entry year (any state but withdrawn). */
  enrolled: number;
  /** Offers made and accepted, and admitted pupils with no enrolment yet: places promised and not yet on a roll. */
  held: number;
};

export type Seats =
  /** No class under the level has a limit, or the level has no class: nothing to count against. */
  | { limited: false; enrolled: number; held: number }
  | { limited: true; capacity: number; enrolled: number; held: number; left: number };

/**
 * How many places remain at a level for a year.
 *
 * A level is limited only when EVERY class under it has a capacity: one class with no limit means the
 * school can always put a child there, and a total built from the others would turn an offer away that
 * the school could in fact keep. A level with no class at all has nothing to count against either.
 * `left` may be negative (the school over-admitted by hand); it is shown as it is.
 */
export function seatsFor(input: SeatInput): Seats {
  const { capacities, enrolled, held } = input;
  if (capacities.length === 0 || capacities.some((c) => c === null)) {
    return { limited: false, enrolled, held };
  }
  const capacity = capacities.reduce<number>((sum, c) => sum + (c as number), 0);
  return { limited: true, capacity, enrolled, held, left: capacity - enrolled - held };
}

/**
 * The sentence that refuses an offer when there is no place to promise, or null when there is one.
 * `holding` is true when the application ALREADY holds a seat (moving OFFERED to ACCEPTED must never be
 * refused for lack of the seat it is already sitting in).
 */
export function offerRefusal(seats: Seats, levelName: string, holding = false): string | null {
  if (holding || !seats.limited || seats.left > 0) {
    return null;
  }
  return (
    `${levelName} has no place left for that year (${seats.capacity} places, ${seats.enrolled} enrolled, ` +
    `${seats.held} offered). Put the child on the waiting list, or raise a class's capacity first.`
  );
}

/* ───────────────────────────── the form ───────────────────────────── */

export const LIMITS = {
  name: 60,
  place: 120,
  notes: 600,
  email: 120,
  testNotes: 600,
  decisionNote: 300,
  intro: 600,
} as const;

const RELATIONSHIPS: GuardianRelationship[] = [
  "FATHER", "MOTHER", "GRANDPARENT", "UNCLE", "AUNT", "SIBLING", "GUARDIAN", "OTHER",
];

export type ApplicationInput = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  gender: Gender;
  dateOfBirth: Date | null;
  previousSchool: string | null;
  notes: string | null;
  guardianName: string;
  guardianPhone: string;
  guardianEmail: string | null;
  guardianRelationship: GuardianRelationship;
  levelId: string;
  academicYearId: string;
};

export type ReadResult = { ok: true; value: ApplicationInput } | { ok: false; error: string };

/** A control character in a name or note would reach a printed page, an SMS and a spreadsheet unchanged. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function clean(raw: unknown, max: number, label: string): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "string") return { error: `${label} is not text.` };
  const value = raw.replace(/\s+/g, " ").trim();
  if (CONTROL.test(value)) return { error: `${label} contains a character that cannot be saved.` };
  if (value.length > max) return { error: `${label} is too long (at most ${max} characters).` };
  return { value: value || null };
}

/** Notes keep their line breaks; everything else is one line. */
function cleanNotes(raw: unknown, max: number, label: string): { value: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "string") return { error: `${label} is not text.` };
  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (CONTROL.test(value)) return { error: `${label} contains a character that cannot be saved.` };
  if (value.length > max) return { error: `${label} is too long (at most ${max} characters).` };
  return { value: value || null };
}

/** A calendar day typed as YYYY-MM-DD, or nothing. Anything else is refused rather than guessed. */
export function readDay(raw: unknown): { value: Date | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: "Give the date as day, month and year." };
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return { error: "That date does not exist." };
  return { value: date };
}

/**
 * One application, read from whatever a form or a request sent (a plain object, so the office's form and
 * the public JSON route share it) and checked. The ids are NOT checked here: the caller reads them back
 * through the tenant client, which is the only place that can say a level is this school's.
 *
 * `today` is a parameter so the date-of-birth rule is testable.
 */
export function readApplication(raw: Record<string, unknown>, today = new Date()): ReadResult {
  const fail = (error: string): ReadResult => ({ ok: false, error });

  const first = clean(raw.firstName, LIMITS.name, "The first name");
  if ("error" in first) return fail(first.error);
  const last = clean(raw.lastName, LIMITS.name, "The last name");
  if ("error" in last) return fail(last.error);
  if (!first.value || !last.value) return fail("Enter the child's first and last name.");

  const middle = clean(raw.middleName, LIMITS.name, "The middle name");
  if ("error" in middle) return fail(middle.error);

  if (raw.gender !== "MALE" && raw.gender !== "FEMALE") return fail("Pick the child's gender.");

  const born = readDay(raw.dateOfBirth);
  if ("error" in born) return fail(`Date of birth: ${born.error}`);
  if (born.value) {
    const years = (today.getTime() - born.value.getTime()) / (365.25 * 86_400_000);
    if (years < 1) return fail("That date of birth is too recent for a school place.");
    if (years > 25) return fail("That date of birth is too long ago. Check the year.");
  }

  const previous = clean(raw.previousSchool, LIMITS.place, "The previous school");
  if ("error" in previous) return fail(previous.error);
  const notes = cleanNotes(raw.notes, LIMITS.notes, "The notes");
  if ("error" in notes) return fail(notes.error);

  const guardian = clean(raw.guardianName, LIMITS.name * 2, "The parent or guardian's name");
  if ("error" in guardian) return fail(guardian.error);
  if (!guardian.value) return fail("Enter the name of the parent or guardian.");

  const phone = typeof raw.guardianPhone === "string" ? raw.guardianPhone.trim() : "";
  if (phone.length > 20 || !normalisePhone(phone)) {
    return fail("That phone number is not a Ghanaian mobile number, e.g. 0244123456.");
  }

  const email = clean(raw.guardianEmail, LIMITS.email, "The email address");
  if ("error" in email) return fail(email.error);
  if (email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) return fail("That email address does not look right.");

  const relationship =
    typeof raw.guardianRelationship === "string" && RELATIONSHIPS.includes(raw.guardianRelationship as GuardianRelationship)
      ? (raw.guardianRelationship as GuardianRelationship)
      : "GUARDIAN";

  const levelId = typeof raw.levelId === "string" ? raw.levelId.trim() : "";
  const academicYearId = typeof raw.academicYearId === "string" ? raw.academicYearId.trim() : "";
  if (!levelId) return fail("Pick the class the child is applying for.");
  if (!academicYearId) return fail("Pick the year the child would start.");
  if (levelId.length > 40 || academicYearId.length > 40) return fail("Pick the class and year from the lists.");

  return {
    ok: true,
    value: {
      firstName: first.value,
      middleName: middle.value,
      lastName: last.value,
      gender: raw.gender,
      dateOfBirth: born.value,
      previousSchool: previous.value,
      notes: notes.value,
      guardianName: guardian.value,
      guardianPhone: phone,
      guardianEmail: email.value ? email.value.toLowerCase() : null,
      guardianRelationship: relationship,
      levelId,
      academicYearId,
    },
  };
}

/** The entrance test or interview: a day, a mark out of 100 and a note, each optional. */
export function readTest(raw: Record<string, unknown>):
  | { ok: true; testedOn: Date | null; testScore: number | null; testNotes: string | null }
  | { ok: false; error: string } {
  const day = readDay(raw.testedOn);
  if ("error" in day) return { ok: false, error: `Date of the test: ${day.error}` };
  const score = checkScore(typeof raw.testScore === "string" ? raw.testScore : "", 100);
  if (!score.ok) return { ok: false, error: `Test mark: ${score.reason}.` };
  const notes = cleanNotes(raw.testNotes, LIMITS.testNotes, "The notes");
  if ("error" in notes) return { ok: false, error: notes.error };
  return { ok: true, testedOn: day.value, testScore: score.value, testNotes: notes.value };
}

/** When an offer lapses: a day, today or later. */
export function readOfferExpiry(raw: unknown, today = new Date()):
  | { ok: true; value: Date | null }
  | { ok: false; error: string } {
  const day = readDay(raw);
  if ("error" in day) return { ok: false, error: `Offer valid until: ${day.error}` };
  if (day.value && day.value.getTime() < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) {
    return { ok: false, error: "The offer cannot lapse before today." };
  }
  return { ok: true, value: day.value };
}

export function readDecisionNote(raw: unknown):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  const note = cleanNotes(raw, LIMITS.decisionNote, "The note");
  return "error" in note ? { ok: false, error: note.error } : { ok: true, value: note.value };
}

/* ───────────────────────────── derived, never stored ───────────────────────────── */

/**
 * Has this offer lapsed? Worked out when read: nothing runs when a date passes, so a stored "expired"
 * would stay false for ever (the rule that keeps an invoice's OVERDUE derived).
 */
export function offerLapsed(
  application: { status: ApplicationStatus; offerExpiresOn: Date | null },
  now = new Date(),
): boolean {
  if (application.status !== "OFFERED" || !application.offerExpiresOn) return false;
  const endOfDay = application.offerExpiresOn.getTime() + 86_400_000;
  return now.getTime() >= endOfDay;
}

export type LookAlike = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  guardianPhone: string;
};

/**
 * Which other applications and pupils look like the same child. A hint for the office, never a refusal:
 * the public form must not say "this child has already applied" to a stranger (that would let anyone
 * check whether a named child is applying), and twins share a surname and sometimes a birthday.
 *
 * Same first and last name (accents and spacing folded) and either the same birthday or a parent's phone
 * in common. A missing birthday never matches another missing one.
 */
export function lookAlikes(subject: LookAlike, others: LookAlike[]): string[] {
  const first = normaliseName(subject.firstName);
  const last = normaliseName(subject.lastName);
  const day = subject.dateOfBirth ? subject.dateOfBirth.toISOString().slice(0, 10) : null;
  const phone = phoneKey(subject.guardianPhone);
  return others
    .filter((other) => {
      if (other.id === subject.id) return false;
      if (normaliseName(other.firstName) !== first || normaliseName(other.lastName) !== last) return false;
      const sameDay = day !== null && other.dateOfBirth !== null && other.dateOfBirth.toISOString().slice(0, 10) === day;
      const samePhone = phone !== null && phoneKey(other.guardianPhone) === phone;
      return sameDay || samePhone;
    })
    .map((other) => other.id);
}

/* ───────────────────────────── the public form ───────────────────────────── */

/** Online applications a school accepts in 24 hours: a flood guard for the table, not a target anyone reaches. */
export const ONLINE_PER_DAY = 150;
/** Applications one address may send in an hour. A family with four children sends four. */
export const ONLINE_PER_ADDRESS_PER_HOUR = 8;
/** The most a request body may be, in characters. A real application is under 2,000. */
export const MAX_BODY = 12_000;

/** The honeypot: a field no person sees and a script fills. */
export const TRAP_FIELD = "website";

/** The years a child may be applying to start: the current one and any after it, never one that has ended. */
export function startableYears<T extends { endDate: Date }>(years: T[], today = new Date()): T[] {
  return years.filter((year) => year.endDate.getTime() >= Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

/** The reference printed to a family: stable, short, quotable. */
export const referenceLooksRight = (value: string) => /^APP-\d{4,}$/.test(value);
