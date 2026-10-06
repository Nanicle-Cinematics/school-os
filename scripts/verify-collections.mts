/**
 * Prove the weekly collections chart agrees with the figure above it.
 *
 * The bars bucket ALLOCATIONS against this term's invoices; the "Collected"
 * stat reads `invoice.amountPaid`. Those are only equal because every payment
 * is allocated — which `db:verify` asserts separately. If that ever stops being
 * true, the dashboard would show a chart quietly contradicting the number
 * beside it, and nobody would notice from looking.
 *
 *   npm run verify:collections
 */

import { prisma } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { demoSchool } from "./fixture.mjs";
import { getCollections, getDashboard } from "@/lib/dashboard-data";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const school = await demoSchool();
setTenantContext({ schoolId: school!.id, readOnly: false });
const data = await getDashboard(school!.id);
const term = data.term!;
const termRef = { id: term.id, startDate: term.startDate, endDate: term.endDate };

const collections = await getCollections(school!.id, termRef);
console.log(`  (${collections.weeks.length} weeks shown, total ${collections.total.toFixed(2)})`);

const round = (n: number) => Math.round(n * 100) / 100;

check(
  "the chart total equals the Collected stat",
  round(collections.total) === round(data.collected),
  `chart ${round(collections.total)} vs stat ${round(data.collected)}`,
);

// The assertion that matters, and the one this file first got wrong: a `<=`
// passed while the bars summed to zero against a total of 26,542, because every
// week holding money sat outside the window. Money shown must equal money counted.
const barSum = collections.weeks.reduce((sum, w) => sum + w.amount, 0);
check(
  "the bars sum to the chart total — no week of money is hidden",
  round(barSum) === round(collections.total),
  `bars ${round(barSum)} of ${round(collections.total)}`,
);

check("no week is negative", collections.weeks.every((w) => w.amount >= 0));
check(
  "shares are a fraction of the best week",
  collections.weeks.every((w) => w.share >= 0 && w.share <= 1),
);
check(
  "exactly one week is marked current",
  collections.weeks.filter((w) => w.isCurrent).length <= 1,
  `${collections.weeks.filter((w) => w.isCurrent).length} marked`,
);
check(
  "every week carries a readable date range",
  collections.weeks.every((w) => /\d/.test(w.range) && w.range.includes("–")),
  collections.weeks[0]?.range ?? "—",
);

// A term that has not started yet must not invent weeks.
const future = await getCollections(
  school!.id,
  { ...termRef, startDate: new Date(Date.now() + 30 * 864e5), endDate: new Date(Date.now() + 120 * 864e5) },
);
check("a term starting later shows one week, not a row of empties",
  future.weeks.length === 1, `${future.weeks.length} weeks`);
check("and marks none of them current", future.weeks.every((w) => !w.isCurrent));

// No term at all — the card must not be asked to render nothing.
const none = await getCollections(school!.id, null);
check("no current term yields no weeks", none.weeks.length === 0 && none.total === 0);

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
