/**
 * The advance bill (next term's bill, printed at the end of this one): what the family still owes, and
 * which level the child is billed at.
 *
 * Pure: no database and no server. The two rules live in `src/lib/proforma.ts`; the page that prints
 * the bill reads them through `getProformaForTerm`, which this also checks is the only caller.
 *
 * Why these cases: the first advance bill looked for the previous term INSIDE the same academic year,
 * so the bill printed at the end of the third term, the one that matters most, found no previous term
 * and quoted no arrears. And it priced from the class a child sits in today, which at the end of the
 * year is the class they are LEAVING.
 *
 * Run: npm run verify:proforma
 */
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { arrearsBefore, isEarlier, levelForNextTerm, type EarlierInvoice } from "@/lib/proforma";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const D = (n: number | string) => new Prisma.Decimal(n);

const Y25 = new Date(2025, 8, 1);
const Y26 = new Date(2026, 8, 1);
const inv = (studentId: string, name: "FIRST" | "SECOND" | "THIRD", sequence: number, year: Date, label: string, balance: number): EarlierInvoice => ({
  studentId,
  balance: D(balance),
  term: { name, sequence, academicYear: { name: label, startDate: year } },
});

console.log("Arrears: the balance of the latest earlier invoice");
const within = arrearsBefore(
  [inv("a", "FIRST", 1, Y25, "2025/2026", 300), inv("a", "SECOND", 2, Y25, "2025/2026", 450)],
  { yearStart: Y25, sequence: 3 },
);
check("within a year, the immediately previous term is the arrears (450, not 300)", within.get("a")?.amount.equals(450) === true);
check("it names the term it is owed from", within.get("a")?.from === "Second Term · 2025/2026", within.get("a")?.from);

const across = arrearsBefore(
  [inv("a", "FIRST", 1, Y25, "2025/2026", 100), inv("a", "THIRD", 3, Y25, "2025/2026", 620)],
  { yearStart: Y26, sequence: 1 },
);
check("third term to the next year's first: the third term's balance carries over (it found NONE before)", across.get("a")?.amount.equals(620) === true);
check("and says which term", across.get("a")?.from === "Third Term · 2025/2026");

const gap = arrearsBefore([inv("a", "FIRST", 1, Y25, "2025/2026", 200)], { yearStart: Y25, sequence: 3 });
check("a term that was never invoiced does not hide what was owed before it", gap.get("a")?.amount.equals(200) === true);

const later = arrearsBefore(
  [inv("a", "SECOND", 2, Y25, "2025/2026", 100), inv("a", "THIRD", 3, Y25, "2025/2026", 999)],
  { yearStart: Y25, sequence: 3 },
);
check("the target term itself and later ones are not arrears", later.get("a")?.amount.equals(100) === true);
check("an invoice order that arrives shuffled gives the same answer", (() => {
  const rows = [inv("a", "THIRD", 3, Y25, "y", 5), inv("a", "FIRST", 1, Y25, "y", 9), inv("a", "SECOND", 2, Y25, "y", 7)];
  return arrearsBefore(rows, { yearStart: Y26, sequence: 1 }).get("a")?.amount.equals(5) === true &&
    arrearsBefore([...rows].reverse(), { yearStart: Y26, sequence: 1 }).get("a")?.amount.equals(5) === true;
})());
check("a family that has paid in full carries nothing, and is absent", !arrearsBefore([inv("a", "THIRD", 3, Y25, "y", 0)], { yearStart: Y26, sequence: 1 }).has("a"));
check("a credit (negative balance) is not arrears", !arrearsBefore([inv("a", "THIRD", 3, Y25, "y", -50)], { yearStart: Y26, sequence: 1 }).has("a"));
const two = arrearsBefore(
  [inv("a", "THIRD", 3, Y25, "y", 10), inv("b", "THIRD", 3, Y25, "y", 20)],
  { yearStart: Y26, sequence: 1 },
);
check("each pupil is answered separately", two.get("a")?.amount.equals(10) === true && two.get("b")?.amount.equals(20) === true);
check("term order is year first, then term", isEarlier({ yearStart: Y25, sequence: 3 }, { yearStart: Y26, sequence: 1 }) && !isEarlier({ yearStart: Y26, sequence: 1 }, { yearStart: Y25, sequence: 3 }));

console.log("\nLevel: where the child will be, not where they are");
const ladder = [
  { id: "n2", order: 0 },
  { id: "kg1", order: 1 },
  { id: "kg2", order: 2 },
  { id: "b9", order: 11 },
];
const at = (id: string) => ladder.find((l) => l.id === id)!;
const level = (over: Partial<Parameters<typeof levelForNextTerm>[0]>) =>
  levelForNextTerm({ enrolledLevelId: null, currentLevel: at("kg1"), decision: null, ladder, crossesYear: true, ...over });

const placed = level({ enrolledLevelId: "kg2", decision: "REPEATED" });
check("a child already placed for the coming year is billed at that class, whatever the verdict", placed.kind === "ENROLLED" && placed.levelId === "kg2");
const promoted = level({ decision: "PROMOTED" });
check("promoted: billed one rung up (KG1 -> KG2), not at the class they are leaving", promoted.kind === "PROMOTED" && promoted.levelId === "kg2");
const skipRung = levelForNextTerm({ enrolledLevelId: null, currentLevel: at("n2"), decision: "PROMOTED", ladder, crossesYear: true });
check("one rung up is the NEXT order, not order + 1: Nursery 2 (0) goes to KG1 (1)", skipRung.kind === "PROMOTED" && skipRung.levelId === "kg1");
const repeating = level({ decision: "REPEATED" });
check("repeating stays, and is not flagged as a guess", repeating.kind === "SAME" && repeating.levelId === "kg1" && !repeating.assumed);
const pending = level({ decision: "PENDING" });
check("no decision yet: priced where they are, and flagged so the office looks", pending.kind === "SAME" && pending.assumed);
const none = level({ decision: null });
check("a year with no verdict recorded at all is flagged the same way", none.kind === "SAME" && none.assumed);
check("graduating: not billed", level({ decision: "GRADUATED", currentLevel: at("b9") }).kind === "GRADUATING");
check("promoted with nothing above is finishing school, not billed", level({ decision: "PROMOTED", currentLevel: at("b9") }).kind === "GRADUATING");
const sameYear = level({ crossesYear: false, decision: null });
check("within a year nobody is 'assumed': there is no verdict to be waiting for", sameYear.kind === "SAME" && !sameYear.assumed);
check("no class at all is its own answer", level({ currentLevel: null }).kind === "NO_CLASS");

console.log("\nThe page uses these rules, and nothing else");
const code = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const data = code("src/lib/invoice-data.ts");
const proforma = data.slice(data.indexOf("export async function getProformaForTerm"));
check("getProformaForTerm takes arrears from arrearsBefore", /arrearsBefore\(/.test(proforma));
check("and the level from levelForNextTerm", /levelForNextTerm\(/.test(proforma));
check("it no longer looks for 'the previous term in this year' by itself", !/sequence:\s*term\.sequence\s*-\s*1/.test(proforma));
check("it still writes nothing", !/\.(create|update|upsert|delete)(Many)?\(/.test(proforma));
check("the Invoices page asks getNextTermId, so the three screens agree on which term is next", /getNextTermId\(/.test(code("src/app/(app)/invoices/page.tsx")));

console.log(failures === 0 ? "\nAll good." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
