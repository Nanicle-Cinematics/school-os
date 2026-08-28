import "server-only";

import { Prisma } from "@prisma/client";
import type { AssessmentType } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";

/**
 * What every subject is marked out of, defined once per school.
 *
 * Six components, five of which make up the class score and one the exam. A
 * school that marks differently edits the list; a school that does not never
 * has to think about it again.
 *
 * The marks below are the GES-conventional shape for basic school: two written
 * tests, two pieces of group work, a project, and an end-of-term paper. They
 * are a starting point, not a rule.
 */
export const DEFAULT_COMPONENTS: {
  title: string;
  type: AssessmentType;
  maxScore: number;
  isExam: boolean;
  order: number;
}[] = [
  { title: "Class Test 1", type: "CLASS_TEST", maxScore: 20, isExam: false, order: 10 },
  { title: "Class Test 2", type: "CLASS_TEST", maxScore: 20, isExam: false, order: 20 },
  { title: "Group Work 1", type: "GROUP_WORK", maxScore: 10, isExam: false, order: 30 },
  { title: "Group Work 2", type: "GROUP_WORK", maxScore: 10, isExam: false, order: 40 },
  { title: "Project Work", type: "PROJECT", maxScore: 20, isExam: false, order: 50 },
  { title: "Examination", type: "END_OF_TERM_EXAM", maxScore: 100, isExam: true, order: 60 },
];

export type TemplateResult = { created: number; skipped: number };

/**
 * Give a school the standard components. Idempotent on title, which is unique
 * per school — so it fills gaps for a school set up before this existed, and
 * never overwrites marks a school has already adjusted.
 */
export async function applyDefaultAssessmentTemplate(
  tx: TenantTx,
  schoolId: string,
): Promise<TemplateResult> {
  const result: TemplateResult = { created: 0, skipped: 0 };

  for (const component of DEFAULT_COMPONENTS) {
    const existing = await tx.assessmentTemplate.findFirst({
      where: { schoolId, title: component.title },
    });
    if (existing) {
      result.skipped += 1;
      continue;
    }
    await tx.assessmentTemplate.create({
      data: {
        schoolId,
        title: component.title,
        type: component.type,
        maxScore: new Prisma.Decimal(component.maxScore),
        isExam: component.isExam,
        order: component.order,
        isActive: true,
      },
    });
    result.created += 1;
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
