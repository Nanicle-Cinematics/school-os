import "server-only";

import type { BorrowerKind, LoanState } from "@/lib/library-rules";
import type { CopyStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dayOf, daysOverdue, fullName, loanState } from "@/lib/library-rules";
import { readSchoolPolicy } from "@/lib/library-engine";

/**
 * What the library screens read.
 *
 * Every function is a fixed handful of queries, awaited one after another: four connections serve a whole page and
 * every query under row security holds one for several round trips (see CLAUDE.md). A library with ten thousand
 * copies still costs the same number of queries as one with ten, because the lists are capped and the counts are
 * grouped, never one query per row. Lateness is worked out here, from the due date, and never read from a column.
 */

const LIST_CAP = 300;

const loanSelect = {
  id: true,
  borrowedOn: true,
  dueOn: true,
  returnedOn: true,
  outcome: true,
  renewals: true,
  note: true,
  copy: { select: { id: true, accessionNo: true, book: { select: { id: true, title: true, author: true } } } },
  student: {
    select: {
      id: true,
      firstName: true,
      middleName: true,
      lastName: true,
      admissionNo: true,
      status: true,
      deletedAt: true,
      currentClassGroup: { select: { name: true } },
    },
  },
  staff: { select: { id: true, firstName: true, middleName: true, lastName: true, staffNo: true, status: true, deletedAt: true, designation: true } },
} satisfies Prisma.LibraryLoanSelect;

type LoanRecord = Prisma.LibraryLoanGetPayload<{ select: typeof loanSelect }>;

export type LoanRow = {
  id: string;
  copyId: string;
  accessionNo: string;
  bookId: string;
  title: string;
  author: string | null;
  borrowedOn: Date;
  dueOn: Date;
  returnedOn: Date | null;
  renewals: number;
  note: string | null;
  state: LoanState;
  daysOverdue: number;
  borrower: {
    kind: BorrowerKind;
    id: string;
    name: string;
    detail: string;
    /** Removed or no longer on the roll: the book is still theirs to bring back, and the office should know. */
    gone: boolean;
  };
};

function shape(loan: LoanRecord, today: Date): LoanRow {
  const student = loan.student;
  const staff = loan.staff;
  const borrower = student
    ? {
        kind: "STUDENT" as const,
        id: student.id,
        name: fullName(student),
        detail: [student.currentClassGroup?.name, student.admissionNo].filter(Boolean).join(" · "),
        gone: student.deletedAt !== null || student.status !== "ACTIVE",
      }
    : {
        kind: "STAFF" as const,
        id: staff!.id,
        name: fullName(staff!),
        detail: [staff!.designation, staff!.staffNo].filter(Boolean).join(" · "),
        gone: staff!.deletedAt !== null || !(staff!.status === "ACTIVE" || staff!.status === "ON_LEAVE"),
      };
  return {
    id: loan.id,
    copyId: loan.copy.id,
    accessionNo: loan.copy.accessionNo,
    bookId: loan.copy.book.id,
    title: loan.copy.book.title,
    author: loan.copy.book.author,
    borrowedOn: loan.borrowedOn,
    dueOn: loan.dueOn,
    returnedOn: loan.returnedOn,
    renewals: loan.renewals,
    note: loan.note,
    state: loanState(loan, today),
    daysOverdue: daysOverdue(loan, today),
    borrower,
  };
}

/** Name tokens: each word typed must match somewhere, so "ama mensah" finds Ama Serwaa Mensah. */
function tokensOf(q: string) {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
}

/* ───────────────────────────── the front page ───────────────────────────── */

export async function getLibraryOverview(schoolId: string) {
  const titles = await prisma.book.count({ where: { schoolId } });
  const byStatus = await prisma.bookCopy.groupBy({ by: ["status"], where: { schoolId }, _count: { _all: true } });
  const today = dayOf();
  // Open loans are the ones that matter and there are few of them: the oldest due date first puts the late ones on top.
  const open = await prisma.libraryLoan.findMany({
    where: { schoolId, returnedOn: null },
    select: loanSelect,
    orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }],
    take: LIST_CAP + 1,
  });

  const rows = open.slice(0, LIST_CAP).map((loan) => shape(loan, today));
  const copies: Record<CopyStatus, number> = { ACTIVE: 0, LOST: 0, WITHDRAWN: 0 };
  for (const row of byStatus) copies[row.status] = row._count._all;

  return {
    titles,
    copies,
    out: open.length > LIST_CAP ? `${LIST_CAP}+` : String(open.length),
    outCount: open.length,
    overdue: rows.filter((row) => row.state === "OVERDUE"),
    truncated: open.length > LIST_CAP,
    hasCatalogue: titles > 0,
  };
}

