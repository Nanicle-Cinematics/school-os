import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { parseCsv } from "@/lib/import-data";
import {
  ACCESSION_SHAPE,
  DEFAULT_POLICY,
  accessionCandidates,
  borrowerProblem,
  dayOf,
  daysOverdue,
  dueDateFor,
  fullName,
  groupIntoBooks,
  lendCheck,
  loanState,
  normaliseAccession,
  periodFor,
  readCatalogue,
  renewCheck,
  type BookFields,
  type BorrowerKind,
  type LibraryPolicy,
} from "@/lib/library-rules";
import { lockOn } from "@/lib/locks";
import { prisma, tenantTransaction, type TenantTx } from "@/lib/prisma";
import { nextNumbers, takenSets } from "@/lib/sequences";

/**
 * Everything that changes the library. The caller has run `requireRole` and set the tenant context; not a "use server"
 * module, because every export of one is a callable endpoint and these take the school as an argument.
 *
 * Three rules, each from how this app already handles a thing that two people can reach at once:
 *
 *  - A copy goes out to ONE person. Lending takes an advisory lock on the copy before it reads whether it is out, and
 *    on the borrower before it counts what they hold, so two desks cannot lend the same copy, or push one pupil past
 *    the limit, by pressing at the same moment. There is no partial unique index to lean on (Prisma cannot express
 *    one without reporting it as drift), so the lock and the re-read ARE the guarantee; `verify:library-route` races it.
 *  - A pupil, a member of staff, a copy or a book from a request is read back through the tenant client before it is
 *    written into a loan (the reads below are all `tx.…` reads, so a row of another school reads as absent).
 *  - Routine lending and returning is NOT written to the audit trail: the loan row is the record (who lent it, who took
 *    it back, when), and a school lending fifty books a day would bury every payment in the activity feed. What is
 *    audited is what changes the register itself: books deleted, copies lost or withdrawn, the policy, an import.
 */

export type Actor = { schoolId: string; userId: string };
export type Done = { ok: string };
export type Refused = { error: string };

type Db = TenantTx;

const day = (value: Date) => value.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
// "copy" is "copies" but "day" is "days": only a consonant before the y changes.
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/* ───────────────────────────── the school's policy ───────────────────────────── */

export async function readSchoolPolicy(schoolId: string, db?: Db): Promise<LibraryPolicy> {
  const client = (db ?? prisma) as unknown as typeof prisma;
  const row = await client.schoolSettings.findUnique({
    where: { schoolId },
    select: { libraryPupilDays: true, libraryStaffDays: true, libraryPupilMax: true, libraryStaffMax: true, libraryBlockOverdue: true },
  });
  if (!row) return DEFAULT_POLICY;
  return {
    pupilDays: row.libraryPupilDays,
    staffDays: row.libraryStaffDays,
    pupilMax: row.libraryPupilMax,
    staffMax: row.libraryStaffMax,
    blockOverdue: row.libraryBlockOverdue,
  };
}

export async function savePolicy(actor: Actor, policy: LibraryPolicy): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const saved = await tx.schoolSettings.updateMany({
      where: { schoolId: actor.schoolId },
      data: {
        libraryPupilDays: policy.pupilDays,
        libraryStaffDays: policy.staffDays,
        libraryPupilMax: policy.pupilMax,
        libraryStaffMax: policy.staffMax,
        libraryBlockOverdue: policy.blockOverdue,
      },
    });
    if (saved.count === 0) return { error: "This school has no settings record yet. Open Settings once, then try again." };
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "library.policy",
      entity: "SchoolSettings",
      entityId: actor.schoolId,
      after: { ...policy },
    });
    return { ok: "The library's rules were saved. Books already out keep the date they were given." };
  });
}

/* ───────────────────────────── finding a copy ───────────────────────────── */

type CopyFound = {
  id: string;
  accessionNo: string;
  status: "ACTIVE" | "LOST" | "WITHDRAWN";
  book: { title: string };
};

