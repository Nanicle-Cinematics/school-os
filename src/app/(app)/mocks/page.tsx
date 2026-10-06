import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { ACADEMIC, MARKING, canAccess } from "@/lib/permissions";
import { getMockOverview, getMockSheetOptions } from "@/lib/mock-data";
import { setMockClosed } from "@/lib/mock-actions";
import { PageHeader, Card, StatusBadge } from "../ui";
import { DataTable, Row, type Column } from "../primitives";
import { SubmitButton } from "../submit-button";
import { CreateMockForm } from "./create-mock";
import { DeleteMockForm } from "./delete-mock";

export const metadata: Metadata = { title: "Mock exams · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

const COLUMNS: Column[] = [
  { label: "Mock" },
  { label: "Sat on", hideBelow: "sm" },
  { label: "Marks entered", numeric: true },
  { label: "Status" },
  { label: "" },
];

const TEACHER_COLUMNS: Column[] = [{ label: "Mock" }, { label: "Status" }, { label: "" }];

/**
 * Mock examinations for the BECE year.
 *
 * Leadership sets mocks up, closes them and reads the results; a subject
 * teacher sees only the mocks and the sheets for the JHS 3 classes and subjects
 * they are assigned. Nothing here touches a term report card.
 */
export default async function MocksPage() {
  const auth = await requireRole(MARKING);
  const isAcademic = canAccess(auth.roles, ACADEMIC);
  const { level, year, mocks, candidates, subjects } = await getMockOverview();

  if (!level || !year) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            {!level
              ? "Mock exams are for the final JHS class, and this school has no JHS classes set up."
              : "No academic year is marked as current, so there is no year to hold mocks in."}{" "}
            {isAcademic ? (
              <Link href={!level ? "/settings/structure" : "/settings/terms"} className="font-medium text-brand-ink hover:underline">
                {!level ? "Set up the school structure" : "Set up the year"}
              </Link>
            ) : null}
          </p>
        </Card>
      </div>
    );
  }

  const options = await getMockSheetOptions(level.id, year.id, auth.staffId, isAcademic);
  const myPairs = options.pairs;
  const expected = candidates * subjects;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Mock exams"
        subtitle={`${level.name} · ${year.name} · ${candidates} candidates, ${subjects} subjects`}
        action={
          isAcademic && mocks.length > 0 ? (
            <Link
              href="/mocks/progress"
              className="rounded-full border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-card transition hover:bg-slate-50"
            >
              Progress across mocks
            </Link>
          ) : null
        }
      />

      <p className="text-sm text-slate-600">
        Marks are out of 100 per subject and graded on the school&rsquo;s grading scale. The aggregate
        follows the BECE: the four core subjects (English, Mathematics, Science, Social Studies) plus
        the best two of the rest. Mock marks never change a term report card.
      </p>

      {isAcademic ? (
        <Card title="Set up a mock">
          <CreateMockForm suggestion={`Mock ${mocks.length + 1}`} />
        </Card>
      ) : null}

      {isAcademic ? (
        <DataTable
          columns={COLUMNS}
          empty={{ icon: ClipboardList, title: "No mocks set up for this year yet." }}
        >
          {mocks.map((mock) => (
            <Row key={mock.id}>
              <td className="px-4 py-3 font-medium text-slate-900">
                <Link href={`/mocks/${mock.id}`} className="hover:underline">
                  {mock.title}
                </Link>
              </td>
              <td className="hidden px-4 py-3 text-slate-600 sm:table-cell">
                {mock.sittingDate ? dateFmt.format(mock.sittingDate) : "—"}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                {mock._count.scores}
                {expected > 0 ? <span className="text-xs text-slate-400"> / {expected}</span> : null}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={mock.isClosed ? "CLOSED" : "OPEN"} />
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-end gap-3 text-sm">
                  <Link href={`/mocks/${mock.id}`} className="text-slate-600 hover:text-slate-900 hover:underline">
                    Broadsheet
                  </Link>
                  <Link href={`/mocks/${mock.id}/slips`} className="text-slate-600 hover:text-slate-900 hover:underline">
                    Slips
                  </Link>
                  {!mock.isClosed ? (
                    <Link href={`/mocks/${mock.id}/sheet`} className="text-slate-600 hover:text-slate-900 hover:underline">
                      Enter marks
                    </Link>
                  ) : null}
                  <form action={setMockClosed}>
                    <input type="hidden" name="mockExamId" value={mock.id} />
                    <input type="hidden" name="close" value={mock.isClosed ? "0" : "1"} />
                    <SubmitButton variant="secondary" pendingLabel="…">
                      {mock.isClosed ? "Reopen" : "Close"}
                    </SubmitButton>
                  </form>
                  {mock._count.scores === 0 ? <DeleteMockForm mockExamId={mock.id} /> : null}
                </div>
              </td>
            </Row>
          ))}
        </DataTable>
      ) : (
        <DataTable
          columns={TEACHER_COLUMNS}
          empty={{ icon: ClipboardList, title: "No mocks have been set up for this year yet." }}
        >
          {mocks.map((mock) => (
            <Row key={mock.id}>
              <td className="px-4 py-3 font-medium text-slate-900">{mock.title}</td>
              <td className="px-4 py-3">
                <StatusBadge status={mock.isClosed ? "CLOSED" : "OPEN"} />
              </td>
              <td className="px-4 py-3 text-right text-sm">
                {mock.isClosed ? (
                  <span className="text-slate-400">Marks are final</span>
                ) : myPairs && myPairs.length === 0 ? (
                  <span className="text-slate-400">You teach no {level.name} subject</span>
                ) : (
                  <Link href={`/mocks/${mock.id}/sheet`} className="font-medium text-brand-ink hover:underline">
                    Enter marks
                  </Link>
                )}
              </td>
            </Row>
          ))}
        </DataTable>
      )}
    </div>
  );
}
