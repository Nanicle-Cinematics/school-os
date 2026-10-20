/**
 * No new whole-table relation counts over the big tables.
 *
 *   npm run verify:wide-counts
 *
 * Prisma's relation count, `_count: { select: { scores: true } }`, joins to `SELECT parentId, COUNT(*) FROM child
 * GROUP BY parentId` over the WHOLE child table, across every school, and narrows it afterwards. On a database
 * holding ten schools that was about 190 ms for the score count on the dashboard, and it grows with every school
 * and every year. The hot ones now use `scoped-counts.ts`; this stops the pattern coming back.
 *
 * It reads the Prisma schema (never a list kept by hand, which would go stale exactly when it mattered) for every
 * relation that points at a table that grows without bound, finds every `_count` select in `src`, and fails on a
 * use that is not in the list below. The list is the sites that REMAIN: each has a reason, and a site that has
 * been fixed must be taken off it (a stale entry fails too), so the list can only shrink.
 *
 * Source only: no database, no server.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Prisma } from "@prisma/client";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** Tables that grow with every pupil, term and payment, so a whole-table aggregate over them gets slower for everyone. */
const BIG = new Set(["Score", "SubjectResult", "TermResult", "Payment", "PaymentAllocation", "Invoice", "InvoiceItem", "JournalLine", "JournalEntry", "AttendanceEntry", "AttendanceDay", "Message"]);

const models = Prisma.dmmf.datamodel.models;
/** relation field name -> the big models it can point at (a name like `scores` is on Assessment and MockExam alike). */
const bigRelations = new Map<string, string[]>();
for (const model of models) {
  for (const field of model.fields) {
    if (field.kind === "object" && field.isList && BIG.has(field.type)) {
      bigRelations.set(field.name, [...(bigRelations.get(field.name) ?? []), `${model.name}.${field.name} -> ${field.type}`]);
    }
  }
}

const root = resolve(import.meta.dirname, "..");
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

type Use = { file: string; key: string };
const uses: Use[] = [];
for (const path of walk(join(root, "src"))) {
  const code = strip(readFileSync(path, "utf8"));
  for (const match of code.matchAll(/_count:\s*\{\s*select:\s*\{([^}]*)\}/g)) {
    for (const key of match[1]!.split(",").map((part) => part.split(":")[0]!.trim()).filter(Boolean)) {
      if (bigRelations.has(key)) uses.push({ file: path.slice(root.length + 1), key });
    }
  }
}

/**
 * The remaining sites, each with why it is tolerated for now. Taking one off means rewriting it with a scoped count
 * (or an existence check), and this list is what says which are left.
 */
const REMAINING: { file: string; key: string; why: string }[] = [
  { file: "src/lib/guardian-data.ts", key: "payments", why: "one guardian's page, office only; payments are not indexed by guardian" },
  { file: "src/lib/guardian-data.ts", key: "messages", why: "one guardian's page, office only" },
  { file: "src/lib/settings-data.ts", key: "subjectResults", why: "Settings, a handful of grading scales; SubjectResult has no index on the scale" },
  { file: "src/lib/grading-data.ts", key: "subjectResults", why: "Settings > Grading, same read" },
  { file: "src/lib/subject-data.ts", key: "subjectResults", why: "one subject's page, office only; SubjectResult has no index on the subject" },
  { file: "src/lib/staff-data.ts", key: "enteredScores", why: "one staff member's page; Score has no index on who entered it" },
  { file: "src/lib/billcode-data.ts", key: "invoices", why: "Settings > Bill codes, a handful of rows; Invoice has no index on the bill code" },
  { file: "src/lib/billcode-actions.ts", key: "invoices", why: "a delete guard on a click, not a page load" },
  { file: "src/lib/assessment-actions.ts", key: "scores", why: "a delete guard on a click, not a page load" },
  { file: "src/lib/fee-actions.ts", key: "invoiceItems", why: "a delete guard on a click; InvoiceItem is now indexed by fee item" },
  { file: "src/lib/ledger-actions.ts", key: "journalLines", why: "a delete guard on a click; JournalLine is indexed by account" },
  { file: "src/lib/mock-data.ts", key: "scores", why: "MockScore, one sitting, a few thousand rows at most (the name matches Score too)" },
];

console.log("The schema says which relations point at a big table");
check("it found them (otherwise this scan is looking at nothing)", bigRelations.size > 5, `${bigRelations.size}`);
check("`scores` and `invoiceItems` are among them", bigRelations.has("scores") && bigRelations.has("invoiceItems"));

console.log("\nEvery whole-table relation count in src is known");
const known = (use: Use) => REMAINING.some((entry) => entry.file === use.file && entry.key === use.key);
const strangers = uses.filter((use) => !known(use));
check(`${uses.length} found, and every one is on the remaining list`, strangers.length === 0, strangers.map((u) => `${u.file} (${u.key})`).join(", ") + " — use scoped-counts.ts, or add it to REMAINING with a reason");

console.log("\nThe list only shrinks");
const stale = REMAINING.filter((entry) => !uses.some((use) => use.file === entry.file && use.key === entry.key));
check("every entry on it still exists in the source", stale.length === 0, stale.map((e) => `${e.file} (${e.key})`).join(", ") + " — it has been fixed; take it off the list");
check("and none of the four fixed pages is back on it", !REMAINING.some((e) => ["src/lib/dashboard-data.ts", "src/lib/assessment-data.ts", "src/lib/fee-data.ts", "src/lib/ledger-data.ts"].includes(e.file)));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
