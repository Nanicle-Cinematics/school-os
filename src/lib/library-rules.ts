import type { CopyStatus, LoanOutcome, StaffStatus, StudentStatus } from "@prisma/client";

/**
 * The rules of the library, with no database and no `server-only`, so the screens, the actions, the CSV import and
 * `verify:library` all read one answer.
 *
 * A BOOK is a title; a COPY is one physical book with its number in the accession register; a LOAN is a copy going
 * out to one pupil or one member of staff. Three rules shape everything here:
 *
 *  - Whether a copy is on the shelf is DERIVED from its loans (an open loan means it is out). Only LOST and WITHDRAWN
 *    are stored, because somebody decided them.
 *  - Whether a loan is overdue is DERIVED from its due date when read. Nothing runs when a date passes, so a stored
 *    "overdue" would stay false for ever (the rule that keeps an invoice's OVERDUE derived).
 *  - Nothing here touches money. A lost book is recorded as lost, with what it would cost to replace shown beside it;
 *    no fine can be billed by mistake because nothing is wired to the ledger.
 */

/* ───────────────────────────── dates ───────────────────────────── */

export const DAY_MS = 86_400_000;

/** A renewed loan goes out again for the full period. Twice is plenty; a book wanted longer is a new loan. */
export const MAX_RENEWALS = 2;

/** The longest anyone may be given a book for, and the most anyone may hold. Typos, not policy. */
const MAX_DAYS = 365;
const MAX_HELD = 50;

/**
 * A date with no time: midnight UTC. Ghana is on GMT all year with no daylight saving, so the school's date and the
 * UTC date are the same date. Loans are `@db.Date`, so they come back at midnight UTC too.
 */
export function dayOf(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(dayOf(date).getTime() + days * DAY_MS);
}

/** `YYYY-MM-DD` from a form's date box, or null. Rejects 2026-02-31 rather than rolling it into March. */
export function readDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/* ───────────────────────────── accession numbers ───────────────────────────── */

/**
 * How the library numbers a copy it numbers itself (`ACC-00123`). The one definition: the number sequence takes its
 * prefix and width from here, and the desk reads it to know that a typed `123` may mean `ACC-00123`. A school that keyed
 * in its own register keeps its own numbers, which always match exactly first.
 */
export const ACCESSION_SHAPE = { prefix: "ACC-", padding: 5 } as const;