/* ───────────────────────────── the catalogue ───────────────────────────── */

export type BookFilter = { q?: string; category?: string };

export async function getBookCategories(schoolId: string) {
  const rows = await prisma.book.groupBy({ by: ["category"], where: { schoolId, category: { not: null } }, orderBy: { category: "asc" } });
  return rows.map((row) => row.category!).filter(Boolean);
}

export async function getBooks(schoolId: string, filter: BookFilter) {
  const where: Prisma.BookWhereInput = { schoolId };
  if (filter.category) where.category = filter.category;
  const tokens = tokensOf(filter.q ?? "");
  if (tokens.length) {
    where.AND = tokens.map((token) => ({
      OR: [
        { title: { contains: token, mode: "insensitive" as const } },
        { author: { contains: token, mode: "insensitive" as const } },
        { isbn: { contains: token.replace(/-/g, "") } },
        { copies: { some: { accessionNo: { contains: token, mode: "insensitive" as const } } } },
      ],
    }));
  }

  const rows = await prisma.book.findMany({
    where,
    orderBy: [{ title: "asc" }],
    take: LIST_CAP + 1,
    select: {
      id: true,
      title: true,
      author: true,
      category: true,
      shelf: true,
      copies: { select: { id: true, status: true, loans: { where: { returnedOn: null }, select: { id: true }, take: 1 } } },
    },
  });
  return {
    truncated: rows.length > LIST_CAP,
    rows: rows.slice(0, LIST_CAP).map((book) => {
      const inStock = book.copies.filter((copy) => copy.status === "ACTIVE");
      const out = inStock.filter((copy) => copy.loans.length > 0).length;
      return {
        id: book.id,
        title: book.title,
        author: book.author,
        category: book.category,
        shelf: book.shelf,
        copies: inStock.length,
        out,
        available: inStock.length - out,
        gone: book.copies.length - inStock.length,
      };
    }),
  };
}

export async function getBook(schoolId: string, bookId: string) {
  const book = await prisma.book.findFirst({
    where: { id: bookId, schoolId },
    select: {
      id: true,
      title: true,
      author: true,
      isbn: true,
      publisher: true,
      publishedYear: true,
      category: true,
      shelf: true,
      replacementCost: true,
      notes: true,
      copies: {
        orderBy: { accessionNo: "asc" },
        select: {
          id: true,
          accessionNo: true,
          status: true,
          statusNote: true,
          statusChangedOn: true,
          loans: { where: { returnedOn: null }, select: loanSelect, take: 1 },
          _count: { select: { loans: true } },
        },
      },
    },
  });
  if (!book) return null;

  const history = await prisma.libraryLoan.findMany({
    where: { schoolId, copy: { bookId } },
    select: loanSelect,
    orderBy: [{ borrowedOn: "desc" }, { createdAt: "desc" }],
    take: 40,
  });
  const today = dayOf();
  return {
    book: { ...book, replacementCost: book.replacementCost ? book.replacementCost.toFixed(2) : null },
    copies: book.copies.map((copy) => ({
      id: copy.id,
      accessionNo: copy.accessionNo,
      status: copy.status,
      statusNote: copy.statusNote,
      statusChangedOn: copy.statusChangedOn,
      everLent: copy._count.loans > 0,
      loan: copy.loans[0] ? shape(copy.loans[0], today) : null,
    })),
    history: history.map((loan) => shape(loan, today)),
  };
}

/* ───────────────────────────── lending ───────────────────────────── */

export type BorrowerHit = { kind: BorrowerKind; id: string; name: string; detail: string };

