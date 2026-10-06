import type { Metadata } from "next";
import { DataTable, Row, StatCard, type Column } from "../../primitives";
import { CircleAlert, FileText, GraduationCap, Heart, LineChart } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getStudent, getStudentFormOptions } from "@/lib/student-data";
import { deleteStudent, withdrawStudent } from "@/lib/student-actions";
import { formatCedis } from "@/lib/money";
import { Alert, Card, StatusBadge } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditStudentForm } from "../student-form";
import { EnrolForm } from "./enrol-form";
import { AddNewGuardianForm, LinkExistingGuardianForm } from "./guardian-form";

const COLUMNS_0: Column[] = [
  { label: "Name" },
  { label: "Phone" },
  { label: "Relationship" },
  { label: "Receives" },
];

const COLUMNS_1: Column[] = [
  { label: "Year" },
  { label: "Class" },
  { label: "Enrolment" },
];

const COLUMNS_2: Column[] = [
  { label: "Invoice" },
  { label: "Term" },
  { label: "Total", numeric: true },
  { label: "Paid", numeric: true },
  { label: "Balance", numeric: true },
  { label: "Status" },
];

const COLUMNS_3: Column[] = [
  { label: "Term" },
  { label: "Average", numeric: true },
  { label: "Position" },
  { label: "Aggregate", numeric: true },
  { label: "Status" },
];

export const metadata: Metadata = { title: "Student · School OS" };

const TERM_LABEL: Record<string, string> = {
  FIRST: "First",
  SECOND: "Second",
  THIRD: "Third",
};

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

  const { student, year, enrollments, invoices, termResults, outstanding, availableGuardians } =
    result;
  const { classGroups, houses, programmes } = await getStudentFormOptions();

  const owes = outstanding.greaterThan(0);
  const onRoll = student.status === "ACTIVE";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link
          href="/students"
          className="text-sm text-slate-500 hover:text-slate-900"
        >
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
          {invoices.length > 0 ? (
            <>
              This record cannot be deleted while it has a live invoice (
              {invoices.map((invoice, i) => (
                <span key={invoice.id}>
                  {i > 0 ? ", " : null}
                  <Link href={`/invoices/${invoice.id}`} className="font-mono underline">
                    {invoice.invoiceNo}
                  </Link>
                </span>
              ))}
              ). If it was entered by mistake, ask the bursar to cancel{" "}
              {invoices.length === 1 ? "that invoice" : "those invoices"}, then delete it
              here. Otherwise, withdraw the pupil instead.
            </>
          ) : (
            <>
              This record cannot be deleted while it has a payment on file. If the
              payment was recorded against the wrong pupil, ask the bursar to reverse
              it, then delete the record here.
            </>
          )}
        </Alert>
      ) : null}

      {student.guardians.length === 0 ? (
        <Alert tone="error">
          No guardian is linked, so no bill, result or notice can reach anyone.
          Add one below.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Outstanding"
          value={formatCedis(outstanding)}
          caption={owes ? "across all terms" : "fully paid"}
          icon={CircleAlert}
          severity={Number(outstanding) > 0 ? "blocking" : "done"}
        />
        <StatCard
          label="Invoices"
          value={String(invoices.length)}
          caption="most recent 12"
          icon={FileText}
        />
        <StatCard
          label="Results"
          value={String(termResults.length)}
          caption={
            termResults.length > 0 ? "term results computed" : "none yet"
          }
          icon={LineChart}
        />
      </div>

      <Card title="Guardians">
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS_0}
            empty={{ icon: Heart, title: "No guardian on file for this pupil.", action: undefined }}
          >
            {student.guardians.map((link) => (
                  <Row key={link.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      <Link
                        href={`/guardians/${link.guardian.id}`}
                        className="hover:underline"
                      >
                        {link.guardian.firstName} {link.guardian.lastName}
                      </Link>
                      {link.isPrimary ? (
                        <span className="ml-2 rounded bg-brand-600 px-1.5 py-0.5 text-xs font-medium text-white">
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
                      {[
                        link.receivesBills ? "bills" : null,
                        link.receivesReports ? "results" : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </td>
                  </Row>
                ))
              }
          </DataTable>
        </div>
      </Card>

      <Card title="Link an existing guardian">
        <LinkExistingGuardianForm studentId={student.id} guardians={availableGuardians} />
      </Card>

      <Card title="Add a new guardian">
        <AddNewGuardianForm studentId={student.id} />
      </Card>

      <Card title="Class placement">
        <EnrolForm
          studentId={student.id}
          classGroups={classGroups}
          currentClassGroupId={student.currentClassGroupId}
          yearName={year?.name ?? null}
        />
        <div className="overflow-x-auto border-t border-slate-100">
          <DataTable
            columns={COLUMNS_1}
            empty={{ icon: GraduationCap, title: "No enrolment history yet.", action: undefined }}
          >
            {enrollments.map((enrollment) => (
                  <Row key={enrollment.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      {enrollment.academicYear.name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      <Link
                        href={`/classes/${enrollment.classGroup.id}`}
                        className="hover:underline"
                      >
                        {enrollment.classGroup.level.name}{" "}
                        {enrollment.classGroup.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {enrollment.status.toLowerCase()}
                    </td>
                  </Row>
                ))
              }
          </DataTable>
        </div>
      </Card>

      <Card title="Fees">
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS_2}
            empty={{ icon: FileText, title: "No invoices for this pupil yet.", action: undefined }}
          >
            {invoices.map((invoice) => (
                  <Row key={invoice.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500">
                      <Link
                        href={`/invoices/${invoice.id}`}
                        className="hover:underline"
                      >
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
                          ? "font-medium text-danger-ink"
                          : "text-slate-600"
                      }`}
                    >
                      {formatCedis(invoice.balance)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <StatusBadge status={invoice.status} />
                    </td>
                  </Row>
                ))
              }
          </DataTable>
        </div>
      </Card>

      <Card title="Results">
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS_3}
            empty={{ icon: LineChart, title: "No published results for this pupil yet.", action: undefined }}
          >
            {termResults.map((termResult) => (
                  <Row key={termResult.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      <Link
                        href={`/results/${student.id}?term=${termResult.term.id}`}
                        className="hover:underline"
                      >
                        {TERM_LABEL[termResult.term.name] ??
                          termResult.term.name}{" "}
                        · {termResult.term.academicYear.name}
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
                  </Row>
                ))
              }
          </DataTable>
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
          <form
            action={withdrawStudent}
            className="flex flex-wrap items-center gap-3"
          >
            <input type="hidden" name="studentId" value={student.id} />
            <select
              name="status"
              defaultValue="WITHDRAWN"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
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

          <form
            action={deleteStudent}
            className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4"
          >
            <input type="hidden" name="studentId" value={student.id} />
            <SubmitButton variant="danger" pendingLabel="Removing…">
              Delete record
            </SubmitButton>
            <p className="text-xs text-slate-500">
              {invoices.length > 0
                ? "Blocked while an invoice is live — the bursar cancels it first."
                : "For a mistaken entry, such as a duplicate. Removes them from their class as well."}
            </p>
          </form>
        </div>
      </Card>
    </div>
  );
}
