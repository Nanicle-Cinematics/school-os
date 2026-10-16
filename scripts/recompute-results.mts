/**
 * Recompute every class's results, for every term, in every school.
 *
 * The one-off after a change to how a mark is turned into a number — a new
 * weighting, an edited curriculum, or the day the term gained a denominator.
 * Stored results are frozen on purpose, so nothing refreshes itself: a class is
 * recomputed when a teacher saves its mark sheet or leadership presses Compute,
 * and a class nobody touches keeps last term's arithmetic forever.
 *
 *   npm run recompute            # dev, from .env
 *   npm run recompute -- --prod  # production, from .env.prod
 *   npm run recompute -- --dry   # say what would change, write nothing
 *
 * Terms run in sequence order, which matters: the third term's promotion rule
 * reads the first two, so computing them out of order would decide the year on
 * a fraction of it.
 *
 * ⚠️ A PUBLISHED TermResult is left exactly as it was — republishing is an
 * explicit act, and a parent holding a printed card must not find the school's
 * copy quietly disagreeing with it. Its SUBJECT rows are left alone too (the
 * results engine skips every published pupil), so the card stays consistent.
 */
import "./owner-env.mts";
import { PrismaClient } from "@prisma/client";
import { computeClassResults } from "@/lib/results-engine";

const dry = process.argv.includes("--dry");
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

const schools = await prisma.school.findMany({
  orderBy: { name: "asc" },
  select: { id: true, name: true, slug: true },
});

if (schools.length === 0) {
  console.log("No schools in this database — nothing to recompute.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`${schools.length} school${schools.length === 1 ? "" : "s"}${dry ? " (dry run)" : ""}\n`);

let computed = 0;
let empty = 0;
let failed = 0;

for (const school of schools) {
  console.log(`${school.name} (${school.slug})`);

  const terms = await prisma.term.findMany({
    where: { schoolId: school.id },
    orderBy: [{ academicYear: { startDate: "asc" } }, { sequence: "asc" }],
    include: { academicYear: { select: { name: true } } },
  });

  const classGroups = await prisma.classGroup.findMany({
    where: { schoolId: school.id },
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    include: { level: { select: { name: true } } },
  });

  if (terms.length === 0 || classGroups.length === 0) {
    console.log("  no terms or no classes — skipped\n");
    continue;
  }

  for (const term of terms) {
    const label = `${term.academicYear.name} ${term.name.toLowerCase()}`;
    for (const classGroup of classGroups) {
      const where = `${classGroup.level.name} ${classGroup.name}`;
      if (dry) {
        console.log(`  would compute ${where} · ${label}`);
        computed += 1;
        continue;
      }

      try {
        const result = await prisma.$transaction(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (tx) => computeClassResults(tx as any, school.id, term.id, classGroup.id),
          { timeout: 180_000, maxWait: 30_000 },
        );

        // `subjects` counts sheets, not marks. A term whose sheets are open but
        // empty computes "10 subjects" and writes eleven blank rows, which read
        // as work done when nothing was. Ask the rows themselves instead.
        const marked = await prisma.termResult.count({
          where: { termId: term.id, classGroupId: classGroup.id, possibleMarks: { not: null } },
        });
        if (result.students === 0 || result.subjects === 0 || marked === 0) {
          empty += 1;
          continue;
        }

        const verdict = result.promotion
          ? ` → ${result.promotion.promoted} up, ${result.promotion.repeated} repeating` +
            (result.promotion.graduated ? `, ${result.promotion.graduated} leaving` : "") +
            ` at ${result.promotion.passMark}%`
          : "";
        console.log(
          `  ${where.padEnd(18)} ${label.padEnd(18)} ` +
            `${result.subjects} subjects × ${marked} marked students${verdict}`,
        );
        computed += 1;
      } catch (error) {
        // One class that cannot be computed must not stop the other forty.
        failed += 1;
        console.log(`  ${where.padEnd(18)} ${label.padEnd(18)} FAILED — ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }
  console.log("");
}

console.log(
  `${computed} class-term${computed === 1 ? "" : "s"} computed, ${empty} with nothing marked yet, ${failed} failed.`,
);
if (failed > 0) {
  process.exitCode = 1;
}

await prisma.$disconnect();