/** A person's name as the desk shows it. */
export const fullName = (p: { firstName: string; middleName?: string | null; lastName: string }) =>
  [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ");

/** What was typed or scanned, tidied: trimmed, inner runs of space collapsed, upper case. */
export function normaliseAccession(input: string): string {
  return input.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * The numbers a scan or a keystroke might mean, best first. A librarian types `123` for `B-00123`, and a school that
 * numbered its own register `123` must still find `123` exactly, so the number as typed always comes first and the
 * padded form second. Only an all-digit entry has a padded form.
 */
export function accessionCandidates(input: string, prefix: string, padding: number): string[] {
  const typed = normaliseAccession(input);
  if (!typed) return [];
  const found = [typed];
  if (/^\d+$/.test(typed)) found.push(`${prefix.toUpperCase()}${typed.padStart(padding, "0")}`);
  return [...new Set(found)];
}

/* ───────────────────────────── loans ───────────────────────────── */

export type BorrowerKind = "STUDENT" | "STAFF";

export type LoanLike = { dueOn: Date; returnedOn: Date | null; outcome: LoanOutcome | null };
export type LoanState = "OUT" | "OVERDUE" | "RETURNED" | "LOST";

export const isOpen = (loan: Pick<LoanLike, "returnedOn">) => loan.returnedOn === null;

/** Out, overdue, returned or lost: worked out from the dates and never stored. A book due TODAY is not yet late. */
export function loanState(loan: LoanLike, today: Date = dayOf()): LoanState {
  if (loan.returnedOn !== null) return loan.outcome === "LOST" ? "LOST" : "RETURNED";
  return dayOf(loan.dueOn).getTime() < dayOf(today).getTime() ? "OVERDUE" : "OUT";
}

export function daysOverdue(loan: LoanLike, today: Date = dayOf()): number {
  if (loanState(loan, today) !== "OVERDUE") return 0;
  return Math.round((dayOf(today).getTime() - dayOf(loan.dueOn).getTime()) / DAY_MS);
}

export const LOAN_STATE_LABEL: Record<LoanState, string> = {
  OUT: "Out",
  OVERDUE: "Overdue",
  RETURNED: "Returned",
  LOST: "Lost",
};

export const COPY_STATUS_LABEL: Record<CopyStatus, string> = {
  ACTIVE: "In stock",
  LOST: "Lost",
  WITHDRAWN: "Withdrawn",
};

/* ───────────────────────────── the school's policy ───────────────────────────── */

export type LibraryPolicy = {
  pupilDays: number;
  staffDays: number;
  pupilMax: number;
  staffMax: number;
  /** An overdue book stops the next loan to the same person. */
  blockOverdue: boolean;
};

export const DEFAULT_POLICY: LibraryPolicy = { pupilDays: 14, staffDays: 30, pupilMax: 2, staffMax: 5, blockOverdue: true };

export const periodFor = (kind: BorrowerKind, policy: LibraryPolicy) => (kind === "STUDENT" ? policy.pupilDays : policy.staffDays);
export const limitFor = (kind: BorrowerKind, policy: LibraryPolicy) => (kind === "STUDENT" ? policy.pupilMax : policy.staffMax);
export const dueDateFor = (kind: BorrowerKind, policy: LibraryPolicy, today: Date = dayOf()) => addDays(today, periodFor(kind, policy));

function wholeNumber(value: string, label: string, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: `${label} must be a whole number.` };
  const number = Number(text);
  if (number < min || number > max) return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  return { ok: true, value: number };
}

/** The settings form, read. Whole numbers only: `1e1`, `7.5` and `-3` are not a number of days. */
export function readPolicy(values: Record<string, string>): { ok: true; value: LibraryPolicy } | { ok: false; error: string } {
  const pupilDays = wholeNumber(values.pupilDays ?? "", "How long a pupil may keep a book (days)", 1, MAX_DAYS);
  if (!pupilDays.ok) return pupilDays;
  const staffDays = wholeNumber(values.staffDays ?? "", "How long a member of staff may keep a book (days)", 1, MAX_DAYS);
  if (!staffDays.ok) return staffDays;
  const pupilMax = wholeNumber(values.pupilMax ?? "", "Books a pupil may hold at once", 1, MAX_HELD);
  if (!pupilMax.ok) return pupilMax;
  const staffMax = wholeNumber(values.staffMax ?? "", "Books a member of staff may hold at once", 1, MAX_HELD);
  if (!staffMax.ok) return staffMax;
  return {
    ok: true,
    value: {
      pupilDays: pupilDays.value,
      staffDays: staffDays.value,
      pupilMax: pupilMax.value,
      staffMax: staffMax.value,
      blockOverdue: values.blockOverdue === "yes",
    },
  };
}

/* ───────────────────────────── who may borrow, and may this go out? ───────────────────────────── */

/** Why this person cannot borrow, or null if they can. A pupil must be on the roll; a removed record never borrows. */
export function borrowerProblem(
  kind: BorrowerKind,
  who: { status: StudentStatus | StaffStatus; deletedAt: Date | null; name: string },
): string | null {
  if (who.deletedAt) return `${who.name} has been removed from the school's records.`;
  if (kind === "STUDENT") {
    return who.status === "ACTIVE" ? null : `${who.name} is not on the roll at the moment, so cannot borrow.`;
  }
  return who.status === "ACTIVE" || who.status === "ON_LEAVE" ? null : `${who.name} is no longer on the staff, so cannot borrow.`;
}

export type LendInput = {
  kind: BorrowerKind;
  borrowerName: string;
  /** What the person holds now: open loans, and how many of them are overdue. */
  held: number;
  overdue: number;
  copy: { accessionNo: string; title: string; status: CopyStatus; onLoan: boolean };
  policy: LibraryPolicy;
};

/**
 * May this copy go out to this person now? One answer, asked by the desk before it writes and again inside the
 * transaction that writes. The reasons are sentences a librarian can read aloud to a child.
 */
export function lendCheck(input: LendInput): { ok: true } | { ok: false; error: string } {
  const { copy, policy } = input;
  const label = `${copy.title} (${copy.accessionNo})`;
  if (copy.status === "LOST") return { ok: false, error: `${label} is recorded as lost.` };
  if (copy.status === "WITHDRAWN") return { ok: false, error: `${label} has been withdrawn from the library.` };
  if (copy.onLoan) return { ok: false, error: `${label} is already out.` };
  if (policy.blockOverdue && input.overdue > 0) {
    return {
      ok: false,
      error: `${input.borrowerName} has ${input.overdue} overdue book${input.overdue === 1 ? "" : "s"}. They must be returned first.`,
    };
  }
  const limit = limitFor(input.kind, policy);
  if (input.held >= limit) {
    return { ok: false, error: `${input.borrowerName} already has ${input.held} book${input.held === 1 ? "" : "s"}, which is the most ${input.kind === "STUDENT" ? "a pupil" : "a member of staff"} may hold (${limit}).` };
  }
  return { ok: true };
}

/** May this open loan be renewed? Not once it is late (return it first), and not more than twice. */
export function renewCheck(
  loan: LoanLike & { renewals: number },
  copyStatus: CopyStatus,
  today: Date = dayOf(),
): { ok: true } | { ok: false; error: string } {
  if (loan.returnedOn !== null) return { ok: false, error: "That book has already been returned." };
  if (copyStatus !== "ACTIVE") return { ok: false, error: "That copy is no longer in stock." };
  if (loanState(loan, today) === "OVERDUE") return { ok: false, error: "That book is overdue. Take it back first." };
  if (loan.renewals >= MAX_RENEWALS) return { ok: false, error: `It has already been renewed ${MAX_RENEWALS} times.` };
  return { ok: true };
}

/* ───────────────────────────── a title, read from a form ───────────────────────────── */

export type BookFields = {
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  publishedYear: number | null;
  category: string | null;
  shelf: string | null;
  /** Whole pesewas would be overkill: this is a note for the librarian, shown to two decimals. */
  replacementCost: string | null;
  notes: string | null;
};

const clean = (value: string | undefined, max: number) => {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, max) : null;
};

