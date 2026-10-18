/**
 * A mark-sheet save writes only the cells that changed.
 *
 *   npm run verify:score-writes
 *
 * The sheet posts every cell it shows, about three hundred for a class of fifty, and each used to be a delete or an
 * upsert inside one transaction holding one of the app role's four connections. `planScoreWrites` reads what is
 * stored and says what must actually be written. Pure: no database. It is the part that could be wrong in a way
 * that LOSES a mark (a changed cell skipped) or keeps one that should have gone (a cleared cell left behind), so
 * each of those is a case here, and the last check runs a whole sheet and asks for the one cell that changed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";
import { planScoreWrites, sameFields, sameValue, type SheetCell, type StoredScore } from "@/lib/row-diff";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const D = (value: string) => new Prisma.Decimal(value);
const cell = (a: string, s: string, rawScore: number | null, isAbsent = false): SheetCell => ({ assessmentId: a, studentId: s, rawScore, isAbsent });
const row = (id: string, a: string, s: string, rawScore: string | null, isAbsent = false): StoredScore => ({ id, assessmentId: a, studentId: s, rawScore: rawScore === null ? null : D(rawScore), isAbsent });
const shape = (p: ReturnType<typeof planScoreWrites>) => `${p.creates.length}c ${p.updates.length}u ${p.deletes.length}d ${p.unchanged}=`;

console.log("One cell at a time");
{
  const same = planScoreWrites([cell("a", "s", 7)], [row("1", "a", "s", "7.00")]);
  check("a mark already stored is not written", same.creates.length + same.updates.length + same.deletes.length === 0 && same.unchanged === 1, shape(same));
  const changed = planScoreWrites([cell("a", "s", 8)], [row("1", "a", "s", "7.00")]);
  check("a changed mark is an update of THAT row", changed.updates.length === 1 && changed.updates[0]!.id === "1" && changed.updates[0]!.cell.rawScore === 8, shape(changed));
  const fresh = planScoreWrites([cell("a", "s", 5)], []);
  check("a mark with nothing stored is a create", fresh.creates.length === 1 && fresh.updates.length === 0, shape(fresh));
  const cleared = planScoreWrites([cell("a", "s", null)], [row("1", "a", "s", "7.00")]);
  check("a cell cleared on the sheet deletes the stored row (or it would come back)", cleared.deletes.length === 1 && cleared.deletes[0] === "1", shape(cleared));
  const blank = planScoreWrites([cell("a", "s", null)], []);
  check("a blank cell with nothing stored writes nothing at all", blank.deletes.length + blank.creates.length + blank.updates.length === 0 && blank.unchanged === 1, shape(blank));
}

console.log("\nAbsences are rows too");
{
  check("an absence already stored is left alone", planScoreWrites([cell("a", "s", null, true)], [row("1", "a", "s", null, true)]).unchanged === 1);
  check("a new absence is a create", planScoreWrites([cell("a", "s", null, true)], []).creates.length === 1);
  check("a mark becoming an absence is an update, not a skip", planScoreWrites([cell("a", "s", null, true)], [row("1", "a", "s", "7.00")]).updates.length === 1);
  check("an absence becoming a mark is an update, not a skip", planScoreWrites([cell("a", "s", 6)], [row("1", "a", "s", null, true)]).updates.length === 1);
  check("an absence cleared to blank deletes the row", planScoreWrites([cell("a", "s", null)], [row("1", "a", "s", null, true)]).deletes.length === 1);
}

console.log("\nValues compare by value, and fail towards writing");
{
  check("7.5 equals 7.50 as stored", planScoreWrites([cell("a", "s", 7.5)], [row("1", "a", "s", "7.50")]).unchanged === 1);
  check("7.51 does not equal 7.50", planScoreWrites([cell("a", "s", 7.51)], [row("1", "a", "s", "7.50")]).updates.length === 1);
  check("zero is a mark, not a blank", planScoreWrites([cell("a", "s", 0)], [row("1", "a", "s", "5.00")]).updates.length === 1 && planScoreWrites([cell("a", "s", 0)], []).creates.length === 1);
  check("null and undefined are the same nothing", sameValue(null, undefined) && sameValue(undefined, null) && !sameValue(null, 0));
  check("a decimal equals the number or the string with the same value", sameValue(D("1.50"), 1.5) && sameValue(D("1.5"), "1.50") && !sameValue(D("1.5"), 1.6));
  const left = { a: 1, b: 2 };
  check("sameFields is false when ANY listed column differs, true only when all agree", sameFields({ a: 1, b: D("2.0") }, { a: 1, b: 2 }, ["a", "b"] as const) && !sameFields(left, { a: 1, b: 3 }, ["a", "b"] as const) && sameFields(left, { a: 1, b: 99 }, ["a"] as const));
}

console.log("\nA whole sheet");
{
  // 50 pupils x 6 columns, all stored, as a teacher re-saving a finished sheet would post them.
  const cells: SheetCell[] = [];
  const stored: StoredScore[] = [];
  for (let s = 0; s < 50; s += 1) {
    for (let a = 0; a < 6; a += 1) {
      const value = (s * 7 + a * 3) % 10;
      cells.push(cell(`a${a}`, `s${s}`, value));
      stored.push(row(`r${s}-${a}`, `a${a}`, `s${s}`, `${value}.00`));
    }
  }
  const untouched = planScoreWrites(cells, stored);
  check("three hundred cells re-saved untouched: nothing is written", untouched.unchanged === 300 && untouched.creates.length + untouched.updates.length + untouched.deletes.length === 0, shape(untouched));

  const edited = cells.map((c) => ({ ...c }));
  edited[123]!.rawScore = 9.5;
  const one = planScoreWrites(edited, stored);
  check("one cell edited among three hundred: exactly that one is written", one.updates.length === 1 && one.updates[0]!.id === "r20-3" && one.unchanged === 299, shape(one));

  const mixed = cells.map((c) => ({ ...c }));
  mixed[0]!.rawScore = null; // cleared; its stored row exists, so the row must go
  mixed[1]!.rawScore = 9.9; // changed
  const withoutThird = stored.filter((r) => r.id !== "r0-2"); // cell 2 has a mark and no stored row: a create
  const fresher = planScoreWrites(mixed, withoutThird);
  check("a mix of cleared, changed and new is planned correctly", fresher.deletes.length === 1 && fresher.deletes[0] === "r0-0" && fresher.updates.length === 1 && fresher.updates[0]!.id === "r0-1" && fresher.creates.length === 1 && fresher.unchanged === 297, shape(fresher));
}

console.log("\nWiring");
{
  const code = readFileSync(resolve(import.meta.dirname, "../src/lib/sheet-actions.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  check("saveSheet plans its writes from what is stored", /planScoreWrites\(cells, stored\)/.test(code));
  check("and no longer upserts or deletes inside a loop over every cell", !/for \(const cell of cells\) \{[\s\S]{0,400}tx\.score\.(upsert|deleteMany)/.test(code));
  check("a create that loses a race is settled by upsert, so the later write still wins", /made\.count < plan\.creates\.length/.test(code));
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