/** The copy a scan or a few keystrokes mean, as typed first and zero-padded second. Null when no copy has that number. */
async function findCopy(db: Db, schoolId: string, input: string): Promise<CopyFound | null> {
  const candidates = accessionCandidates(input, ACCESSION_SHAPE.prefix, ACCESSION_SHAPE.padding);
  if (candidates.length === 0) return null;
  const rows = await db.bookCopy.findMany({
    where: { schoolId, accessionNo: { in: candidates } },
    select: { id: true, accessionNo: true, status: true, book: { select: { title: true } } },
  });
  for (const candidate of candidates) {
    const hit = rows.find((row) => row.accessionNo === candidate);
    if (hit) return hit;
  }
  return null;
}

const openLoanWhere = (copyId: string) => ({ copyId, returnedOn: null });

/* ───────────────────────────── lending and returning ───────────────────────────── */

export type LendArgs = { kind: BorrowerKind; borrowerId: string; accession: string };

export async function lend(actor: Actor, args: LendArgs): Promise<Done | Refused> {
  const typed = normaliseAccession(args.accession);
  if (!typed) return { error: "Scan or type the book's accession number." };

  return tenantTransaction(actor.schoolId, async (tx) => {
    const found = await findCopy(tx, actor.schoolId, typed);
    if (!found) return { error: `No book in this library is numbered ${typed}.` };

    // Lock the copy, then the person, always in that order, BEFORE reading what they protect.
    await lockOn(tx, `library:copy:${found.id}`);
    await lockOn(tx, `library:borrower:${args.borrowerId}`);

    const copy = await tx.bookCopy.findFirst({
      where: { id: found.id, schoolId: actor.schoolId },
      select: { id: true, accessionNo: true, status: true, book: { select: { title: true } }, loans: { where: { returnedOn: null }, select: { id: true }, take: 1 } },
    });
    if (!copy) return { error: `No book in this library is numbered ${typed}.` };

    const who =
      args.kind === "STUDENT"
        ? await tx.student.findFirst({ where: { id: args.borrowerId, schoolId: actor.schoolId }, select: { firstName: true, middleName: true, lastName: true, status: true, deletedAt: true } })
        : await tx.staff.findFirst({ where: { id: args.borrowerId, schoolId: actor.schoolId }, select: { firstName: true, middleName: true, lastName: true, status: true, deletedAt: true } });
    if (!who) return { error: "That person was not found in this school." };
    const borrowerName = fullName(who);

    const problem = borrowerProblem(args.kind, { status: who.status, deletedAt: who.deletedAt, name: borrowerName });
    if (problem) return { error: problem };

    const today = dayOf();
    const held = await tx.libraryLoan.findMany({
      where: { schoolId: actor.schoolId, returnedOn: null, ...(args.kind === "STUDENT" ? { studentId: args.borrowerId } : { staffId: args.borrowerId }) },
      select: { dueOn: true, returnedOn: true, outcome: true },
    });
    const policy = await readSchoolPolicy(actor.schoolId, tx);
    const verdict = lendCheck({
      kind: args.kind,
      borrowerName,
      held: held.length,
      overdue: held.filter((loan) => loanState(loan, today) === "OVERDUE").length,
      copy: { accessionNo: copy.accessionNo, title: copy.book.title, status: copy.status, onLoan: copy.loans.length > 0 },
      policy,
    });
    if (!verdict.ok) return { error: verdict.error };

    const dueOn = dueDateFor(args.kind, policy, today);
    await tx.libraryLoan.create({
      data: {
        schoolId: actor.schoolId,
        copyId: copy.id,
        ...(args.kind === "STUDENT" ? { studentId: args.borrowerId } : { staffId: args.borrowerId }),
        borrowedOn: today,
        dueOn,
        issuedByUserId: actor.userId,
      },
    });
    return { ok: `${copy.book.title} (${copy.accessionNo}) lent to ${borrowerName}. Due back ${day(dueOn)}.` };
  });
}

export type ReturnTarget = { accession: string } | { loanId: string };

