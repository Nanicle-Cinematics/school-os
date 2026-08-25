import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getStudent, getStudentFormOptions } from "@/lib/student-data";
import { deleteStudent, withdrawStudent } from "@/lib/student-actions";
import { formatCedis } from "@/lib/money";
import { Alert, Card, EmptyRow, Stat, StatusBadge, tableHeadClass, thClass } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditStudentForm } from "../student-form";
import { EnrolForm } from "./enrol-form";

export const metadata: Metadata = { title: "Student · School OS" };

const TERM_LABEL: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export default async function StudentDetailPage({
  params,
  searchParams,
}: PageProps<"/students/[id]">) {
  await requireRole(OFFICE);
  const { id } = await params;
  const query = await searchParams;

  const result = await getStudent(id);
  if (!result) {
    notFound();
  }

  const { student, year, enrollments, invoices, termResults, outstanding } = result;
  const { classGroups, houses, programmes } = await getStudentFormOptions();

  const owes = outstanding.greaterThan(0);
  const onRoll = student.status === "ACTIVE";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/students" className="text-sm text-slate-500 hover:text-slate-900">
          ← Students
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {student.lastName}, {student.firstName} {student.middleName ?? ""}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {student.admissionNo} ·{" "}
          {student.currentClassGroup
            ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
            : "not placed in a class"}{" "}
          · {student.status.toLowerCase()}
        </p>
      </div>

      {query.error === "has-money" ? (
        <Alert tone="error">
          This student has invoices or payments on file, so the record cannot be removed — deleting
          it would take the money records with it. Withdraw them instead.
        </Alert>
      ) : null}

      {student.guardians.length === 0 ? (
        <Alert tone="error">
          No guardian is linked, so no bill, result or notice can reach anyone. Link one from the
          guardian&rsquo;s page.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Outstanding"
          value={formatCedis(outstanding)}
          tone={owes ? "negative" : "positive"}
          sub={owes ? "across all terms" : "fully paid"}
        />
        <Stat label="Invoices" value={String(invoices.length)} sub="most recent 12" />
        <Stat
          label="Results"
          value={String(termResults.length)}
          sub={termResults.length > 0 ? "term results computed" : "none yet"}
        />
      </div>

      <Card title="Guardians">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Phone</th>
                <th className={thClass}>Relationship</th>
                <th className={thClass}>Receives</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {student.guardians.length === 0 ? (
                <EmptyRow colSpan={4}>Nobody linked.</EmptyRow>
              ) : (
                student.guardians.map((link) => (
                  <tr key={link.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      <Link href={`/guardians/${link.guardian.id}`} className="hover:underline">
                        {link.guardian.firstName} {link.guardian.lastName}
                      </Link>
                      {link.isPrimary ? (
                        <span className="ml-2 rounded bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white">
                          primary
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
                      {link.guardian.phone}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {link.relationship.toLowerCase()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {[link.receivesBills ? "bills" : null, link.receivesReports ? "results" : null]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Class placement">
        <EnrolForm
          studentId={student.id}
          classGroups={classGroups}
          currentClassGroupId={student.currentClassGroupId}
          yearName={year?.name ?? null}
        />
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Year</th>
                <th className={thClass}>Class</th>
                <th className={thClass}>Enrolment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {enrollments.length === 0 ? (
                <EmptyRow colSpan={3}>Never enrolled.</EmptyRow>
              ) : (
                enrollments.map((enrollment) => (
                  <tr key={enrollment.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      {enrollment.academicYear.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      <Link
                        href={`/classes/${enrollment.classGroup.id}`}
                        className="hover:underline"
                      >
                        {enrollment.classGroup.level.name} {enrollment.classGroup.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {enrollment.status.toLowerCase()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Fees">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Invoice</th>
                <th className={thClass}>Term</th>
                <th className={thClass}>Total</th>
                <th className={thClass}>Paid</th>
                <th className={thClass}>Balance</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.length === 0 ? (
                <EmptyRow colSpan={6}>No invoices raised for this student.</EmptyRow>
              ) : (
                invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
                      <Link href={`/invoices/${invoice.id}`} className="hover:underline">
                        {invoice.invoiceNo}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {TERM_LABEL[invoice.term.name] ?? invoice.term.name} ·{" "}
                      {invoice.term.academicYear.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-600">
                      {formatCedis(invoice.total)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-600">
                      {formatCedis(invoice.amountPaid)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-2 tabular-nums ${
                        invoice.balance.greaterThan(0)
                          ? "font-medium text-red-600"
                          : "text-slate-600"
                      }`}
                    >
                      {formatCedis(invoice.balance)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <StatusBadge status={invoice.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Results">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Term</th>
                <th className={thClass}>Average</th>
                <th className={thClass}>Position</th>
                <th className={thClass}>Aggregate</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {termResults.length === 0 ? (
                <EmptyRow colSpan={5}>No term results computed yet.</EmptyRow>
              ) : (
                termResults.map((termResult) => (
                  <tr key={termResult.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      <Link
                        href={`/results/${student.id}?term=${termResult.term.id}`}
                        className="hover:underline"
                      >
                        {TERM_LABEL[termResult.term.name] ?? termResult.term.name} ·{" "}
                        {termResult.term.academicYear.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-600">
                      {termResult.average ? termResult.average.toString() : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-600">
                      {termResult.classPosition
                        ? `${termResult.classPosition} of ${termResult.classSize ?? "?"}`
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-slate-600">
                      {termResult.aggregate ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <StatusBadge status={termResult.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Details">
        <EditStudentForm
          houses={houses}
          programmes={programmes}
          values={{
            id: student.id,
            firstName: student.firstName,
            middleName: student.middleName,
            lastName: student.lastName,
            gender: student.gender,
            dateOfBirth: student.dateOfBirth,
            nationality: student.nationality,
            hometown: student.hometown,
            religion: student.religion,
            language: student.language,
            bloodGroup: student.bloodGroup,
            allergies: student.allergies,
            medicalNotes: student.medicalNotes,
            specialNeeds: student.specialNeeds,
            previousSchool: student.previousSchool,
            residency: student.residency,
            status: student.status,
            admissionDate: student.admissionDate,
            houseId: student.houseId,
            programmeId: student.programmeId,
          }}
        />
      </Card>

      <Card title="Leaving the school">
        <div className="space-y-4 p-4">
          <form action={withdrawStudent} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="studentId" value={student.id} />
            <select
              name="status"
              defaultValue="WITHDRAWN"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
            >
              <option value="WITHDRAWN">Withdrawn</option>
              <option value="TRANSFERRED">Transferred</option>
              <option value="GRADUATED">Graduated</option>
            </select>
            <SubmitButton variant="secondary" pendingLabel="Updating…">
              Take off the roll
            </SubmitButton>
            <p className="text-xs text-slate-500">
              {onRoll
                ? "Clears their class and closes the enrolment. Fees, payments and results all stay."
                : `Already ${student.status.toLowerCase()}.`}
            </p>
          </form>

          <form action={deleteStudent} className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <input type="hidden" name="studentId" value={student.id} />
            <SubmitButton variant="danger" pendingLabel="Removing…">
              Delete record
            </SubmitButton>
            <p className="text-xs text-slate-500">
              {invoices.length > 0
                ? "Blocked — this student has been invoiced."
                : "Only possible for a student who was never billed, e.g. a mistaken entry."}
            </p>
          </form>
        </div>
      </Card>
    </div>
  );
}