/** Pupils on the roll and staff who may borrow, by name, admission number or staff number. Two letters at least. */
export async function searchBorrowers(schoolId: string, q: string): Promise<BorrowerHit[]> {
  const tokens = tokensOf(q);
  if (tokens.join("").length < 2) return [];

  const students = await prisma.student.findMany({
    where: {
      schoolId,
      deletedAt: null,
      status: "ACTIVE",
      AND: tokens.map((token) => ({
        OR: [
          { firstName: { contains: token, mode: "insensitive" as const } },
          { lastName: { contains: token, mode: "insensitive" as const } },
          { middleName: { contains: token, mode: "insensitive" as const } },
          { admissionNo: { contains: token, mode: "insensitive" as const } },
        ],
      })),
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 12,
    select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, currentClassGroup: { select: { name: true } } },
  });
  const staff = await prisma.staff.findMany({
    where: {
      schoolId,
      deletedAt: null,
      status: { in: ["ACTIVE", "ON_LEAVE"] },
      AND: tokens.map((token) => ({
        OR: [
          { firstName: { contains: token, mode: "insensitive" as const } },
          { lastName: { contains: token, mode: "insensitive" as const } },
          { staffNo: { contains: token, mode: "insensitive" as const } },
        ],
      })),
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 8,
    select: { id: true, firstName: true, middleName: true, lastName: true, staffNo: true, designation: true },
  });

  return [
    ...students.map((s) => ({
      kind: "STUDENT" as const,
      id: s.id,
      name: fullName(s),
      detail: [s.currentClassGroup?.name, s.admissionNo].filter(Boolean).join(" · "),
    })),
    ...staff.map((s) => ({
      kind: "STAFF" as const,
      id: s.id,
      name: fullName(s),
      detail: ["Staff", s.designation, s.staffNo].filter(Boolean).join(" · "),
    })),
  ];
}

/** One person at the desk: who they are, what they have out, and the rules that apply to them. */
export async function getBorrowerDesk(schoolId: string, kind: BorrowerKind, id: string) {
  const person =
    kind === "STUDENT"
      ? await prisma.student.findFirst({
          where: { id, schoolId },
          select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, status: true, deletedAt: true, currentClassGroup: { select: { name: true } } },
        })
      : await prisma.staff.findFirst({
          where: { id, schoolId },
          select: { id: true, firstName: true, middleName: true, lastName: true, staffNo: true, status: true, deletedAt: true, designation: true },
        });
  if (!person) return null;

  const loans = await prisma.libraryLoan.findMany({
    where: { schoolId, returnedOn: null, ...(kind === "STUDENT" ? { studentId: id } : { staffId: id }) },
    select: loanSelect,
    orderBy: { dueOn: "asc" },
  });
  const policy = await readSchoolPolicy(schoolId);
  const today = dayOf();
  const rows = loans.map((loan) => shape(loan, today));

  const detail =
    "admissionNo" in person
      ? [person.currentClassGroup?.name, person.admissionNo].filter(Boolean).join(" · ")
      : [person.designation, person.staffNo].filter(Boolean).join(" · ");

  return {
    kind,
    id: person.id,
    name: fullName(person),
    detail,
    status: person.status,
    deletedAt: person.deletedAt,
    loans: rows,
    overdue: rows.filter((row) => row.state === "OVERDUE").length,
    policy,
  };
}

/* ───────────────────────────── who has what ───────────────────────────── */

export type LoanFilter = { overdueOnly?: boolean; q?: string; kind?: BorrowerKind };

export async function getOpenLoans(schoolId: string, filter: LoanFilter) {
  const today = dayOf();
  const where: Prisma.LibraryLoanWhereInput = { schoolId, returnedOn: null };
  if (filter.overdueOnly) where.dueOn = { lt: today };
  if (filter.kind === "STUDENT") where.studentId = { not: null };
  if (filter.kind === "STAFF") where.staffId = { not: null };
  const tokens = tokensOf(filter.q ?? "");
  if (tokens.length) {
    where.AND = tokens.map((token) => ({
      OR: [
        { copy: { accessionNo: { contains: token, mode: "insensitive" as const } } },
        { copy: { book: { title: { contains: token, mode: "insensitive" as const } } } },
        { student: { OR: [{ firstName: { contains: token, mode: "insensitive" as const } }, { lastName: { contains: token, mode: "insensitive" as const } }, { admissionNo: { contains: token, mode: "insensitive" as const } }] } },
        { staff: { OR: [{ firstName: { contains: token, mode: "insensitive" as const } }, { lastName: { contains: token, mode: "insensitive" as const } }, { staffNo: { contains: token, mode: "insensitive" as const } }] } },
      ],
    }));
  }
  const rows = await prisma.libraryLoan.findMany({ where, select: loanSelect, orderBy: [{ dueOn: "asc" }, { createdAt: "asc" }], take: LIST_CAP + 1 });
  return { truncated: rows.length > LIST_CAP, rows: rows.slice(0, LIST_CAP).map((loan) => shape(loan, today)) };
}

/** A pupil's books out, for their page in the office and for their parent's. */
export async function getStudentLoans(schoolId: string, studentId: string) {
  const today = dayOf();
  const rows = await prisma.libraryLoan.findMany({
    where: { schoolId, studentId, returnedOn: null },
    select: loanSelect,
    orderBy: { dueOn: "asc" },
  });
  return rows.map((loan) => shape(loan, today));
}

/** A member of staff's books out. */
export async function getStaffLoans(schoolId: string, staffId: string) {
  const today = dayOf();
  const rows = await prisma.libraryLoan.findMany({
    where: { schoolId, staffId, returnedOn: null },
    select: loanSelect,
    orderBy: { dueOn: "asc" },
  });
  return rows.map((loan) => shape(loan, today));
}

/** The library's rules, for the settings screen. */
export const getLibraryPolicy = (schoolId: string) => readSchoolPolicy(schoolId);
