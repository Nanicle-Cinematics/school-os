import "server-only";

import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { FINANCE, OFFICE, ACADEMIC } from "@/lib/permissions";
import { TEMPLATE_HEADERS } from "@/lib/import-data";
import { paymentSource } from "@/lib/payment-labels";

/**
 * Getting a school's own data back out.
 *
 * Until now it only went in: `/students/import` takes a CSV and there was no
 * export of anything, anywhere. A school could hand over its whole register,
 * its fees and three years of results and had no way to get a single row back —
 * no GES return, nothing for an auditor, and no way to leave. For a vendor
 * holding a school's records that is a trust question before it is a feature,
 * and the answer a school deserves is "here is all of it, in a file you can
 * open".
 *
 * Everything here is a READ. Exports keep working for a school in arrears, for
 * the same reason report cards do: the records are theirs, and withholding them
 * over an invoice punishes the wrong people.
 */

/* ────────────────────────────── writing CSV ────────────────────────────── */

/**
 * ⚠️ Escaping happens HERE, once, on the way out — never in a loader.
 *
 * It used to be the other way round: every loader called a `cell()` helper and
 * `toCsv` just joined the results. That is a rule a new dataset can forget, and
 * forgetting it is silent — the file only breaks from the first row that
 * happens to contain a comma, which in a school is the first address. It also
 * made the escaping untestable through the front door: the test fed in
 * hand-quoted strings and proved nothing but that the parser works.
 *
 * So loaders return RAW values and this is the only place that knows about
 * quotes.
 */
function cell(value: string | null | undefined, asText = false): string {
  // ⚠️ This `trim` is load-bearing for the formula check below, and it is not an accident. It strips
  // a leading space, tab, carriage return and newline, so "\t=1+1" and "\r=1+1" are reduced to
  // "=1+1" and caught, instead of sailing past a test that only looks at the first character —
  // which is how a spreadsheet or importer that trims whitespace would still read them. Remove it
  // and those cells stop being neutralised; verify:export checks every one of those spellings.
  const text = (value ?? "").trim();
  if (!text) {
    return "";
  }
  /** What a formula opens with. Excel and Sheets execute a cell that does. */
  const opensLikeAFormula = /^[=+\-@]/.test(text);
  /**
   * `asText` is the Ghana-specific one. `0244123456` opened in Excel becomes
   * the NUMBER 244123456, so a school that exports its contacts, tidies them in
   * a spreadsheet and imports them back has just texted the wrong numbers — or
   * nobody. A leading tab makes Excel and Sheets keep it as text, and our own
   * `parseCsv` trims every cell, so the tab is gone again by the time a row is
   * read back. `verify:export` proves the round trip rather than trusting it.
   *
   * ⚠️ The tab is for PHONE NUMBERS, and it used to be written in front of anything at all in a
   * text column, with the formula check below never reached. Those columns include `reference`
   * (typed by whoever records a payment), `phone` and `admission_no` (typed or imported by staff),
   * and the file is opened by someone else, so `=HYPERLINK("http://…","click")` left as a tab and
   * a formula was a hole in exactly the columns nobody thought of as free text. A leading tab is
   * also one of the characters OWASP lists as a way past a check that only looks at the first
   * character. So a text column keeps its tab only for what is plausibly a number to be dialled —
   * digits, an optional leading +, and the spaces, brackets and dashes people put in them — and
   * anything else that opens like a formula gets the apostrophe below instead, with no tab.
   */
  if (asText) {
    const lookLikeAPhoneNumber = /^\+?\d[\d\s().-]*$/.test(text);
    if (!opensLikeAFormula || lookLikeAPhoneNumber) {
      return `"\t${text.replace(/"/g, '""')}"`;
    }
    // Not a phone number, and it opens like a formula: an apostrophe makes the spreadsheet show it
    // as text. Unlike the ordinary path there is no number exemption, because this column must stay
    // text — a reference of "-50" is a reference, not an amount.
    return quoted(`'${text}`);
  }
  /**
   * ⚠️ Formula injection. A cell opening with = + - or @ is EXECUTED by Excel and
   * Sheets, and the names, addresses and notes in these exports are typed by
   * people other than the one who opens the file. A leading apostrophe makes
   * the spreadsheet show it as text. Plain signed numbers (an amount of -50.00)
   * are left alone so ledgers still sum.
   */
  const isPlainNumber = /^[-+]?\d+(\.\d+)?$/.test(text);
  return quoted(opensLikeAFormula && !isPlainNumber ? `'${text}` : text);
}

