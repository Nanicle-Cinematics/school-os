import { prisma } from "@/lib/prisma";

/**
 * Is every id one of THIS school's rows?
 *
 * ⚠️ Row security hides another school's rows from a read; it does not stop a
 * write that POINTS at one. A foreign-reference constraint is checked by
 * Postgres as the table owner, so it ignores the policies, and the new row
 * carries the caller's own schoolId, so it passes WITH CHECK. An id taken from a
 * form and written into a referencing column therefore has to be read back
 * through the tenant client first: a row from another school reads as absent.
 *
 * Audited 2026-10-10 — sixteen actions wrote a posted id without that read, and
 * the damage is not disclosure but obstruction. A ledger mapping pointed at
 * another school's account makes that account undeletable (the journal line
 * restricts it) while the other school sees no line at all; an assessment on
 * another school's term, class and subject claims a title in a uniqueness index
 * that has no school column, and the other school's own sheet then fails.
 *
 * `countVisible` is handed the distinct ids and returns how many the tenant
 * client can see. Null, empty and repeated ids are ignored, so a nullable column
 * can be passed straight in. Nothing to check is trivially owned.
 */
export async function ownsAll(
  ids: ReadonlyArray<string | null | undefined>,
  countVisible: (ids: string[]) => Promise<number>,
): Promise<boolean> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) {
    return true;
  }
  return (await countVisible(wanted)) === wanted.length;
}

/**
 * The (term, class, subject) triple an assessment hangs on, all three this
 * school's own. One read each, in sequence: a page's queries do not fan out here
 * (connection_limit), and these are tiny.
 *
 * A TEACHER is proven another way — an assignment row — but leadership and the
 * IT admin are exempt from that, and an exemption from "may teach it" must not
 * become an exemption from "is it ours".
 */
export async function ownsSheet(
  termId: string,
  classGroupId: string,
  subjectId: string,
): Promise<boolean> {
  return (
    (await ownsAll([termId], (ids) => prisma.term.count({ where: { id: { in: ids } } }))) &&
    (await ownsAll([classGroupId], (ids) => prisma.classGroup.count({ where: { id: { in: ids } } }))) &&
    (await ownsAll([subjectId], (ids) => prisma.subject.count({ where: { id: { in: ids } } })))
  );
}
