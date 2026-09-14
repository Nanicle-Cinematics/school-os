/**
 * The redesign's rules, as something that fails rather than as a memory.
 *
 * A systemic pass is only systemic while somebody is looking. Every rule here
 * was agreed once and would otherwise decay the first time a page is added in a
 * hurry — so each one is counted, and the count is allowed to go DOWN and never
 * up.
 *
 *   npm run verify:design   (no database, no dev server)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
  });
}

/** Comments are prose about the rules; they are not breaches of them. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

const files = walk("src/app").map((path) => ({ path, text: code(readFileSync(path, "utf8")) }));

/** Where a rule is allowed to be broken, because the rule is implemented there. */
const OWNS = (path: string, ...owners: string[]) => owners.some((o) => path.endsWith(o));

const hits = (re: RegExp, allow: (path: string) => boolean = () => false) =>
  files.filter((f) => !allow(f.path) && re.test(f.text)).map((f) => f.path.replace("src/app/", ""));

const DOCUMENTS = [
  "results/report-card.tsx",
  "invoices/invoice-bill.tsx",
  // Added deliberately, as the note below asks. A payment receipt is the same
  // animal as the bill: .paper, its own masthead, its own print rules, and it
  // is handed across a counter, signed and stamped. "PAYMENT RECEIPT" is the
  // heading a Ghanaian receipt carries, and the carbon book it replaces shouts
  // it too — this is the convention on the document, not somebody reaching for
  // `uppercase` to make a caption look like a caption.
  "payments/payment-receipt.tsx",
];

console.log("Colour says one thing at a time");

/**
 * ⚠️ The rule this whole pass turns on. Five AREA hues say WHERE you are and
 * belong to the rail and the page-title chip. Four SEVERITIES say what blocks
 * work. A page that paints a stat card or a badge with an area hue makes amber
 * mean both "Finance" and "due soon", and colour stops being information.
 */
const areaOutsideRail = hits(
  /\b(?:bg|text|border)-hue-(?:overview|people|academics|finance|school)-/,
  (path) => OWNS(path, "nav.tsx"),
);
check(
  "no page paints itself with an area hue",
  areaOutsideRail.length === 0,
  areaOutsideRail.join(", ") || "only the rail and the title chip",
);

/**
 * ⚠️ And the stock families are not a second severity palette.
 *
 * `bg-amber-50` with `text-amber-700` was the warning pill, written out by hand
 * in twenty-one places — and written by hand it drifts: the same amber dressed
 * a held report card, a form hint and a decorative border, so the question
 * "does amber always mean needs-attention-soon?" had no answer. Using the
 * tokens is what makes the answer yes.
 *
 * The documents are excepted: a report card's green header band and a cancelled
 * bill's red stamp are PRINT, not chrome.
 */
const stockStatus = hits(
  /\b(?:bg|text|border)-(?:amber|red|green|blue)-[0-9]+\b/,
  (path) => OWNS(path, ...DOCUMENTS),
);
check(
  "status colour comes from the tokens, not from stock Tailwind",
  stockStatus.length === 0,
  stockStatus.length ? stockStatus.join(", ") : "one palette for severity",
);

console.log("\nOne set of primitives, not thirty copies");

/**
 * ⚠️ "Every LIST", and the distinction matters — several `<table>`s in this app
 * are not lists at all, and forcing them through a list wrapper would make them
 * worse. Each exception is named with its reason, so the next person can judge
 * whether a new one belongs here or is somebody avoiding the work.
 *
 *   DOCUMENTS      a report card, a fee bill and a payment receipt are printed
 *                  layouts with their own masthead, their own dark header band
 *                  and their own print rules. They are not chrome.
 *   MARK ENTRY     the sheet and the score grid are input grids: grouped column
 *                  headers, per-column totals, locked states, a checkbox in
 *                  every cell. DataTable renders rows of read-only cells.
 *   MATRIX         the broadsheet is students down and subjects across, sized
 *                  by the data rather than by a fixed column list.
 *   TABULAR FORMS  promotions, imports, level pricing and class assignments
 *                  edit rows in place; the table is the form.
 *   THE CHART      collections-chart carries an `sr-only` table so the bars
 *                  have a readable equivalent. It is an accessibility fallback,
 *                  not a list anybody sees.
 */
