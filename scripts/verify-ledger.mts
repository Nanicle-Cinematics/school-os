/**
 * The posting engine's own invariant, proved rather than assumed: every
 * journal entry this database holds balances, and the engine itself refuses
 * to create one that would not.
 *
 * Real reads and a real fixture — postJournalEntry writes to the database, so
 * there is no pure half to this the way invoice-engine's arithmetic has one.
 * Writes a fixture, asserts, and restores, same discipline as
 * verify-finance.mts's forced-red checks.
 *
 *   npm run verify:ledger
 */
import "server-only";
import { prisma, tenantTransaction } from "../src/lib/prisma";
import { withBypass, setTenantContext } from "../src/lib/tenant-context";
import { postJournalEntry, reverseJournalEntry, findJournalEntryForSource } from "../src/lib/ledger-engine";
import { applyDefaultChartOfAccounts } from "../src/lib/ledger-defaults";
import { demoSchool, withOwner } from "./fixture.mjs";

let passed = 0;
const failures: string[] = [];
const ok = (label: string, detail = "") => {
  passed++;
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
};
const bad = (label: string, detail: string) => {
  failures.push(label);
  console.log(`  FAIL ${label} — ${detail}`);
};

const school = await demoSchool();
setTenantContext({ schoolId: school.id, readOnly: false });

console.log("\nThe entry itself");

// applyDefaultChartOfAccounts is idempotent — safe to call against a school
// that already has its chart, and guarantees CASH/AR exist for this fixture
// without assuming the demo seed provisioned one (it does not; seed.ts
// bypasses provisionSchool entirely).
await tenantTransaction(school.id, (tx) => applyDefaultChartOfAccounts(tx, school.id));
const [cash, receivable] = await withBypass(() =>
  Promise.all([
    prisma.ledgerAccount.findUniqueOrThrow({ where: { schoolId_code: { schoolId: school.id, code: "CASH" } } }),
    prisma.ledgerAccount.findUniqueOrThrow({ where: { schoolId_code: { schoolId: school.id, code: "AR" } } }),
  ]),
);

try {
  await tenantTransaction(school.id, (tx) =>
    postJournalEntry(tx, school.id, {
      sourceType: "PAYMENT",
      sourceId: "verify-ledger-unbalanced",
      memo: "should be refused",
      lines: [
        { accountId: cash.id, debit: 100 },
        { accountId: receivable.id, credit: 50 },
      ],
    }),
  );
  bad("an unbalanced entry is refused", "it was accepted");
} catch {
  ok("an unbalanced entry is refused");
}

try {
  await tenantTransaction(school.id, (tx) =>
    postJournalEntry(tx, school.id, {
      sourceType: "PAYMENT",
      sourceId: "verify-ledger-both",
      memo: "should be refused",
      lines: [
        { accountId: cash.id, debit: 100, credit: 100 },
        { accountId: receivable.id, credit: 100 },
      ],
    }),
  );
  bad("a line that is both a debit and a credit is refused", "it was accepted");
} catch {
  ok("a line that is both a debit and a credit is refused");
}

const sourceId = `verify-ledger-${Date.now()}`;
const entry = await tenantTransaction(school.id, (tx) =>
  postJournalEntry(tx, school.id, {
    sourceType: "PAYMENT",
    sourceId,
    memo: "verify-ledger fixture",
    lines: [
      { accountId: cash.id, debit: 250 },
      { accountId: receivable.id, credit: 250 },
    ],
  }),
);
if (!entry) {
  bad("a balanced entry posts", "postJournalEntry returned null");
} else {
  ok("a balanced entry posts", entry.entryNo);

  const found = await tenantTransaction(school.id, (tx) =>
    findJournalEntryForSource(tx, school.id, "PAYMENT", sourceId),
  );
  if (found?.id === entry.id) {
    ok("it can be found again by its source");
  } else {
    bad("it can be found again by its source", `found ${found?.id ?? "nothing"}`);
  }

  const reversal = await tenantTransaction(school.id, (tx) =>
    reverseJournalEntry(tx, school.id, entry.id, { memo: "verify-ledger reversal" }),
  );
  const reversalLines = reversal?.lines ?? [];
  const cashLine = reversalLines.find((l) => l.accountId === cash.id);
  const receivableLine = reversalLines.find((l) => l.accountId === receivable.id);
  if (Number(cashLine?.credit) === 250 && Number(receivableLine?.debit) === 250) {
    ok("reversing it swaps every debit and credit");
  } else {
    bad(
      "reversing it swaps every debit and credit",
      `cash credit ${cashLine?.credit}, receivable debit ${receivableLine?.debit}`,
    );
  }

  // Clean up — this fixture's two entries are the only rows a fresh
  // sourceId could have produced. On the owner connection, because the app
  // role cannot delete from the ledger (see withOwner); the lines go with
  // their entries through the cascade.
  await withOwner((owner) =>
    owner.journalEntry.deleteMany({ where: { schoolId: school.id, sourceId } }),
  );
  console.log("  (fixture entries removed)");
}

console.log("\nEvery journal entry this database holds, across every school");

const lines = await withBypass(() =>
  prisma.journalLine.findMany({ select: { journalEntryId: true, debit: true, credit: true } }),
);
const byEntry = new Map<string, { debit: number; credit: number }>();
for (const line of lines) {
  const totals = byEntry.get(line.journalEntryId) ?? { debit: 0, credit: 0 };
  totals.debit += Number(line.debit);
  totals.credit += Number(line.credit);
  byEntry.set(line.journalEntryId, totals);
}
const unbalanced = [...byEntry.entries()].filter(
  ([, totals]) => Math.abs(totals.debit - totals.credit) > 0.005,
);
if (unbalanced.length === 0) {
  ok(`every journal entry balances`, `${byEntry.size} entries checked`);
} else {
  bad("every journal entry balances", `${unbalanced.length} of ${byEntry.size} do not`);
}

await prisma.$disconnect();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
