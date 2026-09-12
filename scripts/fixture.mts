import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

/**
 * The school a verify script means when it says "the school".
 *
 * ⚠️ Never `school.findFirst()` on its own. Postgres returns rows in no
 * particular order, and a development database collects schools: the onboarding
 * walk provisions a `qa-<stamp>` one on every run and DELIBERATELY leaves it
 * behind for inspection (`verify:onboarding --clean <slug>` removes it). So an
 * unscoped pick is a coin flip between the seeded demo school, which has a term
 * and classes and marks in it, and an empty shell that was provisioned four
 * minutes ago.
 *
 * That is not a hypothetical. `verify:teacher` built its fixture from four
 * separate unscoped `findFirst` calls and paired a teacher in one school with
 * another school's term; the sheet then had nothing to show and the failure
 * read "0 score inputs", which names neither the cause nor the school. CI never
 * saw it, because CI seeds exactly one school and every coin lands the same way.
 *
 * Ordering by `createdAt` on top of the filter makes the choice STABLE as well
 * as correct — two real schools would otherwise reintroduce the same coin flip
 * with no QA school anywhere in sight.
 */
export async function demoSchool() {
  const school = await withBypass(() =>
    prisma.school.findFirst({
      where: { slug: { not: { startsWith: "qa-" } } },
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!school) {
    throw new Error(
      "No seeded school in this database — every school here is a qa-* leftover from the " +
        "onboarding walk. Run `npm run db:seed`.",
    );
  }
  return school;
}
