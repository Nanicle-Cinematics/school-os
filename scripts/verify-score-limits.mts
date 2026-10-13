/**
 * A mark may not exceed what its assessment is out of, and who may record one.
 *
 * Pure: no database and no server. The HTTP half (a real form, a real row) is verify:assessment-entry.
 *
 * Two things are pinned here. The RULE (`checkScore`): what is a mark, what is refused, with the edge
 * at the maximum itself. And the SHAPE of the code, read from source with comments stripped (this
 * codebase explains its mistakes at length, and the words would satisfy a search): both server
 * actions and both grids decide with that one function, so a screen cannot accept what the save
 * refuses, and nothing has a private copy of the comparison again.
 *
 * Run: npm run verify:score-limits
 */
import { readFileSync } from "node:fs";
import { checkScore, refusalMessage } from "@/lib/score-limits";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const ok = (raw: string, max: number) => {
  const v = checkScore(raw, max);
  return v.ok ? v.value : "REFUSED";
};
const refused = (raw: string, max: number) => !checkScore(raw, max).ok;

console.log("The rule: out of 10");
check("a mark inside the total is accepted", ok("7", 10) === 7);
check("a decimal mark is accepted", ok("7.5", 10) === 7.5);
check("zero is a mark (it is not blank, and it is not absent)", ok("0", 10) === 0);
check("the total itself is allowed: 10 out of 10", ok("10", 10) === 10);
check("10.00 out of 10 is allowed too", ok("10.00", 10) === 10);
check("one step over is refused", refused("10.01", 10));
check("a whole mark over is refused", refused("11", 10));
check("a mark far over is refused", refused("100", 10));
check("a mark over a total of 100 is refused as well, whatever the total is", refused("100.5", 100) && ok("100", 100) === 100);
check("a total of 1 means 1 is the ceiling", ok("1", 1) === 1 && refused("2", 1));

console.log("\nBlank is not a mark");
check("blank is 'not marked yet' (no value, not refused)", ok("", 10) === null);
check("spaces are blank too", ok("   ", 10) === null);
check("a mark with spaces around it is read as the mark", ok("  7 ", 10) === 7);

console.log("\nWhat is not a mark");
check("a negative is refused", refused("-1", 10));
check("and says why", /below zero/.test((checkScore("-1", 10) as { reason: string }).reason));
check("words are refused", refused("abc", 10) && refused("seven", 10));
check("1e1 is a number to JavaScript and not a mark", refused("1e1", 100));
check("so is 0x5", refused("0x5", 100));
check("so is Infinity", refused("Infinity", 100));
check("a sign is refused", refused("+5", 10));
check("a comma is refused rather than read as something else", refused("7,5", 10));
check("two points are refused", refused("7.5.1", 10));
check("a lone point is refused", refused(".", 10));

console.log("\nWhat the message says");
const reason = (raw: string, max: number) => {
  const v = checkScore(raw, max);
  return v.ok ? "" : v.reason;
};
check("names the mark and the total it is above", /15/.test(reason("15", 10)) && /10/.test(reason("15", 10)), reason("15", 10));
const many = refusalMessage(["A: x", "B: x", "C: x", "D: x", "E: x", "F: x", "G: x"]);
check("a refused save begins by saying nothing was saved", /^Nothing was saved\./.test(many));
check("lists the first five and counts the rest", /A: x; B: x; C: x; D: x; E: x; and 2 more\.$/.test(many), many);
check("one problem is just that one", refusalMessage(["A: x"]) === "Nothing was saved. A: x.");

console.log("\nOne rule, used by all four places");
const files = {
  actions: code("src/lib/assessment-actions.ts"),
  sheetActions: code("src/lib/sheet-actions.ts"),
  grid: code("src/app/(app)/assessments/[id]/score-grid.tsx"),
  sheetForm: code("src/app/(app)/assessments/sheet/sheet-form.tsx"),
};
check("saveScores decides with checkScore", /checkScore\(/.test(files.actions));
check("saveSheet decides with checkScore", /checkScore\(/.test(files.sheetActions));
check("the score grid decides with checkScore", /checkScore\(/.test(files.grid));
check("the mark sheet decides with checkScore", /checkScore\(/.test(files.sheetForm));
check("neither server action keeps its own `parsed > max` any more", !/parsed\s*>\s*max/.test(files.actions) && !/parsed\s*>\s*max/.test(files.sheetActions));
check("nor reads a mark with a bare Number(raw)", !/Number\(raw\)/.test(files.actions) && !/Number\(raw\)/.test(files.sheetActions));
check("a refused save names every problem and writes nothing (refusalMessage, before the transaction)", /refusalMessage\(problems\)/.test(files.actions) && /refusalMessage\(problems\)/.test(files.sheetActions));
check("the grids stop Save while any mark is out of range", /disabled=\{blocked\}/.test(files.grid) && /disabled=\{blocked\}/.test(files.sheetForm));
check("the total a mark is held to is the persisted one in saveScores", /const max = Number\(assessment\.maxScore\)/.test(files.actions));
check("and saveScores cannot change it (no maxScore write there)", !/maxScore:\s*new Prisma\.Decimal\(max\b/.test(files.actions.slice(files.actions.indexOf("export async function saveScores"), files.actions.indexOf("export async function setAssessmentStatus"))));

console.log("\nWho may record an assessment");
const fn = (name: string) => {
  const start = files.actions.indexOf(`export async function ${name}`);
  const next = files.actions.indexOf("export async function", start + 10);
  return files.actions.slice(start, next === -1 ? undefined : next);
};
check("createAssessment: leadership and the IT admin (MARK_ANY_CLASS)", /requireRole\(MARK_ANY_CLASS\)/.test(fn("createAssessment")));
check("saveScores: the same", /requireRole\(MARK_ANY_CLASS\)/.test(fn("saveScores")));
check("setAssessmentStatus stays LEADERSHIP: recording is not signing off", /requireRole\(LEADERSHIP\)/.test(fn("setAssessmentStatus")));
check("deleteAssessment stays LEADERSHIP: it takes every mark with it", /requireRole\(LEADERSHIP\)/.test(fn("deleteAssessment")));
check("the 'may teach this class' bypass is MARK_ANY_CLASS", /canAccess\(auth\.roles, MARK_ANY_CLASS\)/.test(files.actions));
check("the New assessment button follows the same rule", /scope\.canRecord/.test(code("src/app/(app)/assessments/page.tsx")));
const entry = code("src/app/(app)/assessments/[id]/page.tsx");
check("the grid is editable for anyone who may record", /canAccess\(auth\.roles, MARK_ANY_CLASS\)/.test(entry) && /!canRecord/.test(entry));
check("the submit, approve, unlock and delete buttons still need leadership", (entry.match(/&& isLeadership/g) ?? []).length >= 4);
check("an IT admin still cannot change a total on the mark sheet", /const mayChangeTotals = canAccess\(auth\.roles, LEADERSHIP\)/.test(files.sheetActions));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