/** ISBNs are typed with hyphens and spaces; stored as digits (and a trailing X). Not checksummed: old books have none. */
export function readIsbn(value: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  const digits = text.replace(/[\s-]/g, "").toUpperCase();
  if (!/^(\d{9}[\dX]|\d{13})$/.test(digits)) return { ok: false, error: `"${text}" is not an ISBN (10 or 13 digits).` };
  return { ok: true, value: digits };
}

/** A cedi amount from a cell: `12`, `12.5`, `GH₵ 1,250.00`. Two decimals at most; never negative; returns "12.50". */
export function readCost(value: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = value.replace(/GH[S₵C]?/gi, "").replace(/[₵,\s]/g, "");
  if (!text) return { ok: true, value: null };
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(text)) return { ok: false, error: `"${value.trim()}" is not an amount in cedis.` };
  const [whole, fraction = ""] = text.split(".");
  return { ok: true, value: `${Number(whole)}.${fraction.padEnd(2, "0")}` };
}

export function readBook(
  values: Record<string, string>,
  now: Date = new Date(),
): { ok: true; value: BookFields } | { ok: false; error: string } {
  const title = clean(values.title, 200);
  if (!title) return { ok: false, error: "Give the book a title." };

  const isbn = readIsbn(values.isbn ?? "");
  if (!isbn.ok) return isbn;

  const yearText = (values.publishedYear ?? "").trim();
  let publishedYear: number | null = null;
  if (yearText) {
    publishedYear = /^\d{4}$/.test(yearText) ? Number(yearText) : NaN;
    if (!(publishedYear >= 1000 && publishedYear <= now.getUTCFullYear() + 1)) {
      return { ok: false, error: `"${yearText}" is not a year of publication.` };
    }
  }

  const cost = readCost(values.replacementCost ?? "");
  if (!cost.ok) return cost;

  return {
    ok: true,
    value: {
      title,
      author: clean(values.author, 150),
      isbn: isbn.value,
      publisher: clean(values.publisher, 150),
      publishedYear,
      category: clean(values.category, 60),
      shelf: clean(values.shelf, 40),
      replacementCost: cost.value,
      notes: clean(values.notes, 500),
    },
  };
}

