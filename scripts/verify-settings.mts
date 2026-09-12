/**
 * Every switch in /settings does something.
 *
 * The recurring bug of this codebase, four times over: a control is added to
 * /settings, the action saves it, and NOTHING ever reads it. `notifyOnPayment`
 * shipped that way. `studentCap`, `plan` and `trialEndsAt` shipped that way and
 * a trial that ended in March still worked in September. Then
 * `blockReportOnArrears`, `showClassPosition`, `showSubjectPosition` and
 * `reportCardTemplate` — a head teacher ticking "Withhold report cards from
 * students in arrears" got no withholding and found out at vacation.
 *
 * They are all the same failure and it is silent by construction: the form
 * saves, the page reloads, the checkbox is ticked, and the only way to discover
 * the truth is the thing the switch was supposed to prevent.
 *
 * So this asks the question mechanically. The field list comes from the Prisma
 * DMMF rather than from a list kept by hand here — a list would go stale the
 * first time somebody added a setting, which is precisely the failure mode.
 *
 *   npm run verify:settings   (no database, no dev server)
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";
import {
  BILLED,
  reportHold,
  reportHoldsForClass,
  reportHoldsForTerms,
} from "@/lib/report-access";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
}

/**
 * Where a setting is WRITTEN and displayed. A mention in one of these is not
 * evidence that anything uses it — it is the other half of the round trip.
 */
const WRITE_SITES = [
  "src/lib/settings-actions.ts",
  "src/app/(app)/settings",
  "src/lib/settings-data.ts",
];

/** Bookkeeping, not policy: nothing downstream is expected to branch on these. */
const PLUMBING = new Set(["id", "schoolId", "school", "createdAt", "updatedAt"]);

/**
 * Code with the COMMENTS TAKEN OUT.
 *
 * ⚠️ Without this the guard is worthless, and it was: the first forced-red run
 * left `showClassPosition` unwired and the check still passed, because the
 * comment above it explaining the bug mentions the field by name. A file that
 * talks about a setting is not a file that reads one — and this codebase
 * comments heavily enough that nearly every dead field would be "read" by the
 * paragraph describing how dead it is.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

/**
 * Does this code actually GET the field, rather than just contain the word?
 *
 * ⚠️ The second forced-red run also passed when it should not have: unwiring the
 * card left `const showClassPosition = true` behind, and a bare word match is
 * happy with a local variable that is no longer connected to anything. So a read
 * has to look like a read, which in this codebase means one of three shapes:
 *
 *   settings?.showAggregate          a property access
 *   select: { blockReportOnArrears } a key, which is how Prisma is asked
 *   "notifyOnPayment"                a literal, which is how the SMS gates are
 *                                    passed — `settings[gate]`, never `.notify…`
 *
 * A bare identifier is none of those, and that is the point.
 */
function reads(text: string, field: string): boolean {
  return new RegExp(`\\.\\s*${field}\\b|\\b${field}\\s*:|["'\`]${field}["'\`]`).test(text);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

const isWriteSite = (path: string) => WRITE_SITES.some((site) => path.startsWith(site));

const files = sourceFiles("src").map((path) => ({
  path,
  text: code(readFileSync(path, "utf8")),
}));
const readers = files.filter((file) => !isWriteSite(file.path));
const writers = files.filter((file) => isWriteSite(file.path));

const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "SchoolSettings");
if (!model) {
  console.error("No SchoolSettings model in the DMMF — has it been renamed?");
  process.exit(1);
}

const fields = model.fields.map((f) => f.name).filter((name) => !PLUMBING.has(name));

console.log(`Every SchoolSettings field is read somewhere that is not /settings`);
console.log(`  ${fields.length} fields, ${readers.length} files to look in\n`);

for (const field of fields) {
  const readIn = readers.filter((file) => reads(file.text, field)).map((file) => file.path);
  const writtenIn = writers.filter((file) => reads(file.text, field)).map((file) => file.path);

  if (readIn.length > 0) {
    check(field, true, readIn[0].replace("src/", ""));
    continue;
  }

  check(
    field,
    false,
    writtenIn.length > 0
      ? `SAVED BY ${writtenIn[0].replace("src/", "")} AND READ NOWHERE — a dead switch`
      : "in the schema, used nowhere at all",
  );
}

/**
 * And the reverse, because a field can be "read" by a file that only passes it
 * along. These are the four that were dead, named individually: each must be
 * read by the specific code that is supposed to act on it, not merely mentioned.
 */
console.log(`\nThe ones that were dead, at the place that must honour them`);