/** Takes a book back, from the scan at the desk or the Return button beside a name. Closing is a conditional update. */
export async function returnBook(actor: Actor, target: ReturnTarget): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    let copyId: string;
    if ("accession" in target) {
      const typed = normaliseAccession(target.accession);
      if (!typed) return { error: "Scan or type the book's accession number." };
      const found = await findCopy(tx, actor.schoolId, typed);
      if (!found) return { error: `No book in this library is numbered ${typed}.` };
      copyId = found.id;
    } else {
      const loan = await tx.libraryLoan.findFirst({ where: { id: target.loanId, schoolId: actor.schoolId }, select: { copyId: true } });
      if (!loan) return { error: "That loan was not found." };
      copyId = loan.copyId;
    }

    await lockOn(tx, `library:copy:${copyId}`);
    const loan = await tx.libraryLoan.findFirst({
      where: { ...openLoanWhere(copyId), schoolId: actor.schoolId },
      select: {
        id: true,
        dueOn: true,
        returnedOn: true,
        outcome: true,
        copy: { select: { accessionNo: true, book: { select: { title: true } } } },
        student: { select: { firstName: true, middleName: true, lastName: true } },
        staff: { select: { firstName: true, middleName: true, lastName: true } },
      },
    });
    if (!loan) return { error: "That book is not out. It may already have been returned." };

    const today = dayOf();
    const closed = await tx.libraryLoan.updateMany({
      where: { id: loan.id, schoolId: actor.schoolId, returnedOn: null },
      data: { returnedOn: today, outcome: "RETURNED", closedByUserId: actor.userId },
    });
    if (closed.count === 0) return { error: "That book has already been returned." };

    const late = daysOverdue(loan, today);
    const name = fullName((loan.student ?? loan.staff)!);
    return {
      ok: `${loan.copy.book.title} (${loan.copy.accessionNo}) returned by ${name}.${late > 0 ? ` It was ${plural(late, "day")} late.` : ""}`,
    };
  });
}

export async function renewLoan(actor: Actor, loanId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const first = await tx.libraryLoan.findFirst({ where: { id: loanId, schoolId: actor.schoolId }, select: { copyId: true } });
    if (!first) return { error: "That loan was not found." };
    await lockOn(tx, `library:copy:${first.copyId}`);

    const loan = await tx.libraryLoan.findFirst({
      where: { id: loanId, schoolId: actor.schoolId },
      select: { id: true, dueOn: true, returnedOn: true, outcome: true, renewals: true, studentId: true, copy: { select: { status: true, accessionNo: true, book: { select: { title: true } } } } },
    });
    if (!loan) return { error: "That loan was not found." };

    const today = dayOf();
    const verdict = renewCheck(loan, loan.copy.status, today);
    if (!verdict.ok) return { error: verdict.error };

    const kind: BorrowerKind = loan.studentId ? "STUDENT" : "STAFF";
    const policy = await readSchoolPolicy(actor.schoolId, tx);
    const dueOn = dueDateFor(kind, policy, today);
    const moved = await tx.libraryLoan.updateMany({
      where: { id: loan.id, schoolId: actor.schoolId, returnedOn: null, renewals: loan.renewals },
      data: { dueOn, renewals: { increment: 1 } },
    });
    if (moved.count === 0) return { error: "That loan changed while you were looking at it. Try again." };
    return { ok: `${loan.copy.book.title} (${loan.copy.accessionNo}) renewed for ${plural(periodFor(kind, policy), "day")}. Due back ${day(dueOn)}.` };
  });
}

/* ───────────────────────────── the catalogue ───────────────────────────── */

const bookData = (fields: BookFields) => ({
  title: fields.title,
  author: fields.author,
  isbn: fields.isbn,
  publisher: fields.publisher,
  publishedYear: fields.publishedYear,
  category: fields.category,
  shelf: fields.shelf,
  replacementCost: fields.replacementCost === null ? null : new Prisma.Decimal(fields.replacementCost),
  notes: fields.notes,
});

