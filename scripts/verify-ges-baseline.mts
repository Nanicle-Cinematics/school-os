/**
 * The baseline ladder every school starts with, and what adding to it does to a school that already exists.
 *
 * Two halves. The SHAPE (pure): which levels there are, in what order, which subjects each one offers, and the
 * counts CLAUDE.md quotes. And the EFFECT on an existing school, run for real against the database inside a
 * transaction that is ROLLED BACK, so nothing it does is kept: `applyGesCurriculum` is the button on Settings ->
 * School structure that fills in a school created before a level was added to the baseline, and for the nursery
 * that is every school there is, the one in production included.
 *
 * What is pinned and why:
 *   - the orders are CONSECUTIVE. Paper records subtract from `order` to find "that many rungs down"
 *     (records-engine.ts), and promotion finds the level above as the next order up. A gap would skip a rung.
 *   - KG1 stays at 1 and KG2 at 2. Every school created before the nursery has those stored, and the baseline
 *     only ever creates: a nursery that renumbered KG would collide with it. So the nursery is -1 and 0.
 *   - the nursery takes the four thematic areas, and never Mathematics or Science.
 *   - applying it to an existing school creates ONLY what is missing and changes no stored order.
 *
 * Run: npm run verify:ges-baseline
 */
import { readFileSync } from "node:fs";
import { GES_LEVELS, GES_SUBJECTS, applyGesCurriculum } from "@/lib/ges-curriculum";
import { tenantTransaction } from "@/lib/prisma";
import { demoSchool } from "./fixture.mjs";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const offered = (levelCode: string) => GES_SUBJECTS.filter((s) => s.levels.includes(levelCode)).map((s) => s.code);

console.log("The ladder");
const codes = GES_LEVELS.map((l) => l.code);
check("thirteen levels, nursery first", GES_LEVELS.length === 13 && codes.join(",") === "N1,N2,KG1,KG2,B1,B2,B3,B4,B5,B6,B7,B8,B9", codes.join(","));
check("every code and every name is unique", new Set(codes).size === codes.length && new Set(GES_LEVELS.map((l) => l.name)).size === codes.length);
check("the orders are CONSECUTIVE (paper records count rungs by subtracting; a gap would skip one)", GES_LEVELS.every((l, i) => i === 0 || l.order === GES_LEVELS[i - 1].order + 1));
check("and strictly increasing, so promotion's 'the next order up' is the next rung", GES_LEVELS.every((l, i) => i === 0 || l.order > GES_LEVELS[i - 1].order));
check("Nursery 1 and 2 are orders -1 and 0", GES_LEVELS[0].order === -1 && GES_LEVELS[1].order === 0);
check("KG1 and KG2 keep 1 and 2: schools that exist have those stored, and the baseline never renumbers", GES_LEVELS.find((l) => l.code === "KG1")?.order === 1 && GES_LEVELS.find((l) => l.code === "KG2")?.order === 2);
check("JHS 3 is 11, where it has always been", GES_LEVELS.find((l) => l.code === "B9")?.order === 11);
const stage = (c: string) => GES_LEVELS.find((l) => l.code === c)?.stage;
check("nursery is the NURSERY stage, which the fees, class and structure screens already handle", stage("N1") === "NURSERY" && stage("N2") === "NURSERY");
check("KG, primary and JHS keep their stages", stage("KG1") === "KINDERGARTEN" && stage("B1") === "PRIMARY" && stage("B6") === "PRIMARY" && stage("B7") === "JHS" && stage("B9") === "JHS");
check("names read as the school says them", GES_LEVELS[0].name === "Nursery 1" && GES_LEVELS[1].name === "Nursery 2");

console.log("\nThe subjects");
check("18 subjects, each code once", GES_SUBJECTS.length === 18 && new Set(GES_SUBJECTS.map((s) => s.code)).size === 18);
check("Nursery 1 and 2 each take the four thematic areas", ["N1", "N2"].every((c) => offered(c).sort().join() === ["CA", "LIT", "NUM", "OWOP"].sort().join()), offered("N1").join(","));
check("and never Mathematics, Science or English: they are not taught as subjects there", ["N1", "N2"].every((c) => !offered(c).some((s) => ["MAT", "SCI", "ENG"].includes(s))));
check("exactly what KG takes, so the early years read as one framework", ["N1", "N2"].every((c) => offered(c).sort().join() === offered("KG1").sort().join()));
const count = (cs: string[]) => cs.map((c) => offered(c).length);
check("Nursery 4, KG 4, B1 to B3 9, B4 to B6 11, B7 to B9 12 (the counts CLAUDE.md quotes)", count(["N1", "N2"]).every((n) => n === 4) && count(["KG1", "KG2"]).every((n) => n === 4) && count(["B1", "B2", "B3"]).every((n) => n === 9) && count(["B4", "B5", "B6"]).every((n) => n === 11) && count(["B7", "B8", "B9"]).every((n) => n === 12), codes.map((c) => `${c}:${offered(c).length}`).join(" "));
check("112 offerings in all (104 before the nursery, plus four for each of the two)", codes.reduce((n, c) => n + offered(c).length, 0) === 112);
check("every level a subject names exists", GES_SUBJECTS.every((s) => s.levels.every((c) => codes.includes(c))));
check("the lineages are unchanged: OWOP and History stop at B6, Social Studies starts at B7", !offered("B7").includes("OWOP") && !offered("B7").includes("HIS") && offered("B7").includes("SOC") && offered("B6").includes("HIS"));

