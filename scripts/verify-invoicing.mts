/**
 * Checks the two decisions that stand between a student and a bill: which fee
 * structure applies to them, and — when none does — what to tell the bursar.
 *
 * Pure functions, no database. Run: npm run verify:invoicing
 */
import { Prisma } from "@prisma/client";
import {
  chooseFeeStructure,
  daysOverdue,
  displayStatus,
  explainNoStructure,
  groupSkipped,
  invoiceStatusFor,
  isOverdue,
  statusFilterWhere,
  type SkippedStudent,
} from "@/lib/invoice-engine";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) {
    failures += 1;
  }
}

const TERM = "term-1";
const OTHER_TERM = "term-2";

type S = {
  id: string;
  termId: string | null;
  residency: "ANY" | "DAY" | "BOARDING";
  studentType: "ANY" | "NEW" | "CONTINUING";
};
const structure = (id: string, over: Partial<S> = {}): S => ({
  id,
  termId: null,
  residency: "ANY",
  studentType: "ANY",
  ...over,
});

const dayContinuing = { residency: "DAY" as const, isNew: false };
const boardingNew = { residency: "BOARDING" as const, isNew: true };

console.log("Choosing a fee structure");
check(
  "an all-terms, all-students structure applies to anyone",
  chooseFeeStructure([structure("a")], dayContinuing, TERM)?.id === "a",
);
check(
  "a structure for another term does not apply",
  chooseFeeStructure([structure("a", { termId: OTHER_TERM })], dayContinuing, TERM) === null,
);
check(
  "a boarding structure does not apply to a day student",
  chooseFeeStructure([structure("a", { residency: "BOARDING" })], dayContinuing, TERM) === null,
);
check(
  "a new-student structure does not apply to a continuing one",
  chooseFeeStructure([structure("a", { studentType: "NEW" })], dayContinuing, TERM) === null,
);

// Specificity: the most exactly-targeted structure must win, or a school that
// prices boarders separately would bill them the general rate.
check(
  "a term-specific structure beats an all-terms one",
  chooseFeeStructure([structure("all"), structure("this", { termId: TERM })], dayContinuing, TERM)
    ?.id === "this",
);
check(
  "a residency-specific structure beats a general one",
  chooseFeeStructure(
    [structure("any"), structure("boarding", { residency: "BOARDING" })],
    boardingNew,
    TERM,
  )?.id === "boarding",
);
check(
  "term beats residency when both are on offer",
  chooseFeeStructure(
    [structure("boarding", { residency: "BOARDING" }), structure("term", { termId: TERM })],
    boardingNew,
    TERM,
  )?.id === "term",
);
check(
  "the most specific of all wins",
  chooseFeeStructure(
    [
      structure("general"),
      structure("term", { termId: TERM }),
      structure("exact", { termId: TERM, residency: "BOARDING", studentType: "NEW" }),
    ],
    boardingNew,
    TERM,
  )?.id === "exact",
);

console.log("\nExplaining why nobody could be billed");
check(
  "an unpriced level names the level, not the filters",
  explainNoStructure([], dayContinuing, TERM, "Basic 1").kind === "NO_STRUCTURE_FOR_LEVEL",
);
check(
  "a structure for the wrong term is reported as a term problem",
  explainNoStructure([structure("a", { termId: OTHER_TERM })], dayContinuing, TERM, "Basic 1")
    .kind === "WRONG_TERM",
);
check(
  "a boarders-only structure is reported as a residency problem",
  explainNoStructure([structure("a", { residency: "BOARDING" })], dayContinuing, TERM, "Basic 1")
    .kind === "WRONG_RESIDENCY",
);
check(
  "a new-students-only structure is reported as a student-type problem",
  explainNoStructure([structure("a", { studentType: "NEW" })], dayContinuing, TERM, "Basic 1")
    .kind === "WRONG_STUDENT_TYPE",
);

// The order matters: with two things wrong, naming the narrower one sends the
// bursar to fix a detail while the real gap stays.
check(
  "with both the term and the residency wrong, the term is named first",
  explainNoStructure(
    [structure("a", { termId: OTHER_TERM, residency: "BOARDING" })],
    dayContinuing,
    TERM,
    "Basic 1",
  ).kind === "WRONG_TERM",
);

const residencyReason = explainNoStructure(
  [structure("a", { residency: "BOARDING" })],
  dayContinuing,
  TERM,
  "Basic 1",
);
check(
  "the residency named is the student's, not the structure's",
  residencyReason.kind === "WRONG_RESIDENCY" && residencyReason.residency === "DAY",
  residencyReason.kind === "WRONG_RESIDENCY" ? residencyReason.residency : residencyReason.kind,
);

console.log("\nGrouping the skipped students");
const skipped: SkippedStudent[] = [
  { admissionNo: "ADM/0001", name: "Kuukua Esaawa", reason: { kind: "NO_CLASS" } },
  { admissionNo: "ADM/0002", name: "Kpetigo Seyram", reason: { kind: "NO_CLASS" } },
  {
    admissionNo: "ADM/0003",
    name: "Ama Serwaa",
    reason: { kind: "NO_STRUCTURE_FOR_LEVEL", level: "JHS 2" },
  },
  {
    admissionNo: "ADM/0004",
    name: "Kofi Mensah",
    reason: { kind: "NO_STRUCTURE_FOR_LEVEL", level: "Basic 1" },
  },
];

