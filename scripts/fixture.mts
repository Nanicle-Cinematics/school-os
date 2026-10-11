import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

/**
 * Run `fn` on the OWNER connection, and close it before returning.
 *
 * For a verify script's cleanup of rows the app role may add but never remove.
 * `db:rls` revokes UPDATE, DELETE and TRUNCATE on AuditLog, JournalEntry and
 * JournalLine from `school_os_app` on purpose — a ledger that the app can edit
 * is not a ledger — so a fixture written through `prisma` cannot be taken back
 * through it. Against a database that has had `db:rls` run that is a 42501 at
 * the very end of the script, AFTER the rows are written: the run fails and
 * leaves its debris behind, and the next run's "no rows left" check fails on
 * work that was never wrong. CI never saw it, because these guards run there
 * BEFORE `db:rls`, on a database with no revoke yet.
 *
 * Same URL choice as verify-isolation. Closed on the way out because
 * `connection_limit` is small and a second client held open for the rest of a
 * script is how the dev database got starved.
 */
export async function withOwner<T>(fn: (owner: PrismaClient) => Promise<T>): Promise<T> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const owner = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  try {
    return await fn(owner);
  } finally {
    await owner.$disconnect();
  }
}

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
