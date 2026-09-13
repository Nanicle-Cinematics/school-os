import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getSubjectList } from "@/lib/subject-data";
import { PageHeader } from "../ui";
import { BookOpen } from "lucide-react";
import { DataTable, Row, type Column } from "../primitives";
import { NewSubjectForm } from "./subject-form";

export const metadata: Metadata = { title: "Subjects · School OS" };

const COLUMNS: Column[] = [
  { label: "Code" },
  { label: "Subject" },
  { label: "Type" },
  { label: "Offered at" },
  { label: "Assessments", numeric: true },
];

export default async function SubjectsPage() {
  const auth = await requireRole(OFFICE);
  const { subjects, levelCount } = await getSubjectList();
  const canEdit = OFFICE.some((role) => auth.roles.includes(role));

  const nextOrder = subjects.reduce((max, subject) => Math.max(max, subject.order), 0) + 10;
  const core = subjects.filter((subject) => subject.isCore).length;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Subjects"
        subtitle={
          subjects.length === 0
            ? "No subjects yet."
            : `${subjects.length} subjects · ${core} core, ${subjects.length - core} elective`
        }
        action={canEdit ? <NewSubjectForm nextOrder={nextOrder} /> : undefined}
      />
          <DataTable
            columns={COLUMNS}
            empty={{ icon: BookOpen, title: "No subjects yet. Every school starts on the GES list; add one the school teaches beyond it.", action: undefined }}
          >
            {subjects.map((subject) => (
                  <Row key={subject.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                      {subject.code}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                      {canEdit ? (
                        <Link href={`/subjects/${subject.id}`} className="hover:underline">
                          {subject.name}
                        </Link>
                      ) : (
                        subject.name
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          subject.isCore
                            ? "bg-brand-600 text-white"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {subject.isCore ? "core" : "elective"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {subject.levelSubjects.length === 0 ? (
                        <span className="text-warning-ink">no levels</span>
                      ) : subject.levelSubjects.length === levelCount ? (
                        "All levels"
                      ) : (
                        subject.levelSubjects.map((row) => row.level.code).join(", ")
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                      {subject._count.assessments}
                    </td>
                  </Row>
                ))
              }
          </DataTable>

      <p className="text-xs text-slate-400">
        A subject with no levels never appears in score entry — that is the usual reason a teacher
        cannot find their subject.
      </p>
    </div>
  );
}
