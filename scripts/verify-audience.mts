/**
 * Checks audience resolution against the seeded school.
 * Run: npm run verify:audience
 *
 * Needs --conditions=react-server so `import "server-only"` resolves to its stub.
 */
import { PrismaClient } from "@prisma/client";
import { resolveAudience } from "@/lib/message-data";
import { runWithTenantContext } from "@/lib/tenant-context";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) {
    failures += 1;
  }
}

const school = await prisma.school.findUniqueOrThrow({ where: { slug: "st-mary-demo" } });

/** The app client is tenant-scoped now, so a script must set the context too. */
function inSchool<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ schoolId: school.id }, async () => await fn());
}

const allParents = await inSchool(() => resolveAudience(school.id, "ALL_PARENTS", {}, school.name));
const debtors = await inSchool(() => resolveAudience(school.id, "DEBTORS", {}, school.name));
const bigDebtors = await inSchool(() => resolveAudience(school.id, "DEBTORS", { minBalance: 1000 }, school.name));
const staff = await inSchool(() => resolveAudience(school.id, "ALL_STAFF", {}, school.name));
const custom = await inSchool(() => resolveAudience(
  school.id,
  "CUSTOM",
  { phones: ["0244000001", "+233244000002", "rubbish", "0244000001"] },
  school.name,
));

const jhs = await prisma.classGroup.findFirstOrThrow({ where: { level: { code: "JHS2" } } });
const oneClass = await inSchool(() =>
  resolveAudience(school.id, "CLASS", { classGroupIds: [jhs.id] }, school.name),
);

console.log("Audience sizes");
console.log(`  all parents ${allParents.length} · debtors ${debtors.length} · ` +
  `debtors>1000 ${bigDebtors.length} · one class ${oneClass.length} · staff ${staff.length}`);

console.log("\nChecks");
check("all parents is non-empty", allParents.length > 0);
check("debtors is a subset of all parents", debtors.length <= allParents.length,
  `${debtors.length} vs ${allParents.length}`);
check("a higher minBalance narrows the list", bigDebtors.length <= debtors.length,
  `${bigDebtors.length} vs ${debtors.length}`);
check("one class is smaller than the whole school", oneClass.length < allParents.length,
  `${oneClass.length} vs ${allParents.length}`);

const phones = allParents.map((r) => r.phone);
check("no duplicate phone numbers", new Set(phones).size === phones.length,
  `${phones.length - new Set(phones).size} duplicates`);
check("every phone is normalised to 233…", phones.every((p) => /^233\d{9}$/.test(p)));

check("custom list dedupes and drops junk", custom.length === 2,
  custom.map((r) => r.phone).join(", "));

check("staff recipients carry a name", staff.every((r) => Boolean(r.context.guardian_name)));
check("parent recipients carry student and balance",
  allParents.every((r) => r.context.student_name !== undefined && r.context.balance !== undefined));

// Every debtor really does owe money.
const owed = await Promise.all(
  debtors.slice(0, 10).map(async (r) => {
    const invoices = await prisma.invoice.findMany({
      where: { studentId: r.studentId!, status: { not: "CANCELLED" } },
      select: { balance: true },
    });
    return invoices.reduce((sum, i) => sum + Number(i.balance), 0);
  }),
);
check("every sampled debtor has a positive balance", owed.every((v) => v > 0),
  owed.map((v) => v.toFixed(0)).join(", "));

check("bigDebtors all owe at least 1000",
  bigDebtors.every((r) => Number(r.context.balance) >= 1000),
  bigDebtors.map((r) => r.context.balance).slice(0, 5).join(", "));


/* ── Arrears are a CHAIN, not a list ──────────────────────────────────────────
 *
 * ⚠️ This section BUILDS a second term's invoice and removes it again, because
 * the bug it guards cannot exist on the seeded school: st-mary-demo is billed
 * for ONE term, and with one invoice per pupil "sum the balances" and "what
 * they actually owe" are the same number. That is exactly why the debtor SMS
 * shipped for months telling parents roughly double what they owed — every
 * check anyone could run agreed with it.
 *
 * So: give one pupil a second invoice that carries the first one's balance
 * forward, the way generateInvoicesForTerm does, and assert the texted figure
 * is what the school is actually owed rather than the same money counted twice.
 */
const chainStudent = await inSchool(() =>
  prisma.invoice.findFirst({
    where: { schoolId: school.id, balance: { gt: 0 }, status: { not: "CANCELLED" } },
    orderBy: { issueDate: "asc" },
    select: { id: true, studentId: true, balance: true, termId: true },
  }),
);

if (!chainStudent) {
  console.log("  --   arrears chain — no unpaid invoice in the seed to build one from");
} else {
  const secondTerm = await inSchool(() =>
    prisma.term.findFirst({
      where: { schoolId: school.id, id: { not: chainStudent.termId } },
      orderBy: { sequence: "asc" },
      select: { id: true },
    }),
  );

  let syntheticId: string | null = null;
  try {
    if (!secondTerm) {
      console.log("  --   arrears chain — the seed has only one term");
    } else {
      const fees = 500;
      const broughtForward = Number(chainStudent.balance);
      const synthetic = await inSchool(() =>
        prisma.invoice.create({
          data: {
            schoolId: school.id,
            studentId: chainStudent.studentId,
            termId: secondTerm.id,
            invoiceNo: `VERIFY-CHAIN-${Date.now()}`,
            issueDate: new Date(),
            subtotal: fees,
            discountTotal: 0,
            broughtForward,
            total: fees + broughtForward,
            amountPaid: 0,
            balance: fees + broughtForward,
            status: "ISSUED",
          },
          select: { id: true },
        }),
      );
      syntheticId = synthetic.id;

      const [invoices, payments] = await inSchool(async () => [
        await prisma.invoice.findMany({
          where: { studentId: chainStudent.studentId, status: { not: "CANCELLED" } },
          select: { total: true, broughtForward: true, balance: true },
        }),
        await prisma.payment.findMany({
          where: { studentId: chainStudent.studentId, reversedAt: null, status: "CONFIRMED" },
          select: { amount: true },
        }),
      ]);

      // Worked out here rather than imported, so this asserts the ANSWER and
      // not merely that the function agrees with itself.
      const charged = invoices.reduce((n, i) => n + Number(i.total) - Number(i.broughtForward), 0);
      const paid = payments.reduce((n, p) => n + Number(p.amount), 0);
      const truly = Math.max(0, charged - paid);
      const naive = invoices.reduce((n, i) => n + Number(i.balance), 0);

      check(
        "the fixture actually chains — the naive sum differs",
        naive > truly + 0.005,
        `naive ${naive.toFixed(2)} vs owed ${truly.toFixed(2)}`,
      );

      const chained = await inSchool(() =>
        resolveAudience(school.id, "DEBTORS", {}, school.name),
      );
      const row = chained.find(
        (r) => (r.context as { admission_no?: string }).admission_no !== undefined &&
          r.studentId === chainStudent.studentId,
      ) ?? chained.find((r) => r.studentId === chainStudent.studentId);

      check(
        "the debtor SMS quotes what is owed, not the sum of balances",
        row !== undefined && Math.abs(Number(row.context.balance) - truly) < 0.01,
        row
          ? `texted ${row.context.balance}, owed ${truly.toFixed(2)}, naive sum ${naive.toFixed(2)}`
          : "that pupil did not appear in the debtor audience at all",
      );
    }
  } finally {
    if (syntheticId) {
      await inSchool(() => prisma.invoice.delete({ where: { id: syntheticId! } }));
    }
  }
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
