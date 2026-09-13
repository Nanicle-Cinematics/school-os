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

console.log("\nOne set of primitives, not thirty copies");

const rawTables = hits(/<table\b/, (path) => OWNS(path, "primitives.tsx"));
check(
  "every list goes through DataTable",
  rawTables.length === 0,
  rawTables.length ? `${rawTables.length} files still hand-roll a <table>` : "no raw tables",
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

console.log("\nSentence case, and one icon set");

/**
 * ⚠️ Two named exceptions, and they are DOCUMENTS.
 *
 * A report card and a fee bill are printed and handed to a parent. Their
 * column headers are capitalised because that is the convention on a Ghanaian
 * terminal report, not because somebody reached for `uppercase` to make a
 * caption look like a caption — and changing the look of a document a school
 * signs and stamps is a different decision from tidying the chrome around it.
 *
 * Listed by name rather than skipped by a pattern, so adding a third is a
 * deliberate act somebody has to write down.
 */
const DOCUMENTS = ["results/report-card.tsx", "invoices/invoice-bill.tsx"];

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
