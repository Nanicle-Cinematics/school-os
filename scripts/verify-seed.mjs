import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

const school = await prisma.school.findUnique({ where: { slug: "st-mary-demo" } });
const schoolId = school.id;

const inv = await prisma.invoice.aggregate({
  where: { schoolId },
  _sum: { total: true, amountPaid: true, balance: true },
});
const alloc = await prisma.paymentAllocation.aggregate({ where: { schoolId }, _sum: { amount: true } });
const pay = await prisma.payment.aggregate({ where: { schoolId }, _sum: { amount: true } });
const exp = await prisma.expense.aggregate({ where: { schoolId }, _sum: { amount: true } });
const debtors = await prisma.invoice.count({ where: { schoolId, balance: { gt: 0 } } });
const fullyPaid = await prisma.invoice.count({ where: { schoolId, status: "PAID" } });

const billed = Number(inv._sum.total);
const collected = Number(inv._sum.amountPaid);

console.log("Billed (term 1):   GHS", billed.toFixed(2));
console.log("Collected:         GHS", collected.toFixed(2), `(${((collected / billed) * 100).toFixed(1)}%)`);
console.log("Outstanding:       GHS", Number(inv._sum.balance).toFixed(2));
console.log("Expenditure:       GHS", Number(exp._sum.amount).toFixed(2));
console.log("Debtors:          ", debtors, "of 44 invoices |", fullyPaid, "fully paid");
console.log("");
console.log("Integrity checks:");
console.log("  payments == allocations:      ", Number(pay._sum.amount) === Number(alloc._sum.amount));
console.log("  allocations == amountPaid:    ", Number(alloc._sum.amount) === collected);
console.log("  billed - paid == balance:     ", Math.abs(billed - collected - Number(inv._sum.balance)) < 0.01);

const counts = {};
for (const m of ["level", "classGroup", "subject", "levelSubject", "gradeBand", "teachingAssignment",
                 "guardian", "studentGuardian", "enrollment", "feeStructureItem", "invoiceItem",
                 "messageTemplate", "expenseCategory", "numberSequence", "membership"]) {
  counts[m] = await prisma[m].count({ where: { schoolId } });
}
console.log("");
console.log("Row counts:", counts);

await prisma.$disconnect();
