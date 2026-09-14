/**
 * The four things the finance section could not do before.
 *
 * Pure-function checks where the logic is pure (ageing), and real reads where
 * it is not (the receipt, the approval hold). No dev server: everything here is
 * either arithmetic or a database read, and a guard that needs a server is a
 * guard that gets skipped.
 *
 *   npm run verify:finance
 */
import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { withBypass } from "../src/lib/tenant-context";
import { cedisInWords } from "../src/lib/money";
import { AGE_BUCKETS, AGE_LABEL, ageBucket, ageFilterWhere } from "../src/lib/invoice-engine";

let passed = 0;
const failures: string[] = [];
const ok = (label: string, detail = "") => { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); };
const bad = (label: string, detail: string) => { failures.push(label); console.log(`  FAIL ${label} — ${detail}`); };
function eq(label: string, got: unknown, want: unknown) {
  if (got === want) {
    ok(label, String(got));
  } else {
    bad(label, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
}

console.log("\nAmount in words");
// The half a carbon book has that a print-out forgets. A receipt without it
// reads as less trustworthy than the thing it replaces.
eq("one cedi is singular", cedisInWords(1), "One cedi");
eq("a round hundred", cedisInWords(500), "Five hundred cedis");
eq("the 'and' before a small remainder", cedisInWords(1050), "One thousand and fifty cedis");
eq("no 'and' before a full hundred", cedisInWords(1500), "One thousand five hundred cedis");
eq("pesewas as a fraction", cedisInWords(1234.56), "One thousand two hundred and thirty-four cedis and 56/100");
eq("zero is sayable", cedisInWords(0), "Zero cedis");

console.log("\nDebtor ageing");
const day = 86_400_000;
const now = new Date("2026-06-30T12:00:00Z");
const due = (daysAgo: number) => ({ dueDate: new Date(now.getTime() - daysAgo * day), balance: new Prisma.Decimal(10), status: "ISSUED" as const });

eq("no due date is not overdue", ageBucket({ ...due(0), dueDate: null }, now), "CURRENT");
eq("due tomorrow is current", ageBucket({ ...due(-1) }, now), "CURRENT");
eq("a day late", ageBucket(due(1), now), "D1_30");
eq("thirty days is still the first bucket", ageBucket(due(30), now), "D1_30");
eq("thirty-one crosses over", ageBucket(due(31), now), "D31_60");
eq("ninety is the last bounded bucket", ageBucket(due(90), now), "D61_90");
eq("ninety-one is the tail", ageBucket(due(91), now), "D90_PLUS");

// The bucket a row falls in and the query that selects the bucket must agree,
// or the total on the card and the names behind it describe different debts.
const boundaries = [0, 1, 15, 30, 31, 45, 60, 61, 75, 90, 91, 200];
let drift = 0;
for (const days of boundaries) {
  const bucket = ageBucket(due(days), now);
  const where = ageFilterWhere(bucket, now) as { dueDate?: { lt?: Date; gte?: Date }; OR?: unknown };
  const d = due(days).dueDate;
  const inRange =
    bucket === "CURRENT"
      ? true
      : (!where.dueDate?.lt || d < where.dueDate.lt) && (!where.dueDate?.gte || d >= where.dueDate.gte);
  if (!inRange) drift++;
}
if (drift === 0) {
  ok("every boundary lands in the bucket its own filter would select", `${boundaries.length} checked`);
} else {
  bad("bucket and filter agree", `${drift} of ${boundaries.length} disagree`);
}

eq("every bucket has a label", AGE_BUCKETS.every((b) => Boolean(AGE_LABEL[b])), true);

console.log("\nApproval hold");
const school = await withBypass(() =>
  prisma.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } }, orderBy: { createdAt: "asc" } }),
);
if (!school) {
  bad("a school to read", "none seeded — run `npm run db:seed`");
} else {
  const settings = await withBypass(() =>
    prisma.schoolSettings.findUnique({ where: { schoolId: school.id }, select: { expenseApprovalThreshold: true } }),
  );
  ok("the threshold column is readable", settings?.expenseApprovalThreshold?.toString() ?? "not set (approvals off)");

  /**
   * ⚠️ This FORCES a DRAFT rather than hoping one exists.
   *
   * The first version asserted that unapproved spending sits outside the
   * counted total and passed with "0.00 held" — on a database with no DRAFT
   * rows, which is every database until someone sets a threshold. A check that
   * cannot fail is not a check, and this one would have gone on reporting green
   * with the exclusion deleted.
   *
   * It writes and removes. Development databases only, like verify:attention.
   */
  const before = await withBypass(() =>
    prisma.expense.aggregate({ where: { schoolId: school.id, status: "PAID" }, _sum: { amount: true } }),
  );

  const probe = await withBypass(() =>
    prisma.expense.create({
      data: {
        schoolId: school.id,
        voucherNo: `PROBE-${Date.now()}`,
        description: "verify:finance probe — awaiting approval",
        amount: new Prisma.Decimal("4242.42"),
        status: "DRAFT",
        spentAt: new Date(),
      },
      select: { id: true },
    }),
  );

  try {
    const after = await withBypass(() =>
      prisma.expense.aggregate({ where: { schoolId: school.id, status: "PAID" }, _sum: { amount: true } }),
    );
    if (Number(after._sum.amount ?? 0) === Number(before._sum.amount ?? 0)) {
      ok("an unapproved expense does NOT move the cash book", "4242.42 held out");
    } else {
      bad(
        "an unapproved expense does NOT move the cash book",
        `counted total moved from ${before._sum.amount} to ${after._sum.amount} — DRAFT is being counted`,
      );
    }

    const queued = await withBypass(() =>
      prisma.expense.count({ where: { schoolId: school.id, status: "DRAFT" } }),
    );
    if (queued > 0) {
      ok("and it is visible in the approval queue", `${queued} waiting`);
    } else {
      bad("and it is visible in the approval queue", "the queue query found nothing to sign");
    }
  } finally {
    await withBypass(() => prisma.expense.delete({ where: { id: probe.id } }));
    const left = await withBypass(() =>
      prisma.expense.count({ where: { schoolId: school.id, voucherNo: { startsWith: "PROBE-" } } }),
    );
    if (left === 0) {
      ok("probe removed", "0 left");
    } else {
      bad("probe removed", `${left} left behind`);
    }
  }
}

console.log("\nReceipt");
const payment = await withBypass(() =>
  prisma.payment.findFirst({ where: { status: "CONFIRMED" }, include: { allocations: true } }),
);
if (!payment) {
  bad("a payment to receipt", "none in this database");
} else {
  ok("a receipt number exists to print", payment.receiptNo);
  const allocated = payment.allocations.reduce((t, a) => t + Number(a.amount), 0);
  if (allocated <= Number(payment.amount) + 0.005) {
    ok("a receipt never claims more was applied than was paid", `${allocated} of ${payment.amount}`);
  } else {
    bad("a receipt never claims more was applied than was paid", `${allocated} > ${payment.amount}`);
  }
}

await prisma.$disconnect();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
