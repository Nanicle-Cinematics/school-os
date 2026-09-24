import "server-only";

import { Prisma } from "@prisma/client";
import type { AssessmentType } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";

/**
 * What every subject is marked out of, defined once per school.
 *
 * Three class tests and a project make up the class score; the end-of-term
 * exam is scored separately. A school that marks differently edits the list;
 * a school that does not never has to think about it again.
 */
export const DEFAULT_COMPONENTS: {
  title: string;
  type: AssessmentType;
  maxScore: number;
  isExam: boolean;
  order: number;
}[] = [
  { title: "Class Test 1", type: "CLASS_TEST", maxScore: 10, isExam: false, order: 10 },
  { title: "Class Test 2", type: "CLASS_TEST", maxScore: 10, isExam: false, order: 20 },
  { title: "Class Test 3", type: "CLASS_TEST", maxScore: 10, isExam: false, order: 30 },
  { title: "Project Work", type: "PROJECT", maxScore: 20, isExam: false, order: 40 },
  { title: "Examination", type: "END_OF_TERM_EXAM", maxScore: 50, isExam: true, order: 50 },
];

/**
 * Stock component names an earlier standard shipped, retired by the one
 * above.
 *
 * Named explicitly rather than inferred, so retiring them can never reach a
 * component a school renamed one of ITS OWN to coincide with by chance — only
 * these exact titles, which only this product ever created, are removed.
 * Removing a template only stops it appearing on sheets opened from now on;
 * marks already entered live on Assessment rows and are untouched.
 */
const RETIRED_COMPONENT_TITLES = ["Group Work 1", "Group Work 2"];

export type TemplateResult = { created: number; updated: number; removed: number };

/**
 * Bring a school's components in line with the current standard.
 *
 * Not purely additive: a component whose title matches the standard's but was
 * set up under an EARLIER standard (an old max score, a changed order) is
 * UPDATED to match, and a name the standard has since retired is REMOVED.
 * Anything the school added under a name of its own — "Oral Test", a renamed
 * component, whatever else — is never touched; this only ever acts on the
 * standard's own titles, in both directions.
 *
 * Idempotent, so running it again once a school already matches reports
 * nothing to do — it is what "Reset to the standard components" on Settings →
 * Assessment components calls, and also how a new school is provisioned.
 */
export async function applyDefaultAssessmentTemplate(
  tx: TenantTx,
  schoolId: string,
): Promise<TemplateResult> {
  const result: TemplateResult = { created: 0, updated: 0, removed: 0 };

  const existing = await tx.assessmentTemplate.findMany({
    where: {
      schoolId,
      title: { in: [...DEFAULT_COMPONENTS.map((c) => c.title), ...RETIRED_COMPONENT_TITLES] },
    },
  });
  const byTitle = new Map(existing.map((component) => [component.title, component]));

  for (const component of DEFAULT_COMPONENTS) {
    const current = byTitle.get(component.title);
    const maxScore = new Prisma.Decimal(component.maxScore);

    if (!current) {
      await tx.assessmentTemplate.create({
        data: {
          schoolId,
          title: component.title,
          type: component.type,
          maxScore,
          isExam: component.isExam,
          order: component.order,
          isActive: true,
        },
      });
      result.created += 1;
      continue;
    }

    const matches =
      current.type === component.type &&
      current.maxScore.equals(maxScore) &&
      current.isExam === component.isExam &&
      current.order === component.order &&
      current.isActive;
    if (!matches) {
      await tx.assessmentTemplate.update({
        where: { id: current.id },
        data: {
          type: component.type,
          maxScore,
          isExam: component.isExam,
          order: component.order,
          isActive: true,
        },
      });
      result.updated += 1;
    }
  }

  const retired = RETIRED_COMPONENT_TITLES.map((title) => byTitle.get(title)).filter(
    (row): row is NonNullable<typeof row> => row !== undefined,
  );
  if (retired.length > 0) {
    await tx.assessmentTemplate.deleteMany({ where: { id: { in: retired.map((row) => row.id) } } });
    result.removed += retired.length;
  }

  return result;
}

export type MaterialiseResult = {
  created: number;
  existing: number;
  components: number;
};

/**
 * Create this term's components for one class and subject, from the template.
 *
 * Idempotent through the unique key on (term, class, subject, title): a second
 * run fills in a component added to the template later without disturbing the
 * marks already entered against the others.
 *
 * **`weight` is set to `maxScore` deliberately.** The results engine weights
 * each item's percentage by `weight`, so weight = maxScore reduces exactly to
 * (sum of raw marks / sum of max marks) — see verify:results. That is what a
 * teacher means by "Class Test 1 is out of 20": twenty marks of influence, not
 * an independent percentage to configure. Changing a component's total marks
 * therefore changes its influence proportionally, with nothing else to set.
 */
export async function materialiseComponents(
  tx: TenantTx,
  schoolId: string,
  where: { termId: string; classGroupId: string; subjectId: string },
  createdByStaffId: string | null,
): Promise<MaterialiseResult> {
  const templates = await tx.assessmentTemplate.findMany({
    where: { schoolId, isActive: true },
    orderBy: { order: "asc" },
  });

  const result: MaterialiseResult = { created: 0, existing: 0, components: templates.length };

  for (const template of templates) {
    const existing = await tx.assessment.findFirst({
      where: { ...where, title: template.title },
    });
    if (existing) {
      result.existing += 1;
      continue;
    }

    await tx.assessment.create({
      data: {
        schoolId,
        ...where,
        type: template.type,
        title: template.title,
        maxScore: template.maxScore,
        weight: template.maxScore,
        status: "OPEN",
        createdByStaffId,
      },
    });
    result.created += 1;
  }

  return result;
}

/**
 * An exam item is identified by its type, not by a flag on the row — the
 * results engine already splits on type, and duplicating that decision onto
 * Assessment would let the two disagree.
 */
export const EXAM_TYPES: AssessmentType[] = ["MIDTERM_EXAM", "END_OF_TERM_EXAM"];

export function isExamType(type: AssessmentType) {
  return EXAM_TYPES.includes(type);
}