/** Numbers for `count` new copies, skipping any the school already holds. Inside the transaction that uses them. */
async function numbersFor(tx: Db, schoolId: string, count: number, reserved: Set<string> = new Set()) {
  const database = takenSets.accession(tx, schoolId);
  return nextNumbers(tx, schoolId, "ACCESSION", count, async (candidates) => {
    const taken = await database(candidates);
    for (const candidate of candidates) if (reserved.has(candidate)) taken.add(candidate);
    return taken;
  });
}

const MAX_COPIES_AT_ONCE = 200;

export async function createBook(actor: Actor, fields: BookFields, copies: number): Promise<{ id: string } | Refused> {
  if (!Number.isInteger(copies) || copies < 0 || copies > MAX_COPIES_AT_ONCE) {
    return { error: `Add between 0 and ${MAX_COPIES_AT_ONCE} copies at a time.` };
  }
  return tenantTransaction(actor.schoolId, async (tx) => {
    const book = await tx.book.create({ data: { schoolId: actor.schoolId, ...bookData(fields) }, select: { id: true } });
    if (copies > 0) {
      const numbers = await numbersFor(tx, actor.schoolId, copies);
      await tx.bookCopy.createMany({
        data: numbers.map((accessionNo) => ({ schoolId: actor.schoolId, bookId: book.id, accessionNo })),
      });
    }
    return { id: book.id };
  });
}

export async function updateBook(actor: Actor, bookId: string, fields: BookFields): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const saved = await tx.book.updateMany({ where: { id: bookId, schoolId: actor.schoolId }, data: bookData(fields) });
    return saved.count === 0 ? { error: "That book was not found." } : { ok: "Saved." };
  });
}

/** Refused once any copy has ever gone out: the history of who had what must outlive the shelf. Withdraw the copies instead. */
export async function deleteBook(actor: Actor, bookId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const book = await tx.book.findFirst({ where: { id: bookId, schoolId: actor.schoolId }, select: { id: true, title: true, _count: { select: { copies: true } } } });
    if (!book) return { error: "That book was not found." };
    const lent = await tx.libraryLoan.count({ where: { schoolId: actor.schoolId, copy: { bookId } } });
    if (lent > 0) {
      return { error: `${book.title} has been lent ${plural(lent, "time")}, so its record is kept. Withdraw its copies instead.` };
    }
    await tx.book.delete({ where: { id: book.id } });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "library.book.delete",
      entity: "Book",
      entityId: book.id,
      after: { copies: book._count.copies },
    });
    return { ok: `${book.title} was deleted.` };
  });
}

export type AddCopyArgs = { bookId: string; count: number; accessionNo?: string };

/** More copies of a title: `count` numbered by the library, or one carrying the number the school already gave it. */
export async function addCopies(actor: Actor, args: AddCopyArgs): Promise<Done | Refused> {
  const typed = normaliseAccession(args.accessionNo ?? "");
  if (typed.length > 40) return { error: "An accession number can be at most 40 characters." };
  if (!typed && (!Number.isInteger(args.count) || args.count < 1 || args.count > MAX_COPIES_AT_ONCE)) {
    return { error: `Add between 1 and ${MAX_COPIES_AT_ONCE} copies at a time.` };
  }
  return tenantTransaction(actor.schoolId, async (tx) => {
    const book = await tx.book.findFirst({ where: { id: args.bookId, schoolId: actor.schoolId }, select: { id: true, title: true } });
    if (!book) return { error: "That book was not found." };

    if (typed) {
      const clash = await tx.bookCopy.findFirst({ where: { schoolId: actor.schoolId, accessionNo: typed }, select: { id: true } });
      if (clash) return { error: `${typed} is already the number of another copy.` };
      await tx.bookCopy.create({ data: { schoolId: actor.schoolId, bookId: book.id, accessionNo: typed } });
      return { ok: `Added ${typed}.` };
    }
    const numbers = await numbersFor(tx, actor.schoolId, args.count);
    await tx.bookCopy.createMany({ data: numbers.map((accessionNo) => ({ schoolId: actor.schoolId, bookId: book.id, accessionNo })) });
    return { ok: args.count === 1 ? `Added ${numbers[0]}.` : `Added ${plural(args.count, "copy")}, ${numbers[0]} to ${numbers[numbers.length - 1]}.` };
  });
}