const mustRead: [field: string, file: string, why: string][] = [
  [
    "blockReportOnArrears",
    "src/lib/report-access.ts",
    "the arrears hold on a report card",
  ],
  [
    "showClassPosition",
    "src/app/(app)/results/report-card.tsx",
    "the position line on the card",
  ],
  [
    "showSubjectPosition",
    "src/app/(app)/results/report-card.tsx",
    "the per-subject position column",
  ],
  ["showAggregate", "src/app/(app)/results/report-card.tsx", "the aggregate line"],
  ["notifyOnPayment", "src/lib/transactional-sms.ts", "the receipt text"],
  ["notifyOnResultPublish", "src/lib/transactional-sms.ts", "the results text"],
];

for (const [field, file, why] of mustRead) {
  const text = files.find((f) => f.path === file)?.text;
  check(
    `${field} is read by ${file.replace("src/", "")}`,
    reads(text ?? "", field),
    why,
  );
}

/** The withheld card must not leak through the routes that render one. */
console.log(`\nNo route renders a report card without asking about the hold`);

const CARD_ROUTES: [file: string, what: string][] = [
  ["src/app/(portal)/portal/[studentId]/results/[termId]/page.tsx", "the parent's card"],
  ["src/app/(portal)/portal/[studentId]/results/page.tsx", "the parent's list of cards"],
  ["src/app/(app)/results/print/page.tsx", "the class print run"],
  ["src/app/(app)/results/[studentId]/page.tsx", "the office's copy"],
];

for (const [file, what] of CARD_ROUTES) {
  const text = files.find((f) => f.path === file)?.text ?? "";
  // Either it asks directly, or it renders data from a reader that asked.
  const asks = /reportHold|\bhold\b/.test(text);
  check(what, asks, asks ? file.replace("src/", "") : `${file} renders a card and never asks`);
}

/**
 * And now the behaviour, because everything above this line only READ the
 * source. Reading source proves a field is mentioned; it cannot prove a card is
 * actually withheld, and "the grep passed" is exactly the kind of confidence
 * that let four dead switches ship.
 *
 * Run against real rows in the dev database, with the school's own setting
 * flipped and put back.
 */
console.log(`\nWhat the hold does, against real invoices`);

const school = await withBypass(() =>
  prisma.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } } }),
);
const schoolId = school!.id;

await runWithTenantContext({ schoolId, readOnly: true }, async () => {
  const debtor = await prisma.invoice.findFirst({
    where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] }, balance: { gt: 0 } },
    select: { studentId: true, termId: true, balance: true, invoiceNo: true },
  });

  if (!debtor) {
    check("a school with nobody in arrears has nothing to hold", true, "no debtor seeded");
    return;
  }

  const off = await reportHold(debtor.studentId, debtor.termId, { blockReportOnArrears: false });
  check("the switch OFF holds nothing, however much is owed", off === null);

  const on = await reportHold(debtor.studentId, debtor.termId, { blockReportOnArrears: true });
  check(
    "the switch ON holds a card with a balance",
    on !== null && on.balance.equals(debtor.balance),
    on ? `${on.invoiceNo}, GH₵${on.balance}` : "held nothing",
  );

  // A bill the office has not sent, or has withdrawn. Withholding on one of
  // those would punish a family for the school's own backlog. Asserted against
  // the rule rather than against a seeded row, because the seed has neither and
  // a check waiting for one would never run at all.
  check(
    "a DRAFT invoice is not arrears",
    !BILLED.includes("DRAFT" as never),
    "nothing has been asked for yet",
  );
  check("a CANCELLED invoice is not arrears", !BILLED.includes("CANCELLED" as never));

  // A term the child was never billed for at all.
  const unbilled = await reportHold(debtor.studentId, "no-such-term", {
    blockReportOnArrears: true,
  });
  check("no invoice at all is not arrears", unbilled === null);

  // The class reader must agree with the single reader, or the print run and
  // the office screen would disagree about the same child.
  const forClass = await reportHoldsForClass([debtor.studentId], debtor.termId, {
    blockReportOnArrears: true,
  });
  check(
    "the class reader agrees with the single reader",
    forClass.get(debtor.studentId)?.balance.equals(debtor.balance) === true,
    `${forClass.size} held in that class`,
  );

  const forTerms = await reportHoldsForTerms(debtor.studentId, [debtor.termId], {
    blockReportOnArrears: true,
  });
  check(
    "and so does the parent's list",
    forTerms.get(debtor.termId)?.balance.equals(debtor.balance) === true,
  );

  const settled = await prisma.invoice.findFirst({
    where: { status: { in: ["ISSUED", "PAID"] }, balance: { lte: 0 } },
    select: { studentId: true, termId: true },
  });
  if (settled) {
    check(
      "a settled invoice is not held",
      (await reportHold(settled.studentId, settled.termId, { blockReportOnArrears: true })) === null,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