console.log("\nThe baseline only ever creates");
const source = code("src/lib/ges-curriculum.ts");
check("applyGesCurriculum never updates or deletes a level (so it can never renumber one)", !/level\.(update|updateMany|delete|deleteMany|upsert)\(/.test(source));
check("nor a subject or an offering", !/(subject|levelSubject)\.(update|updateMany|delete|deleteMany|upsert)\(/.test(source));

console.log("\nAdding the nursery to a school that already exists (run for real, then rolled back)");
class Rollback extends Error {}
const school = await demoSchool();
type Outcome = { before: Map<string, number>; after: Map<string, number>; created1: number; created2: number; links: Record<string, number>; stages: Record<string, string> };
// A box, not a bare variable: it is assigned inside the transaction's closure, which TypeScript cannot see.
const box: { result: Outcome | null } = { result: null };
try {
  await tenantTransaction(
    school.id,
    async (tx) => {
      const orders = async () => new Map((await tx.level.findMany({ where: { schoolId: school.id }, select: { code: true, order: true } })).map((l) => [l.code, l.order]));
      const before = await orders();
      const first = await applyGesCurriculum(tx, school.id);
      const after = await orders();
      const second = await applyGesCurriculum(tx, school.id);
      const links = await tx.levelSubject.groupBy({ by: ["levelId"], where: { schoolId: school.id, level: { code: { in: ["N1", "N2"] } } }, _count: { _all: true } });
      const named = await tx.level.findMany({ where: { schoolId: school.id, code: { in: ["N1", "N2"] } }, select: { id: true, code: true, stage: true } });
      box.result = {
        before,
        after,
        created1: first.levelsCreated,
        created2: second.levelsCreated + second.subjectsCreated + second.linksCreated,
        links: Object.fromEntries(named.map((n) => [n.code, links.find((l) => l.levelId === n.id)?._count._all ?? 0])),
        stages: Object.fromEntries(named.map((n) => [n.code, n.stage])),
      };
      // Nothing above is kept.
      throw new Rollback();
    },
    { timeout: 180_000, maxWait: 20_000 },
  );
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
}
if (!box.result) {
  check("the rolled-back run produced a result", false);
} else {
  const o = box.result;
  const missingBefore = GES_LEVELS.filter((l) => !o.before.has(l.code)).map((l) => l.code);
  check("the school gains Nursery 1 and 2 (and any other baseline level it lacked)", o.after.has("N1") && o.after.has("N2") && o.created1 === missingBefore.length, `created ${o.created1}: ${missingBefore.join(",")}`);
  check("at orders -1 and 0, below KG1", o.after.get("N1") === -1 && o.after.get("N2") === 0);
  check("as the NURSERY stage", o.stages.N1 === "NURSERY" && o.stages.N2 === "NURSERY");
  check("with the four thematic areas each", o.links.N1 === 4 && o.links.N2 === 4, JSON.stringify(o.links));
  const changed = [...o.before].filter(([c, order]) => o.after.get(c) !== order);
  check("and NO stored order changes: every level the school already had keeps its place", changed.length === 0, changed.map(([c]) => c).join(","));
  const ladder = [...o.after].filter(([c]) => GES_LEVELS.some((l) => l.code === c)).sort((a, b) => a[1] - b[1]);
  check("the baseline levels still run in the baseline's own order, with nursery first", ladder.map(([c]) => c).join(",") === codes.filter((c) => o.after.has(c)).join(","), ladder.map(([c]) => c).join(","));
  check("running it again creates nothing (idempotent)", o.created2 === 0, `${o.created2}`);
}
const kept = await tenantTransaction(school.id, async (tx) => tx.level.count({ where: { schoolId: school.id, code: { in: ["N1", "N2"] } } }), { timeout: 60_000, maxWait: 20_000 });
check("and none of it was kept: the school is exactly as it was", kept === 0, `${kept} nursery levels afterwards`);

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
