import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getGuardian } from "@/lib/guardian-data";
import { deleteGuardian, unlinkStudent } from "@/lib/guardian-actions";
import { Alert, Card, EmptyRow, tableHeadClass, thClass } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { EditGuardianForm } from "../guardian-form";
import { LinkStudentForm } from "./link-form";
import { GuardianLoginForm } from "./login-form";

export const metadata: Metadata = { title: "Guardian · School OS" };

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${
        on ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-400"
      }`}
    >
      {label}
    </span>
  );
}

export default async function GuardianDetailPage({
  params,
  searchParams,
}: PageProps<"/guardians/[id]">) {
  await requireRole(OFFICE);
  const { id } = await params;
  const query = await searchParams;
  const result = await getGuardian(id);

  if (!result) {
    notFound();
  }

  const { guardian, students, hasLogin } = result;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/guardians" className="text-sm text-slate-500 hover:text-slate-900">
          ← Guardians
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {guardian.firstName} {guardian.lastName}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {guardian.phone} · {guardian.students.length} child
          {guardian.students.length === 1 ? "" : "ren"} · {guardian._count.payments} payments
        </p>
      </div>

      {query.error === "has-payments" ? (
        <Alert tone="error">
          This guardian has paid fees, so their record is kept — a receipt has to keep naming who
          paid. Unlink their children instead if they are no longer involved.
        </Alert>
      ) : null}

      <Card title="Children">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Student</th>
                <th className={thClass}>Class</th>
                <th className={thClass}>Relationship</th>
                <th className={thClass}>Receives</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {guardian.students.length === 0 ? (
                <EmptyRow colSpan={5}>No children linked yet.</EmptyRow>
              ) : (
                guardian.students.map((link) => (
                  <tr key={link.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-900">
                      <Link href={`/students/${link.student.id}`} className="hover:underline">
                        {link.student.lastName}, {link.student.firstName}
                      </Link>
                      <span className="ml-2 font-mono text-xs font-normal text-slate-400">
                        {link.student.admissionNo}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {link.student.currentClassGroup
                        ? `${link.student.currentClassGroup.level.name} ${link.student.currentClassGroup.name}`
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {link.relationship.toLowerCase()}
                      {link.isPrimary ? (
                        <span className="ml-2 rounded bg-brand-600 px-1.5 py-0.5 text-xs font-medium text-white">
                          primary
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <div className="flex gap-1.5">
                        <Flag on={link.receivesBills} label="bills" />
                        <Flag on={link.receivesReports} label="results" />
                        {link.isEmergencyContact ? <Flag on label="emergency" /> : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <form action={unlinkStudent}>
                        <input type="hidden" name="guardianId" value={guardian.id} />
                        <input type="hidden" name="linkId" value={link.id} />
                        <SubmitButton variant="secondary" pendingLabel="…">
                          Unlink
                        </SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Parent portal">
        <GuardianLoginForm
          guardianId={guardian.id}
          phone={guardian.phone}
          email={guardian.email}
          hasLogin={hasLogin}
          childCount={guardian.students.length}
        />
      </Card>

      <Card title="Link another child">
        <LinkStudentForm guardianId={guardian.id} students={students} />
      </Card>

      <Card title="Details">
        <EditGuardianForm
          values={{
            id: guardian.id,
            firstName: guardian.firstName,
            lastName: guardian.lastName,
            phone: guardian.phone,
            altPhone: guardian.altPhone,
            email: guardian.email,
            occupation: guardian.occupation,
            address: guardian.address,
            gpsAddress: guardian.gpsAddress,
            idType: guardian.idType,
            idNumber: guardian.idNumber,
          }}
        />
      </Card>

      <Card title="Danger zone">
        <form action={deleteGuardian} className="flex flex-wrap items-center gap-3 p-4">
          <input type="hidden" name="id" value={guardian.id} />
          <SubmitButton variant="danger" pendingLabel="Removing…">
            Remove guardian
          </SubmitButton>
          <p className="text-xs text-slate-500">
            {guardian._count.payments > 0
              ? "Blocked — this guardian has paid fees."
              : "Hides them from lists and SMS. Nothing is erased."}
          </p>
        </form>
      </Card>
    </div>
  );
}
