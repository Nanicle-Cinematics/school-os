import type { Metadata } from "next";
import { buttonClass } from "../../button-style";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { MARKING, LEADERSHIP, canAccess } from "@/lib/permissions";
import { getSheet, getSheetOptions } from "@/lib/sheet-data";
import { PageHeader, Card, Alert, inputClass } from "../../ui";
import { SheetForm } from "./sheet-form";
import { OpenSheetForm } from "./open-sheet";

export const metadata: Metadata = { title: "Mark sheet · School OS" };

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export default async function SheetPage({ searchParams }: PageProps<"/assessments/sheet">) {
  const auth = await requireRole(MARKING);
  const query = await searchParams;
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  const { terms, classGroups, subjects, pairs } = await getSheetOptions({
    staffId: auth.staffId,
    isLeadership,
  });

  const termId =
    typeof query.term === "string" ? query.term : (terms.find((t) => t.isCurrent)?.id ?? "");
  const classGroupId = typeof query.class === "string" ? query.class : "";
  const subjectId = typeof query.subject === "string" ? query.subject : "";
  const chosen = Boolean(termId && classGroupId && subjectId);

  // A teacher may only reach their own pairs. Checked here as well as in the
  // action, so the page never renders a class they cannot save.
  const allowed =
    !pairs ||
    !chosen ||
    pairs.some((p) => p.classGroupId === classGroupId && p.subjectId === subjectId);

  const sheet = chosen && allowed ? await getSheet(termId, classGroupId, subjectId) : null;
  const term = terms.find((t) => t.id === termId);
  const classGroup = classGroups.find((c) => c.id === classGroupId);
  const subject = subjects.find((s) => s.id === subjectId);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Mark sheet"
        subtitle={
          sheet
            ? `${classGroup?.level.name} ${classGroup?.name} · ${subject?.name} · ${
                TERM_NAME[term?.name ?? ""] ?? ""
              } Term`
            : "Every component for a class and subject on one screen."
        }
        action={
          <Link
            href={isLeadership ? "/assessments" : "/results/remarks"}
            className="rounded-full border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-card transition hover:bg-slate-50"
          >
            {isLeadership ? "Single assessments" : "Conduct & remarks"}
          </Link>
        }
      />

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">
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
            <span className="mb-1 block text-xs font-medium text-slate-500">
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

          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">
              Subject
            </span>
            <select name="subject" defaultValue={subjectId} className={inputClass}>
              <option value="">Choose…</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className={buttonClass("primary")}
          >
            Open sheet
          </button>
        </form>
      </Card>

      {!allowed ? (
        <Alert tone="error">
          You are not assigned to teach that subject in that class, so its marks are not yours to
          enter.
        </Alert>
      ) : null}

      {!chosen && allowed ? (
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            Choose a class and subject above. Every component — the class tests, group work, project
            and the exam — appears as one sheet you fill in and save once.
          </p>
        </Card>
      ) : null}

      {sheet && sheet.columns.length === 0 ? (
        <Card title="This sheet has not been opened yet">
          <div className="p-4">
            <p className="text-sm text-slate-600">
              Nothing has been set up to mark for {subject?.name} in {classGroup?.level.name}{" "}
              {classGroup?.name} this term. Opening the sheet creates the school&rsquo;s standard
              components — you can change any component&rsquo;s total marks afterwards.
            </p>
          </div>
        </Card>
      ) : null}

      {sheet && sheet.columns.length > 0 && sheet.students.length === 0 ? (
        <Alert tone="error">
          No active students are placed in {classGroup?.level.name} {classGroup?.name}, so there is
          nobody to mark. Place students in the class first.
        </Alert>
      ) : null}

      {sheet && sheet.students.length > 0 && sheet.columns.length > 0 ? (
        <>
          <SheetForm
            termId={termId}
            classGroupId={classGroupId}
            subjectId={subjectId}
            columns={sheet.columns}
            students={sheet.students}
            scoreFor={Object.fromEntries(sheet.scoreFor)}
            classWeight={sheet.classWeight}
            examWeight={sheet.examWeight}
          />
          <p className="text-xs text-slate-500">
            {sheet.students.length} students ·{" "}
            {sheet.columns.map((c) => `${c.title} (${c.marked} marked)`).join(" · ")}
          </p>
        </>
      ) : null}

      {/* Always rendered once a class and subject are chosen, so the message it
          returns survives the sheet appearing. */}
      {sheet ? (
        <OpenSheetForm
          termId={termId}
          classGroupId={classGroupId}
          subjectId={subjectId}
          label={
            sheet.columns.length === 0
              ? "Open the sheet"
              : "Add any components missing from this sheet"
          }
        />
      ) : null}
    </div>
  );
}