const NOT_LISTS = [
  "results/report-card.tsx",
  "invoices/invoice-bill.tsx",
  "assessments/sheet/sheet-form.tsx",
  "assessments/[id]/score-grid.tsx",
  "results/broadsheet/page.tsx",
  "promotions/promotion-form.tsx",
  "promotions/bulk-form.tsx",
  "students/import/import-form.tsx",
  "subjects/[id]/levels-form.tsx",
  "classes/[id]/assignments-form.tsx",
  "dashboard/collections-chart.tsx",
];

const rawTables = hits(/<table\b/, (path) =>
  OWNS(path, "primitives.tsx", ...NOT_LISTS),
);
check(
  "every list goes through DataTable",
  rawTables.length === 0,
  rawTables.length
    ? `${rawTables.length} list(s) still hand-rolled: ${rawTables.join(", ")}`
    : `no raw lists — ${NOT_LISTS.length} named non-lists excepted`,
);

/**
 * ⚠️ Matches on the HOVER, not on the colour. `bg-brand-600` also dresses the
 * little "Current" badges beside a term or a fee structure, and those are
 * markers rather than buttons — flagging them trained the eye to skip this
 * line, which is how a guard stops being read.
 */
const pastedPrimary = hits(/className="[^"]*bg-brand-600[^"]*hover:bg-brand-700[^"]*"/, (path) =>
  OWNS(path, "primitives.tsx", "button-style.ts"),
);
check(
  "the primary button exists once",
  pastedPrimary.length === 0,
  pastedPrimary.length ? `${pastedPrimary.length} files paste the filled style` : "one definition",
);

/**
 * ⚠️ A header must have exactly as many columns as its rows have cells.
 *
 * Found by LOOKING at the console, not by building it: the schools table
 * rendered "School" above the proprietor and "Since" fell off the edge,
 * because the conversion gave it one column more than the row had cells.
 * Twelve tables were out. TypeScript cannot see it — `columns` and the `<td>`s
 * are unrelated as far as the type system is concerned — and a page with a
 * header one place to the left still renders perfectly happily.
 */
console.log("\nEvery header lines up with its cells");

let misaligned = 0;
for (const file of files) {
  if (!/\<DataTable/.test(file.text)) continue;
  for (const decl of file.text.matchAll(/const (COLUMNS(?:_\d+)?): Column\[\] = \[([\s\S]*?)\];/g)) {
    const [, name, body] = decl;
    const columns = (body.match(/\{ label:/g) ?? []).length;
    const use = file.text.indexOf(`columns={${name}}`);
    if (use === -1) continue;
    const chunk = file.text.slice(use, file.text.indexOf("</DataTable>", use));
    const row = /<Row[^>]*>([\s\S]*?)<\/Row>/.exec(chunk);
    const cells = row ? (row[1].match(/<td/g) ?? []).length : 0;
    if (cells && cells !== columns) {
      misaligned += 1;
      console.log(
        `  FAIL ${file.path.replace("src/app/", "")} ${name} — ${columns} columns, ${cells} cells`,
      );
    }
  }
}
check("headers and cells agree", misaligned === 0, misaligned === 0 ? "every table" : "");

console.log("\nSentence case, and one icon set");

/**
 * ⚠️ Three named exceptions, and they are DOCUMENTS.
 *
 * A report card, a fee bill and a payment receipt are printed and handed to a
 * parent. Their
 * column headers are capitalised because that is the convention on a Ghanaian
 * terminal report, not because somebody reached for `uppercase` to make a
 * caption look like a caption — and changing the look of a document a school
 * signs and stamps is a different decision from tidying the chrome around it.
 *
 * Listed by name rather than skipped by a pattern, so adding a third is a
 * deliberate act somebody has to write down.
 */


const shouty = hits(/\buppercase\b/, (path) =>
  OWNS(path, "primitives.tsx", ...DOCUMENTS),
);
check(
  "no ALL CAPS labels",
  shouty.length === 0,
  shouty.length ? `${shouty.length} files still shout` : "sentence case throughout",
);

const handDrawn = hits(/<svg\b/, (path) => OWNS(path, "nav.tsx"));
check(
  "icons come from lucide, not from inline paths",
  handDrawn.length === 0,
  handDrawn.length ? `${handDrawn.length} files draw their own` : "one set",
);

console.log(`\n${failed === 0 ? "every rule holds" : `${failed} rule(s) not yet met`}`);
process.exit(failed === 0 ? 0 : 1);