/* ───────────────────────────── the catalogue, from a spreadsheet ───────────────────────────── */

/** A school with a paper accession register keys it into a spreadsheet once. One row is one COPY. */
export const CATALOGUE_TEMPLATE_HEADERS = ["accession_no", "title", "author", "isbn", "publisher", "year", "category", "shelf", "price"] as const;

export const CATALOGUE_ROW_CAP = 5000;

export type CatalogueRow = BookFields & { line: number; accessionNo: string | null };
export type CatalogueProblem = { line: number; message: string };

const pick = (row: Record<string, string>, ...names: string[]) => {
  for (const name of names) if (row[name]) return row[name]!;
  return "";
};

/**
 * Rows from the parsed CSV, checked. Every problem is reported, with its line (the header is line 1, so the first
 * book is line 2), and a file with any problem adds nothing: half a register is harder to put right than none.
 * A number repeated within the file is a problem; a number the library already holds is checked against the
 * database by the engine.
 */
export function readCatalogue(
  rows: Array<Record<string, string>>,
  now: Date = new Date(),
): { rows: CatalogueRow[]; problems: CatalogueProblem[] } {
  const problems: CatalogueProblem[] = [];
  const good: CatalogueRow[] = [];
  const seen = new Map<string, number>();

  if (rows.length > CATALOGUE_ROW_CAP) {
    return { rows: [], problems: [{ line: 0, message: `That file has ${rows.length} rows. Add at most ${CATALOGUE_ROW_CAP} at a time.` }] };
  }

  rows.forEach((row, index) => {
    const line = index + 2;
    const read = readBook(
      {
        title: pick(row, "title", "book", "book_title"),
        author: pick(row, "author", "authors"),
        isbn: pick(row, "isbn"),
        publisher: pick(row, "publisher"),
        publishedYear: pick(row, "year", "published", "published_year"),
        category: pick(row, "category", "subject", "class"),
        shelf: pick(row, "shelf", "location"),
        replacementCost: pick(row, "price", "cost"),
      },
      now,
    );
    if (!read.ok) {
      problems.push({ line, message: read.error });
      return;
    }
    const accession = normaliseAccession(pick(row, "accession_no", "accession", "acc_no", "accession_number"));
    if (accession.length > 40) {
      problems.push({ line, message: "An accession number can be at most 40 characters." });
      return;
    }
    if (accession) {
      const first = seen.get(accession);
      if (first !== undefined) {
        problems.push({ line, message: `${accession} is also on line ${first}. Every copy needs its own number.` });
        return;
      }
      seen.set(accession, line);
    }
    good.push({ ...read.value, line, accessionNo: accession || null });
  });

  return { rows: problems.length ? [] : good, problems };
}

export type BookGroup = { fields: BookFields; copies: Array<{ line: number; accessionNo: string | null }> };

/**
 * Rows that are copies of the same title become ONE book with several copies. "Same" is title, author and ISBN,
 * compared without case or stray spaces: the paper register repeats the title on every line and nobody wants
 * eleven records of the same atlas. The first row's details win.
 */
export function groupIntoBooks(rows: CatalogueRow[]): BookGroup[] {
  const key = (r: BookFields) => [r.title, r.author ?? "", r.isbn ?? ""].map((part) => part.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
  const groups = new Map<string, BookGroup>();
  for (const row of rows) {
    const { line, accessionNo, ...fields } = row;
    const k = key(fields);
    const group = groups.get(k) ?? { fields, copies: [] };
    group.copies.push({ line, accessionNo });
    groups.set(k, group);
  }
  return [...groups.values()];
}