/** Wrap in quotes when the text holds anything a CSV reader would split or end a record on. */
function quoted(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const isoDate = (value: Date | null | undefined) =>
  value ? value.toISOString().slice(0, 10) : "";

const amount = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? "" : String(value);

/**
 * A whole file.
 *
 * The BOM is deliberate: without it Excel on Windows reads UTF-8 as Latin-1 and
 * every Ghanaian name with a diacritic arrives mangled. CRLF for the same
 * audience.
 *
 * `textColumns` names the headers that must not be read as numbers — phone
 * numbers, and anything else with a leading zero worth keeping.
 */
export function toCsv(
  headers: string[],
  rows: (string | null | undefined)[][],
  textColumns: readonly string[] = [],
): string {
  const asText = headers.map((header) => textColumns.includes(header));
  const lines = [
    headers.map((header) => cell(header)).join(","),
    ...rows.map((row) =>
      row.map((value, index) => cell(value, asText[index])).join(","),
    ),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/* ──────────────────────────── what can be taken ─────────────────────────── */

export type Dataset = {
  label: string;
  /** What the file is for, in the office's words. */
  description: string;
  /** Who may take it. An export is a bulk read of the whole school. */
  roles: Role[];
  /** Whether the caller must choose a term. */
  needsTerm: boolean;
  headers: string[];
  /**
   * Headers Excel must not read as numbers. Phone numbers, above all: the
   * leading zero of 0244123456 is the difference between a text that arrives
   * and one that does not.
   *
   * Required, not optional: a new dataset must DECIDE. Left to default, the one
   * that eventually carries a phone number would lose its zeros silently, which
   * is the whole failure this field exists to stop.
   */
  textColumns: readonly string[];
  load: (termId: string | null) => Promise<(string | null | undefined)[][]>;
};

export const DATASETS = {
  /**
   * Students, in EXACTLY the shape `/students/import` accepts.
   *
   * Same headers, same order, same vocabulary — so an export is also a working
   * import file, and a school can take its register out, correct a hundred rows
   * in a spreadsheet and put them back. `verify:export` feeds an export through
   * the real importer and checks it parses, because "same headers" is the kind
   * of claim that rots the first time either side is edited alone.
   */
  students: {
    label: "Students",
    description:
      "The full register, in the same columns /students/import accepts — so it goes back in as well as out.",
    roles: OFFICE,
    needsTerm: false,
    headers: TEMPLATE_HEADERS,
    textColumns: ["guardian_phone", "admission_no"],
    load: async () => {
      const students = await prisma.student.findMany({
        where: { deletedAt: null },
        orderBy: [{ admissionNo: "asc" }],
        include: {
          currentClassGroup: {
            select: { name: true, level: { select: { name: true } } },
          },
          house: { select: { name: true } },
          guardians: {
            where: { isPrimary: true },
            include: { guardian: true },
            take: 1,
          },
        },
      });

      return students.map((student) => {
        const link = student.guardians[0];
        const guardian = link?.guardian;
        return [
          student.firstName,
          student.middleName,
          student.lastName,
          student.gender,
          isoDate(student.dateOfBirth),
          student.currentClassGroup
            ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
            : "",
          student.admissionNo,
          student.residency,
          student.house?.name,
          guardian ? `${guardian.firstName} ${guardian.lastName}`.trim() : "",
          guardian?.phone,
          link?.relationship ?? "",
        ];
      });
    },
  },

  guardians: {
    label: "Guardians",
    description:
      "Every contact the school holds, and the children each one is linked to.",
    roles: OFFICE,
    needsTerm: false,
    headers: [
      "first_name",
      "last_name",
      "phone",
      "alt_phone",
      "email",
      "occupation",
      "address",
      "children",
      "receives_bills",
      "receives_reports",
    ],
    textColumns: ["phone", "alt_phone"],
    load: async () => {
      const guardians = await prisma.guardian.findMany({
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        include: {
          students: {
            include: {
              student: {
                select: { firstName: true, lastName: true, admissionNo: true },
              },
            },
          },
        },
      });

      return guardians.map((guardian) => [
        guardian.firstName,
        guardian.lastName,
        guardian.phone,
        guardian.altPhone,
        guardian.email,
        guardian.occupation,
        guardian.address,
        guardian.students
          .map(
            (link) =>
              `${link.student.firstName} ${link.student.lastName} (${link.student.admissionNo})`,
          )
          .join("; "),
        guardian.students.some((link) => link.receivesBills) ? "yes" : "no",
        guardian.students.some((link) => link.receivesReports) ? "yes" : "no",
      ]);
    },
  },

  staff: {
    label: "Staff",
    description: "The staff list with roles, contacts and appointment dates.",
    roles: OFFICE,
    needsTerm: false,
    headers: [
      "staff_no",
      "first_name",
      "last_name",
      "gender",
      "phone",
      "email",
      "designation",
      "qualification",
      "employment_type",
      "date_hired",
      "status",
    ],
    textColumns: ["phone", "staff_no"],
    load: async () => {
      const staff = await prisma.staff.findMany({
        where: { deletedAt: null },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      });

      return staff.map((person) => [
        person.staffNo,
        person.firstName,
        person.lastName,
        person.gender,
        person.phone,
        person.email,
        person.designation,
        person.qualification,
        person.employmentType,
        isoDate(person.dateHired),
        person.status,
      ]);
    },
  },

  invoices: {
    label: "Invoices",
    description:
      "Every bill for the term, what was paid and what is still owed.",
    roles: FINANCE,
    needsTerm: true,
    headers: [
      "invoice_no",
      "admission_no",
      "student",
      "class",
      "issue_date",
      "due_date",
      "total",
      "amount_paid",
      "balance",
      "status",
    ],
    textColumns: ["admission_no"],
    load: async (termId) => {
      const invoices = await prisma.invoice.findMany({
        where: { termId: termId ?? undefined },
        orderBy: [{ invoiceNo: "asc" }],
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              admissionNo: true,
              currentClassGroup: {
                select: { name: true, level: { select: { name: true } } },
              },
            },
          },
        },
      });

      // Imported here rather than at the top so the module stays readable: the
      // same derivation the screens use, because an export that disagreed with
      // /invoices about who is late would be worse than no export.
      const { displayStatus } = await import("@/lib/invoice-engine");

      return invoices.map((invoice) => [
        invoice.invoiceNo,
        invoice.student.admissionNo,
        `${invoice.student.firstName} ${invoice.student.lastName}`,
        invoice.student.currentClassGroup
          ? `${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
          : "",
        isoDate(invoice.issueDate),
        isoDate(invoice.dueDate),
        amount(invoice.total),
        amount(invoice.amountPaid),
        amount(invoice.balance),
        displayStatus(invoice),
      ]);
    },
  },

  payments: {
    label: "Payments",
    description: "Every receipt for the term, with method and reference.",
    roles: FINANCE,
    needsTerm: true,
    headers: [
      "receipt_no",
      "paid_at",
      "admission_no",
      "student",
      "amount",
      "method",
      "reference",
      "recorded_by",
      "status",
    ],
    textColumns: ["receipt_no", "admission_no", "reference"],
    load: async (termId) => {
      const payments = await prisma.payment.findMany({
        where: termId ? { allocations: { some: { invoice: { termId } } } } : {},
        orderBy: [{ paidAt: "asc" }],
        include: {
          student: {
            select: { firstName: true, lastName: true, admissionNo: true },
          },
          recordedBy: { select: { name: true } },
        },
      });

      return payments.map((payment) => [
        payment.receiptNo,
        isoDate(payment.paidAt),
        payment.student.admissionNo,
        `${payment.student.firstName} ${payment.student.lastName}`,
        amount(payment.amount),
        // The label a parent would recognise, not the enum — the receipt screen
        // learnt that the hard way when MOBILE_MONEY · TELECEL reached a parent.
        paymentSource(payment.method, payment.momoNetwork),
        payment.reference,
        payment.recordedBy?.name ?? "",
        payment.status,
      ]);
    },
  },

  /**
   * Every voucher for the term — the mirror of `payments`, so a school can
   * hand an accountant both halves of its cash book instead of only the
   * income side. Not filtered by status: a CANCELLED voucher is exactly the
   * kind of thing an auditor wants to see, not have silently dropped.
   */
  expenses: {
    label: "Expenses",
    description:
      "Every voucher for the term — what was spent, on what, and who approved it.",
    roles: FINANCE,
    needsTerm: true,
    headers: [
      "voucher_no",
      "spent_at",
      "category",
      "description",
      "amount",
      "payee",
      "method",
      "reference",
      "status",
      "recorded_by",
      "approved_by",
      "approved_at",
      "receipt_url",
    ],
    textColumns: ["voucher_no", "reference"],
    load: async (termId) => {
      const expenses = await prisma.expense.findMany({
        where: { termId: termId ?? undefined },
        orderBy: [{ spentAt: "asc" }],
        include: {
          category: { select: { name: true } },
          recordedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
        },
      });

      return expenses.map((expense) => [
        expense.voucherNo,
        isoDate(expense.spentAt),
        expense.category?.name ?? "",
        expense.description,
        amount(expense.amount),
        expense.payee,
        paymentSource(expense.method, expense.momoNetwork),
        expense.reference,
        expense.status,
        expense.recordedBy?.name ?? "",
        expense.approvedBy?.name ?? "",
        expense.approvedAt ? isoDate(expense.approvedAt) : "",
        expense.receiptUrl ?? "",
      ]);
    },
  },

  /**
   * Results, one row per student per subject.
   *
   * Long rather than wide on purpose: a broadsheet with a column per subject is
   * the right shape to LOOK at and the wrong shape to compute with, and it
   * changes width every time a class takes a different subject. This form opens
   * in a pivot table and survives a syllabus change.
   */
  results: {
    label: "Results",
    description:
      "One row per student per subject for the term — scores, grade and position.",
    roles: ACADEMIC,
    needsTerm: true,
    headers: [
      "admission_no",
      "student",
      "class",
      "subject",
      "class_score",
      "exam_score",
      "total_score",
      "grade",
      "remark",
      "subject_position",
      "term_average",
      "term_position",
      "term_status",
    ],
    textColumns: ["admission_no"],
    load: async (termId) => {
      const results = await prisma.subjectResult.findMany({
        where: { termId: termId ?? undefined },
        orderBy: [
          { student: { admissionNo: "asc" } },
          { subject: { order: "asc" } },
        ],
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              admissionNo: true,
            },
          },
          subject: { select: { name: true } },
          classGroup: {
            select: { name: true, level: { select: { name: true } } },
          },
        },
      });

      // One query for the term totals rather than one per row: a 600-row export
      // would otherwise be 600 round trips on a single pooled connection.
      const termResults = await prisma.termResult.findMany({
        where: { termId: termId ?? undefined },
        select: {
          studentId: true,
          average: true,
          classPosition: true,
          classSize: true,
          status: true,
        },
      });
      const byStudent = new Map(termResults.map((row) => [row.studentId, row]));

      return results.map((result) => {
        const term = byStudent.get(result.student.id);
        return [
          result.student.admissionNo,
          `${result.student.firstName} ${result.student.lastName}`,
          result.classGroup
            ? `${result.classGroup.level.name} ${result.classGroup.name}`
            : "",
          result.subject.name,
          amount(result.classScore),
          amount(result.examScore),
          amount(result.totalScore),
          result.grade,
          result.remark,
          result.subjectPosition === null ? "" : String(result.subjectPosition),
          amount(term?.average),
          term?.classPosition && term.classSize
            ? `${term.classPosition} of ${term.classSize}`
            : "",
          term?.status ?? "",
        ];
      });
    },
  },
} satisfies Record<string, Dataset>;

export type DatasetName = keyof typeof DATASETS;

/**
 * One dataset, as a `Dataset` rather than as its own literal type.
 *
 * `satisfies` keeps the key names exact — which is what makes `DatasetName` a
 * real union rather than `string` — but it also keeps each entry's own narrow
 * shape, so reading `.textColumns` off the union fails wherever one entry
 * happens to lack it. This is the typed way in.
 */
export const dataset = (name: DatasetName): Dataset => DATASETS[name];

export const DATASET_NAMES = Object.keys(DATASETS) as DatasetName[];

export function isDatasetName(value: string): value is DatasetName {
  return Object.hasOwn(DATASETS, value);
}

/**
 * What the file is called when it lands in Downloads.
 *
 * The school's slug and the date are in the name because these files are kept:
 * three of them in a folder called "exports" with no dates is a filing problem
 * the school inherits from us.
 */
export function exportFilename(
  dataset: DatasetName,
  schoolSlug: string,
  termLabel: string | null,
  now = new Date(),
) {
  const parts = [
    schoolSlug,
    dataset,
    termLabel,
    now.toISOString().slice(0, 10),
  ].filter(Boolean);
  return `${parts
    .join("-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .toLowerCase()}.csv`;
}
