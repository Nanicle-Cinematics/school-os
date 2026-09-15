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
import { setTenantContext, withBypass } from "../src/lib/tenant-context";
import { cedisInWords } from "../src/lib/money";
import { AGE_BUCKETS, AGE_LABEL, ageBucket, ageFilterWhere } from "../src/lib/invoice-engine";
import { planStanding, splitEvenly } from "../src/lib/plan-engine";
import { parseStatement, matchStatement } from "../src/lib/reconcile-engine";
import { budgetTotals } from "../src/lib/budget-data";
import { reportHold } from "../src/lib/report-access";

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

console.log("\nPayment plans");
// A plan's whole purpose is that "in arrears by the bill" and "behind the
// arrangement" are different questions. These assert the difference.
const mar = (d: number) => new Date(2026, 2, d);
const schedule = [
  { sequence: 1, dueDate: mar(1), amount: new Prisma.Decimal(300) },
  { sequence: 2, dueDate: mar(15), amount: new Prisma.Decimal(300) },
  { sequence: 3, dueDate: mar(29), amount: new Prisma.Decimal(300) },
];
const onMar20 = new Date(2026, 2, 20);

const kept = planStanding(schedule, 600, onMar20);
eq("paying the first two by the third's date is on track", kept.onTrack, true);
eq("and owing 300 on the bill is not a shortfall", kept.shortfall, 0);
eq("the next instalment is named", kept.nextDue?.sequence, 3);

const behind = planStanding(schedule, 300, onMar20);
eq("missing the second instalment is behind", behind.onTrack, false);
eq("by exactly the amount that was due", behind.shortfall, 300);

// A tranche due TODAY is not yet late — a bursar ringing at 8am about money
// agreed for close of business is the same mistake in miniature.
eq("a tranche due today is not a shortfall", planStanding(schedule, 0, mar(1)).shortfall, 0);
eq("one due yesterday is", planStanding(schedule, 0, mar(2)).shortfall, 300);

// A schedule that does not sum to the bill lets a parent satisfy it and still owe.
const parts = splitEvenly(1000, 3);
eq("three into a thousand sums back exactly", parts.reduce((t, p) => t.add(p), new Prisma.Decimal(0)).toString(), "1000");
eq("and the rounding lands on the last", parts[2].toString(), "333.34");

console.log("\nBank reconciliation");
// ⚠️ Day first. 05/06 is the 5th of June here and the 6th of May to Date.parse,
// and getting it backwards shifts a line out of the matching window silently.
const parsed = parseStatement(
  "Date,Credit,Reference,Narration\n05/06/2026,450.00,MP2606051234,MTN MoMo\n06/06/2026,1200.00,TRF88213,Transfer",
);
eq("both lines read", parsed.rows.length, 2);
eq("day first, not month first", parsed.rows[0].paidAt.getMonth(), 5);
eq("the amount survives", parsed.rows[0].amount.toString(), "450");

const noHeader = parseStatement("05/06/2026,450.00,MP2606051234");
eq("a headerless paste still reads", noHeader.rows.length, 1);

const junk = parseStatement("Date,Credit\nnot a date,nonsense");
eq("an unreadable line is skipped, not zeroed", junk.rows.length, 0);
eq("and is reported as skipped", junk.skipped.length, 1);

const book = [
  { id: "p1", receiptNo: "RCT-1", paidAt: new Date(2026, 5, 5), amount: 450, reference: "MP2606051234" },
  { id: "p2", receiptNo: "RCT-2", paidAt: new Date(2026, 5, 6), amount: 1200, reference: null },
  { id: "p3", receiptNo: "RCT-3", paidAt: new Date(2026, 5, 6), amount: 99, reference: null },
];
const matched = matchStatement(parsed.rows, book);
eq("a reference matches exactly", matched.matches[0].how, "reference");
eq("and without one, amount and date do", matched.matches[1].how, "amount+date");
eq("a receipt with no line is reported", matched.unmatchedPayments.map((p) => p.receiptNo).join(","), "RCT-3");

// Two identical transfers must claim two receipts, never the same one twice.
const twice = parseStatement("Date,Credit\n05/06/2026,450.00\n05/06/2026,450.00");
const doubled = matchStatement(twice.rows, [
  { id: "a", receiptNo: "A", paidAt: new Date(2026, 5, 5), amount: 450, reference: null },
]);
eq("a payment is claimed at most once", doubled.matches.filter((m) => m.payment).length, 1);
eq("the second identical line is left unmatched", doubled.matches[1].payment, null);

