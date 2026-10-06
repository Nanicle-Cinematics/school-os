import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP, MARKING, canAccess } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getMockSheet, getMockSheetOptions } from "@/lib/mock-data";
import { buttonClass } from "../../../button-style";
import { PageHeader, Card, Alert, inputClass } from "../../../ui";
import { MockSheetForm } from "./sheet-form";

export const metadata: Metadata = { title: "Mock mark sheet · School OS" };

export default async function MockSheetPage({ params, searchParams }: PageProps<"/mocks/[id]/sheet">) {
  const auth = await requireRole(MARKING);
  const { id } = await params;
  const query = await searchParams;
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  const mock = await prisma.mockExam.findUnique({
    where: { id },
    include: { level: { select: { id: true, name: true } } },
  });
  if (!mock) notFound();

  const { classGroups, subjects, pairs } = await getMockSheetOptions(
    mock.levelId,
    mock.academicYearId,
    auth.staffId,
    isLeadership,
  );

  // A teacher is offered only the classes and subjects they are assigned.
  const mayMark = (classGroupId: string, subjectId: string) =>
    !pairs || pairs.some((p) => p.classGroupId === classGroupId && p.subjectId === subjectId);
  const classChoices = pairs ? classGroups.filter((c) => pairs.some((p) => p.classGroupId === c.id)) : classGroups;
  const subjectChoices = pairs ? subjects.filter((s) => pairs.some((p) => p.subjectId === s.id)) : subjects;

  const classGroupId =
    typeof query.class === "string" ? query.class : classChoices.length === 1 ? classChoices[0].id : "";
  const subjectId =
    typeof query.subject === "string" ? query.subject : subjectChoices.length === 1 ? subjectChoices[0].id : "";
  const chosen = Boolean(classGroupId && subjectId);
  const allowed = !chosen || mayMark(classGroupId, subjectId);
  const known = classGroups.some((c) => c.id === classGroupId) && subjects.some((s) => s.id === subjectId);

  const sheet =
    chosen && allowed && known
      ? await getMockSheet(mock.id, mock.academicYearId, mock.levelId, classGroupId, subjectId)
      : null;
  const classGroup = classGroups.find((c) => c.id === classGroupId);
  const subject = subjects.find((s) => s.id === subjectId);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={`${mock.title} marks`}
        subtitle={
          sheet ? `${mock.level.name} ${classGroup?.name} · ${subject?.name} · out of 100` : `${mock.level.name} · out of 100 per subject`
        }
        action={
          <Link
            href="/mocks"
            className="rounded-full border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-card transition hover:bg-slate-50"
          >
            All mocks
          </Link>
        }
      />

      {pairs && pairs.length === 0 ? (
        <Alert tone="error">
          You are not assigned any {mock.level.name} subject this year, so there are no mock marks for
          you to enter. Assignments are set on the class page.
        </Alert>
      ) : (
        <Card>
          <form method="get" className="flex flex-wrap items-end gap-3 p-4">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">Class</span>
              <select name="class" defaultValue={classGroupId} className={inputClass}>
                <option value="">Choose…</option>
                {classChoices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {mock.level.name} {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">Subject</span>
              <select name="subject" defaultValue={subjectId} className={inputClass}>
                <option value="">Choose…</option>
                {subjectChoices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass("secondary")}>
              Open sheet
            </button>
          </form>
        </Card>
      )}

      {!allowed ? (
        <Alert tone="error">
          You are not assigned to teach that subject in that class, so its marks are not yours to enter.
        </Alert>
      ) : null}

      {mock.isClosed ? (
        <Alert tone="error">
          {mock.title} is closed, so its marks are final. A head can reopen it if a correction is needed.
        </Alert>
      ) : null}

      {sheet && sheet.students.length === 0 ? (
        <Alert tone="error">
          Nobody is enrolled in {mock.level.name} {classGroup?.name} this year, so there is nobody to mark.
        </Alert>
      ) : null}

      {sheet && sheet.students.length > 0 ? (
        <MockSheetForm
          key={`${classGroupId}:${subjectId}`}
          mockExamId={mock.id}
          classGroupId={classGroupId}
          subjectId={subjectId}
          students={sheet.students.map((s) => ({
            id: s.id,
            firstName: s.firstName,
            lastName: s.lastName,
            admissionNo: s.admissionNo,
          }))}
          scoreFor={sheet.scoreFor}
          bands={sheet.bands}
          locked={mock.isClosed}
        />
      ) : null}
    </div>
  );
}
