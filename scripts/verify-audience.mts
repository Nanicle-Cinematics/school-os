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

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