console.log("\nBudget against actual");
// null is not zero, and the screen says different things for each.
const rows = [
  { categoryId: "a", name: "Salaries", budget: 1000, actual: 400, variance: 600, usedPct: 40 },
  { categoryId: "b", name: "Repairs", budget: 200, actual: 250, variance: -50, usedPct: 125 },
  { categoryId: "c", name: "Feeding", budget: null, actual: 80, variance: null, usedPct: null },
];
const totals = budgetTotals(rows);
eq("only budgeted headings can be over", totals.over.map((r) => r.name).join(","), "Repairs");
eq("unbudgeted spending is named separately", totals.unbudgeted.map((r) => r.name).join(","), "Feeding");
eq("remaining ignores the unbudgeted spend", totals.remaining, 550);

/**
 * ⚠️ Everything above this line is pure, and it runs first on purpose.
 *
 * The dev Supabase project pauses when idle. With the database-backed checks in
 * the middle, an unreachable database stopped the run before a single piece of
 * ageing or reconciliation arithmetic had been checked — so the guard was
 * useless exactly when someone was working offline or waiting for the project
 * to wake. Pure logic first, reads last.
 */
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

console.log("\nA kept plan and the report card");
/**
 * ⚠️ The promise of the whole feature, forced rather than hoped for.
 *
 * A family keeping to an arrangement must not have their child's report card
 * withheld — and falling behind that arrangement must remove the protection.
 * Both directions are asserted against a REAL invoice with a REAL plan, because
 * the hold reads the database, not the engine.
 *
 * It writes and restores, like verify:attention. Development databases only.
 */
const owing = await withBypass(() =>
  prisma.invoice.findFirst({
    where: { balance: { gt: 0 }, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, paymentPlan: null },
    select: { id: true, schoolId: true, studentId: true, termId: true, balance: true, amountPaid: true },
  }),
);

if (!owing) {
  bad("an unpaid invoice to plan", "none in this database");
} else {
  // reportHold reads Invoice, which is tenant-scoped — and prisma.ts REFUSES a
  // tenant query with no context rather than quietly answering "nothing here".
  // Same line every other verify script needs.
  setTenantContext({ schoolId: owing.schoolId });

  const held = { blockReportOnArrears: true };
  const before = await reportHold(owing.studentId, owing.termId, held);
  if (before) {
    ok("without a plan the card is held", `${before.invoiceNo}, ${before.balance} owed`);
  } else {
    bad("without a plan the card is held", "nothing held on an unpaid invoice — the arrears rule is not firing");
  }

  // A plan whose due tranches are already covered by what has been paid.
  const paid = Number(owing.amountPaid);
  const plan = await withBypass(() =>
    prisma.paymentPlan.create({
      data: {
        schoolId: owing.schoolId,
        invoiceId: owing.id,
        note: "verify:finance probe",
        instalments: {
          create: [
            { schoolId: owing.schoolId, sequence: 1, dueDate: new Date(Date.now() - 7 * 86_400_000), amount: new Prisma.Decimal(Math.max(0, paid)) },
            { schoolId: owing.schoolId, sequence: 2, dueDate: new Date(Date.now() + 30 * 86_400_000), amount: owing.balance },
          ],
        },
      },
      select: { id: true },
    }),
  );

  try {
    const kept = await reportHold(owing.studentId, owing.termId, held);
    if (kept === null) {
      ok("a family keeping to the plan is NOT held", "card may go home");
    } else {
      bad("a family keeping to the plan is NOT held", `still held for ${kept.balance} — the plan is being ignored`);
    }

    // Now make them behind it: bring the second tranche's date into the past.
    await withBypass(() =>
      prisma.paymentPlanInstalment.updateMany({
        where: { planId: plan.id, sequence: 2 },
        data: { dueDate: new Date(Date.now() - 86_400_000) },
      }),
    );
    const behindNow = await reportHold(owing.studentId, owing.termId, held);
    if (behindNow) {
      ok("falling behind it removes the protection", `held again for ${behindNow.balance}`);
    } else {
      bad("falling behind it removes the protection", "still exempt — a plan nobody keeps would excuse any debt");
    }

    // And a cancelled plan protects nobody.
    await withBypass(() =>
      prisma.paymentPlan.update({ where: { id: plan.id }, data: { cancelledAt: new Date() } }),
    );
    const cancelled = await reportHold(owing.studentId, owing.termId, held);
    if (cancelled) {
      ok("a cancelled plan protects nobody", "held");
    } else {
      bad("a cancelled plan protects nobody", "a withdrawn arrangement is still exempting the debt");
    }
  } finally {
    await withBypass(() => prisma.paymentPlan.delete({ where: { id: plan.id } }));
    const left = await withBypass(() => prisma.paymentPlan.count({ where: { invoiceId: owing.id } }));
    if (left === 0) {
      ok("probe plan removed", "0 left");
    } else {
      bad("probe plan removed", `${left} left behind`);
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