/* ───────────────────────────── a copy's life: lost, withdrawn, found ───────────────────────────── */

export type CopyChange = "lost" | "withdraw" | "reinstate";

/**
 * Lost: if it is out, the loan is closed as LOST against the borrower and the copy is marked lost. Withdrawn
 * (damaged, discarded, sold) is refused while it is out: take it back or call it lost. Reinstated: a lost or
 * withdrawn copy back into stock, because books turn up.
 */
export async function changeCopy(actor: Actor, copyId: string, change: CopyChange, note: string): Promise<Done | Refused> {
  const why = note.trim().slice(0, 300) || null;
  return tenantTransaction(actor.schoolId, async (tx) => {
    const first = await tx.bookCopy.findFirst({ where: { id: copyId, schoolId: actor.schoolId }, select: { id: true } });
    if (!first) return { error: "That copy was not found." };
    await lockOn(tx, `library:copy:${copyId}`);

    const copy = await tx.bookCopy.findFirst({
      where: { id: copyId, schoolId: actor.schoolId },
      select: {
        id: true,
        accessionNo: true,
        status: true,
        book: { select: { title: true, replacementCost: true } },
        loans: {
          where: { returnedOn: null },
          select: { id: true, student: { select: { firstName: true, middleName: true, lastName: true } }, staff: { select: { firstName: true, middleName: true, lastName: true } } },
          take: 1,
        },
      },
    });
    if (!copy) return { error: "That copy was not found." };
    const open = copy.loans[0] ?? null;
    const label = `${copy.book.title} (${copy.accessionNo})`;
    const today = dayOf();

    if (change === "reinstate") {
      if (copy.status === "ACTIVE") return { error: `${label} is already in stock.` };
      await tx.bookCopy.update({ where: { id: copy.id }, data: { status: "ACTIVE", statusNote: null, statusChangedOn: today } });
      return { ok: `${label} is back in stock.` };
    }

    if (copy.status !== "ACTIVE") return { error: `${label} is already recorded as ${copy.status === "LOST" ? "lost" : "withdrawn"}.` };

    if (change === "withdraw") {
      if (open) return { error: `${label} is out. Take it back first, or record it as lost.` };
      await tx.bookCopy.update({ where: { id: copy.id }, data: { status: "WITHDRAWN", statusNote: why, statusChangedOn: today } });
      await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "library.copy.withdraw", entity: "BookCopy", entityId: copy.id, after: { accessionNo: copy.accessionNo } });
      return { ok: `${label} was withdrawn.` };
    }

    // lost
    let borrower = "";
    if (open) {
      const closed = await tx.libraryLoan.updateMany({
        where: { id: open.id, schoolId: actor.schoolId, returnedOn: null },
        data: { returnedOn: today, outcome: "LOST", closedByUserId: actor.userId, note: why },
      });
      if (closed.count === 1) borrower = fullName((open.student ?? open.staff)!);
    }
    await tx.bookCopy.update({ where: { id: copy.id }, data: { status: "LOST", statusNote: why, statusChangedOn: today } });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "library.copy.lost",
      entity: "BookCopy",
      entityId: copy.id,
      after: { accessionNo: copy.accessionNo, wasOut: Boolean(borrower) },
    });
    const cost = copy.book.replacementCost ? ` It would cost GH₵${copy.book.replacementCost.toFixed(2)} to replace.` : "";
    return { ok: `${label} was recorded as lost${borrower ? `, by ${borrower}` : ""}.${cost}` };
  });
}

