/**
 * Arrears carried into the next invoice must FOLLOW the old invoice, not freeze.
 *
 * Payments clear the oldest invoice first. Before syncCarriedForward, the newer
 * invoice kept the "brought forward" figure it was issued with, so a family who
 * paid everything they owed still saw a balance on the current term — which held
 * report cards, inflated the debtor list and overstated the dashboard.
 *
 * No database: an in-memory stand-in for the three Prisma calls the engine makes.
 * Run: npm run verify:carry-forward
 */
import { Prisma } from "@prisma/client";
import { recalcInvoice, syncCarriedForward } from "@/lib/invoice-engine";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const D = (n: number | string) => new Prisma.Decimal(n);

type Inv = {
  id: string;
  studentId: string;
  status: "ISSUED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
  broughtForward: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  balance: Prisma.Decimal;
  items: { amount: Prisma.Decimal; discount: Prisma.Decimal }[];
  allocations: { amount: Prisma.Decimal }[];
  term: { sequence: number; academicYear: { startDate: Date } };
};

const store = new Map<string, Inv>();
function make(id: string, year: number, sequence: number, fees: number, bf = 0): Inv {
  const inv: Inv = {
    id,
    studentId: "s1",
    status: "ISSUED",
    broughtForward: D(bf),
    subtotal: D(fees),
    total: D(fees + bf),
    amountPaid: D(0),
    balance: D(fees + bf),
    items: [{ amount: D(fees), discount: D(0) }],
    allocations: [],
    term: { sequence, academicYear: { startDate: new Date(year, 8, 1) } },
  };
  store.set(id, inv);
  return inv;
}

// The three calls the engine makes, over the map above.
const tx = {
  invoice: {
    findMany: async ({ where }: { where: { studentId: string; status?: { not: string } } }) =>
      [...store.values()].filter(
        (i) => i.studentId === where.studentId && (!where.status || i.status !== where.status.not),
      ),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => store.get(where.id)!,
    update: async ({ where, data }: { where: { id: string }; data: Partial<Inv> }) => {
      Object.assign(store.get(where.id)!, data);
      return store.get(where.id)!;
    },
  },
} as never;

const pay = async (id: string, amount: number) => {
  store.get(id)!.allocations.push({ amount: D(amount) });
  await recalcInvoice(tx, id);
  await syncCarriedForward(tx, "s1");
};

// Term 1: 1,000 fees, 500 paid → 500 owing. Term 2: 1,000 fees + 500 brought forward.
const a = make("A", 2026, 1, 1000);
a.allocations.push({ amount: D(500) });
await recalcInvoice(tx, "A");
const b = make("B", 2026, 2, 1000, 500);

console.log("Paying arrears");
check("setup: term 1 owes 500", a.balance.equals(500));
check("setup: term 2 shows 1,500", b.balance.equals(1500));

await pay("A", 500);
check("old invoice is cleared", a.balance.equals(0) && a.status === "PAID");
check("the arrears stop being carried", b.broughtForward.equals(0), `bf=${b.broughtForward}`);
check("term 2 now owes only its own 1,000", b.balance.equals(1000), `balance=${b.balance}`);

await pay("B", 1000);
check("paying the rest settles term 2 completely", b.balance.equals(0) && b.status === "PAID");

console.log("Reversal puts it back");
a.allocations.pop();
await recalcInvoice(tx, "A");
await syncCarriedForward(tx, "s1");
check("the reversed 500 is owed again on term 1", a.balance.equals(500));
check("and carried into term 2", b.broughtForward.equals(500), `bf=${b.broughtForward}`);
check("term 2 shows 500 owing, not stale", b.balance.equals(500), `balance=${b.balance}`);

console.log("A cancelled invoice is not carried");
a.status = "CANCELLED";
await syncCarriedForward(tx, "s1");
check(
  "term 2 drops the cancelled invoice's balance (its own 1,000 is fully paid)",
  b.broughtForward.equals(0) && b.balance.equals(0) && b.status === "PAID",
  `bf=${b.broughtForward}, balance=${b.balance}`,
);

console.log("Across academic years");
a.status = "PARTIALLY_PAID";
await recalcInvoice(tx, "A");
await syncCarriedForward(tx, "s1");
const c = make("C", 2027, 1, 800, 0);
await syncCarriedForward(tx, "s1");
check(
  "term 1 of the next year carries the last term of this one",
  c.broughtForward.equals(b.balance),
  `bf=${c.broughtForward}, previous balance=${b.balance}`,
);
check("and its balance includes it", c.balance.equals(D(800).add(b.balance)));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
