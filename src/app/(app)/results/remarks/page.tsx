import type { Metadata } from "next";
import { buttonClass } from "../../button-style";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { MARKING, LEADERSHIP, canAccess } from "@/lib/permissions";
import { getClassRemarks, getSheetOptions } from "@/lib/sheet-data";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, Alert, inputClass } from "../../ui";
import { RemarksForm } from "./remarks-form";

export const metadata: Metadata = { title: "Conduct and remarks · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

/** Teaching days between two dates, excluding weekends. A sensible default the
 *  form teacher corrects — the attendance module will replace it later. */
function teachingDays(start: Date, end: Date) {
  let days = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export default async function ClassRemarksPage({ searchParams }: PageProps<"/results/remarks">) {
  const auth = await requireRole(MARKING);
  const query = await searchParams;
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  const { terms, classGroups, pairs } = await getSheetOptions({
    staffId: auth.staffId,
    isLeadership,
  });

  const termId =
    typeof query.term === "string" ? query.term : (terms.find((t) => t.isCurrent)?.id ?? "");
  const classGroupId = typeof query.class === "string" ? query.class : "";
  const chosen = Boolean(termId && classGroupId);

  // Class-level, not subject-level: the form teacher writes the remark and may
  // not teach every subject in their own class.
  const allowed =
    !pairs || !chosen || pairs.some((p) => p.classGroupId === classGroupId);

  const data = chosen && allowed ? await getClassRemarks(termId, classGroupId) : null;
  const term = terms.find((t) => t.id === termId);
  const classGroup = classGroups.find((c) => c.id === classGroupId);

  const termRow = chosen
    ? await prisma.term.findUnique({
        where: { id: termId },
        select: { startDate: true, endDate: true },
      })
    : null;
  const daysInTerm =
    termRow?.startDate && termRow?.endDate
      ? teachingDays(termRow.startDate, termRow.endDate)
      : null;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Conduct, interest and remarks"
        subtitle={
          data
            ? `${classGroup?.level.name} ${classGroup?.name} · ${TERM_NAME[term?.name ?? ""] ?? ""} Term · ${data.students.length} students`
            : "Everything on the report card that is not a mark."
        }
        action={
          <Link
            href={isLeadership ? "/results" : "/assessments/sheet"}
            className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            {isLeadership ? "Results" : "Mark sheet"}
          </Link>
        }
      />

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Term
            </span>
            <select name="term" defaultValue={termId} className={inputClass}>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {TERM_NAME[t.name] ?? t.name} Term · {t.academicYear.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Class
            </span>
            <select name="class" defaultValue={classGroupId} className={inputClass}>
              <option value="">Choose…</option>
              {classGroups.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.level.name} {c.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className={buttonClass("primary")}
          >
            Open class
          </button>
        </form>
      </Card>

      {!allowed ? (
        <Alert tone="error">You do not teach in that class.</Alert>
      ) : null}

      {!chosen && allowed ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            Choose a class. Conduct, attitude, interest, attendance and the form teacher&rsquo;s
            remark for every student, on one screen and saved once — fill it in over the term
            rather than in the rush after marking.
          </p>
        </Card>
      ) : null}

      {data && data.students.length === 0 ? (
        <Alert tone="error">
          No active students are placed in {classGroup?.level.name} {classGroup?.name}.
        </Alert>
      ) : null}

      {data && data.published > 0 ? (
        <Alert tone="error">
          {data.published} of these cards are already published. Editing these fields changes what a
          parent has already been shown — unpublish first if that is not what you intend.
        </Alert>
      ) : null}

      {data && data.students.length > 0 ? (
        <RemarksForm
          termId={termId}
          classGroupId={classGroupId}
          students={data.students}
          rows={Object.fromEntries(data.byStudent)}
          daysInTerm={daysInTerm}
        />
      ) : null}
    </div>
  );
}