/** For a copy keyed in by mistake: only while it has never gone out. After that it is withdrawn, never erased. */
export async function deleteCopy(actor: Actor, copyId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const copy = await tx.bookCopy.findFirst({ where: { id: copyId, schoolId: actor.schoolId }, select: { id: true, accessionNo: true } });
    if (!copy) return { error: "That copy was not found." };
    const lent = await tx.libraryLoan.count({ where: { schoolId: actor.schoolId, copyId } });
    if (lent > 0) return { error: `${copy.accessionNo} has been lent ${plural(lent, "time")}, so it is kept. Withdraw it instead.` };
    await tx.bookCopy.delete({ where: { id: copy.id } });
    return { ok: `${copy.accessionNo} was deleted.` };
  });
}

/* ───────────────────────────── the catalogue, from a spreadsheet ───────────────────────────── */

export type CatalogueReport = { copies: number; books: number; problems: Array<{ line: number; message: string }> };

/** Reads and checks the file against the register, writing nothing. Every problem is listed, with its line. */
export async function checkCatalogue(schoolId: string, csv: string, now = new Date()): Promise<CatalogueReport> {
  const { rows } = parseCsv(csv);
  if (rows.length === 0) return { copies: 0, books: 0, problems: [{ line: 0, message: "The file has no rows. The first row must be the headings, with a title column." }] };

  const read = readCatalogue(rows, now);
  if (read.problems.length > 0) return { copies: 0, books: 0, problems: read.problems };

  const typed = read.rows.filter((row) => row.accessionNo).map((row) => row.accessionNo!);
  const taken = typed.length
    ? await prisma.bookCopy.findMany({ where: { schoolId, accessionNo: { in: typed } }, select: { accessionNo: true } })
    : [];
  const held = new Set(taken.map((row) => row.accessionNo));
  const problems = read.rows
    .filter((row) => row.accessionNo && held.has(row.accessionNo))
    .map((row) => ({ line: row.line, message: `${row.accessionNo} is already in the library.` }));
  if (problems.length > 0) return { copies: 0, books: 0, problems };

  return { copies: read.rows.length, books: groupIntoBooks(read.rows).length, problems: [] };
}

/**
 * Adds every row, or none. Checks again in full: the report on screen is advisory, and the file may have been edited
 * since. Rows that are copies of one title become one book; a blank accession number is numbered by the library,
 * skipping every number the file itself carries as well as the ones already held.
 */
export async function addCatalogue(actor: Actor, csv: string): Promise<(Done & { added: number }) | Refused> {
  const report = await checkCatalogue(actor.schoolId, csv);
  if (report.problems.length > 0) {
    return { error: `The file was not added: ${report.problems[0]!.message}${report.problems.length > 1 ? ` (and ${report.problems.length - 1} more)` : ""}` };
  }
  const read = readCatalogue(parseCsv(csv).rows);
  const groups = groupIntoBooks(read.rows);
  const typed = new Set(read.rows.filter((row) => row.accessionNo).map((row) => row.accessionNo!));
  const blanks = read.rows.filter((row) => !row.accessionNo).length;

  return tenantTransaction(
    actor.schoolId,
    async (tx) => {
      // The ids are made here so the copies can name their book without reading the books back.
      const books = groups.map((group) => ({ id: randomUUID(), group }));
      await tx.book.createMany({ data: books.map(({ id, group }) => ({ id, schoolId: actor.schoolId, ...bookData(group.fields) })) });

      const generated = blanks > 0 ? await numbersFor(tx, actor.schoolId, blanks, typed) : [];
      let next = 0;
      const copies = books.flatMap(({ id, group }) =>
        group.copies.map((copy) => ({ schoolId: actor.schoolId, bookId: id, accessionNo: copy.accessionNo ?? generated[next++]! })),
      );
      await tx.bookCopy.createMany({ data: copies });
      await writeAudit(tx, {
        schoolId: actor.schoolId,
        actorUserId: actor.userId,
        action: "library.import",
        entity: "Book",
        entityId: actor.schoolId,
        after: { books: books.length, copies: copies.length },
      });
      return { ok: `Added ${plural(books.length, "book")} and ${plural(copies.length, "copy")} to the library.`, added: copies.length };
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
}
