/**
 * The class roll-up writes only what changed, and writes the same rows a from-scratch roll-up would.
 *
 *   npm run verify:rollup
 *
 * `computeClassResults` used to upsert every pupil's every subject (550 for a class of 50) plus every pupil's
 * term total, in one transaction holding one of the app role's four connections. A teacher saving ONE subject
 * changed about fifty of them. The load test measured a mark-sheet save at about 2.4 CPU-seconds, and a few at
 * once starved the instance's pool (P2024). It is now a diff: read what is there, write what differs.
 *
 * A diff is only worth having if it is the SAME answer, so this asserts three things and nothing about speed:
 *   1. nothing changed  -> NOTHING is written;
 *   2. one mark changed -> only a handful of statements, not hundreds;
 *   3. the incremental result equals a from-scratch roll-up of the same marks, row for row.
 * Property 3 is the one that catches a diff that skips a row it should have written.
 *
 * Everything happens inside ONE transaction that is rolled back, so the seeded school is left exactly as it was
 * (other guards assert against it). Development databases only, like every guard that reads the seed.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { computeClassResults } from "@/lib/results-engine";
import { demoSchool } from "./fixture.mjs";

const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const WRITES = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
/** The same transaction, counting every write made to the two result tables. */
function counted(tx: unknown, tally: Record<string, number>) {
  return new Proxy(tx as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if ((key === "subjectResult" || key === "termResult") && value && typeof value === "object") {
        return new Proxy(value as object, {
          get(model, op, r) {
            const fn = Reflect.get(model, op, r);
            if (typeof op === "string" && WRITES.has(op) && typeof fn === "function") {
              return (...args: unknown[]) => {
                tally[`${String(key)}.${op}`] = (tally[`${String(key)}.${op}`] ?? 0) + 1;
                return fn.apply(model, args);
              };
            }
            return typeof fn === "function" ? fn.bind(model) : fn;
          },
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TenantTx;
}
const total = (tally: Record<string, number>) => Object.values(tally).reduce((a, b) => a + b, 0);
const fixed = (v: Prisma.Decimal | null) => (v === null ? null : v.toFixed(2));

class Rollback extends Error {}

const school = await demoSchool();
const term = await db.term.findFirstOrThrow({ where: { schoolId: school.id, isCurrent: true } });
// A class with marks in the current term: the seed leaves its second term open for exactly this.
const withMarks = await db.score.findFirst({
  where: { rawScore: { not: null }, assessment: { schoolId: school.id, termId: term.id, status: { not: "DRAFT" } } },
  include: { assessment: true },
});

if (!withMarks) {
  console.log("  FAIL the seeded school has no marks in its current term, so there is nothing to roll up");
  process.exit(1);
}
const classGroupId = withMarks.assessment.classGroupId;
const heldBefore = {
  subjects: await db.subjectResult.count({ where: { termId: term.id, classGroupId } }),
  terms: await db.termResult.count({ where: { termId: term.id, classGroupId } }),
  mark: withMarks.rawScore?.toFixed(2) ?? null,
};

try {
  await db.$transaction(
    async (tx) => {
      const roll = (tally: Record<string, number> = {}) => computeClassResults(counted(tx, tally), school.id, term.id, classGroupId);
      const wipe = async () => {
        await tx.subjectResult.deleteMany({ where: { termId: term.id, classGroupId } });
        await tx.termResult.deleteMany({ where: { termId: term.id, classGroupId } });
      };
      const snapshot = async () => {
        const subjects = await tx.subjectResult.findMany({ where: { termId: term.id, classGroupId }, orderBy: [{ studentId: "asc" }, { subjectId: "asc" }] });
        const terms = await tx.termResult.findMany({ where: { termId: term.id, classGroupId }, orderBy: { studentId: "asc" } });
        return JSON.stringify({
          subjects: subjects.map((r) => [r.studentId, r.subjectId, fixed(r.classScore), fixed(r.examScore), fixed(r.totalScore), r.grade, r.points, r.subjectPosition, r.subjectSize, r.teacherId]),
          terms: terms.map((r) => [r.studentId, r.subjectsCount, r.subjectsOffered, r.possibleMarks, fixed(r.totalMarks), fixed(r.average), fixed(r.percentage), r.aggregate, r.classPosition, r.classSize, r.status]),
        });
      };

      console.log("A roll-up from nothing");
      await wipe();
      const first: Record<string, number> = {};
      const result = await roll(first);
      const baseline = await snapshot();
      const rows = JSON.parse(baseline) as { subjects: unknown[]; terms: unknown[] };
      check("it produces results, so the rest of this is about something", result.students > 0 && rows.subjects.length > 0 && rows.terms.length > 0, `${rows.subjects.length} subject rows`);
      check("and creates them in a few statements, not one per row", total(first) <= 4, JSON.stringify(first));

      console.log("\nNothing has changed");
      const second: Record<string, number> = {};
      await roll(second);
      check("rolling up again writes NOTHING", total(second) === 0, JSON.stringify(second));
      check("and every row is as it was", (await snapshot()) === baseline);

      console.log("\nOne mark changes");
      const score = await tx.score.findFirstOrThrow({ where: { id: withMarks.id }, include: { assessment: true } });
      // A different mark under the total, so the pupil's subject, their term total and the class positions can all move.
      const next = new Prisma.Decimal(score.assessment.maxScore).mul(score.rawScore && score.rawScore.lessThan(new Prisma.Decimal(score.assessment.maxScore).mul(0.5)) ? 0.97 : 0.04);
      await tx.score.update({ where: { id: score.id }, data: { rawScore: next.toFixed(2) } });
      const third: Record<string, number> = {};
      await roll(third);
      const incremental = await snapshot();
      check("only a handful of statements are written", total(third) > 0 && total(third) <= 140, JSON.stringify(third));
      check("the marks really did move something (otherwise this proves nothing)", incremental !== baseline);

      await wipe();
      await roll();
      const scratch = await snapshot();
      check("the incremental result equals a from-scratch roll-up of the same marks, row for row", incremental === scratch);

      throw new Rollback();
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
} catch (error) {
  if (!(error instanceof Rollback)) {
    console.error(error);
    failures += 1;
  }
}

const after = {
  subjects: await db.subjectResult.count({ where: { termId: term.id, classGroupId } }),
  terms: await db.termResult.count({ where: { termId: term.id, classGroupId } }),
  mark: (await db.score.findUniqueOrThrow({ where: { id: withMarks.id } })).rawScore?.toFixed(2) ?? null,
};
console.log("\nNothing was kept");
check("the transaction rolled back: the same result rows and the same mark as before", JSON.stringify(after) === JSON.stringify(heldBefore), `${JSON.stringify(heldBefore)} -> ${JSON.stringify(after)}`);

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