const groups = groupSkipped(skipped);
check("one group per distinct problem", groups.length === 3, `${groups.length} groups`);
check(
  "two levels missing a structure stay separate, because they are two fixes",
  groups.filter((g) => g.problem.includes("no fee structure")).length === 2,
);
check(
  "the biggest group is listed first",
  groups[0].students.length === 2 && groups[0].problem.includes("not in a class"),
  groups[0].problem,
);
check(
  "every group says what to do, naming a screen",
  groups.every((g) => g.fix.length > 0 && /Students|Fee structure/.test(g.fix)),
);
check(
  "the unpriced level is named in the fix, not just the problem",
  groups.some((g) => g.fix.includes("JHS 2")),
  groups.find((g) => g.problem.includes("JHS 2"))?.fix,
);
check(
  "no student is lost in the grouping",
  groups.reduce((sum, g) => sum + g.students.length, 0) === skipped.length,
);
check(
  "a single student reads as singular",
  groupSkipped([skipped[2]])[0].problem.startsWith("JHS 2"),
  groupSkipped([skipped[2]])[0].problem,
);
check("nothing skipped means nothing to report", groupSkipped([]).length === 0);

/**
 * Lateness, which nothing used to notice.
 *
 * ⚠️ `invoiceStatusFor` returned OVERDUE when the due date had passed, and its
 * only caller is `recalcInvoice` — a payment, a reversal, an edited line. An
 * invoice that simply sat there unpaid was never looked at again, so it stayed
 * ISSUED for ever and the OVERDUE filter on /invoices returned nothing, which
 * the office reads as "nobody is late". Dev held zero OVERDUE rows and 26
 * unpaid invoices all due on one day.
 *
 * The point of every check below is that NOTHING RUNS. The clock moves and the
 * answer changes, with no job, no cron and no touch of the row.
 */
console.log("\nLateness is derived, not stored");

const d = (n: number) => new Prisma.Decimal(n);
const DAY = 86_400_000;
const unpaid = { status: "ISSUED" as const, balance: d(500) };
const yesterday = new Date(Date.now() - DAY);
const tomorrow = new Date(Date.now() + DAY);

check("an unpaid invoice past its due date is late", isOverdue({ ...unpaid, dueDate: yesterday }));
check("one still in date is not", !isOverdue({ ...unpaid, dueDate: tomorrow }));

check(
  "and it goes late on its own, with nothing touching the row",
  !isOverdue({ ...unpaid, dueDate: tomorrow }, new Date(Date.now())) &&
    isOverdue({ ...unpaid, dueDate: tomorrow }, new Date(Date.now() + 2 * DAY)),
  "the same row, read two days apart",
);

check(
  "the status the office SEES changes with it",
  displayStatus({ ...unpaid, dueDate: tomorrow }) === "ISSUED" &&
    displayStatus({ ...unpaid, dueDate: tomorrow }, new Date(Date.now() + 2 * DAY)) === "OVERDUE",
);

check(
  "a settled invoice is never late, however old",
  !isOverdue({ status: "PAID", balance: d(0), dueDate: new Date(0) }),
);
check(
  "a CANCELLED one is never late — the school withdrew the demand",
  !isOverdue({ status: "CANCELLED", balance: d(500), dueDate: new Date(0) }),
);
check(
  "an invoice with no due date is never late",
  !isOverdue({ ...unpaid, dueDate: null }),
  "the school never named a date to miss",
);
check(
  "a part-paid invoice past its date is still late",
  isOverdue({ status: "PARTIALLY_PAID", balance: d(100), dueDate: yesterday }),
);

check(
  "how late, in whole days",
  daysOverdue({ ...unpaid, dueDate: new Date(Date.now() - 3 * DAY) }) === 3,
  String(daysOverdue({ ...unpaid, dueDate: new Date(Date.now() - 3 * DAY) })),
);
check("and null when it is not late", daysOverdue({ ...unpaid, dueDate: tomorrow }) === null);

/**
 * The stored status must record only what an EVENT decided. If this ever
 * returns OVERDUE again, rows start rotting the moment they are written.
 */
check(
  "the STORED status is never OVERDUE",
  (["PAID", "PARTIALLY_PAID", "ISSUED"] as const).includes(
    invoiceStatusFor(d(500), d(0)) as never,
  ) && invoiceStatusFor(d(500), d(0)) === "ISSUED",
  `unpaid writes ${invoiceStatusFor(d(500), d(0))}`,
);
check("paid in full writes PAID", invoiceStatusFor(d(500), d(500)) === "PAID");
check("part paid writes PARTIALLY_PAID", invoiceStatusFor(d(500), d(200)) === "PARTIALLY_PAID");

/**
 * And the FILTER, which is the half a reader actually meets. Deriving lateness
 * correctly is no use if /invoices still looks it up as a stored value: the list
 * would come back empty and say, in effect, that nobody in the school is late.
 */
console.log("\nThe OVERDUE filter asks a question rather than looking one up");

const overdueWhere = statusFilterWhere("OVERDUE") as Record<string, unknown>;
check(
  "it never filters on status = OVERDUE",
  JSON.stringify(overdueWhere).includes('"OVERDUE"') === false,
  JSON.stringify(overdueWhere.status),
);
check("it wants a balance still owing", JSON.stringify(overdueWhere.balance) === '{"gt":0}');
check(
  "and a due date already past",
  overdueWhere.dueDate !== undefined &&
    (overdueWhere.dueDate as { lt?: Date }).lt instanceof Date,
);
check(
  "a cancelled invoice is excluded",
  JSON.stringify(overdueWhere.status) === '{"not":"CANCELLED"}',
);
check(
  "an ordinary status is still a plain lookup",
  JSON.stringify(statusFilterWhere("PAID")) === '{"status":"PAID"}',
);
check(
  "DEBTORS stays balance-based",
  JSON.stringify(statusFilterWhere("DEBTORS")) ===
    '{"balance":{"gt":0},"status":{"not":"CANCELLED"}}',
);
check("no filter means no constraint", JSON.stringify(statusFilterWhere(undefined)) === "{}");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
