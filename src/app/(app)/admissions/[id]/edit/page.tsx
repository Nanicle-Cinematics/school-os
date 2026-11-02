import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { ADMISSIONS } from "@/lib/permissions";
import { getApplicationDetail, getApplyOptions } from "@/lib/admissions-data";
import { Card, PageHeader } from "../../../ui";
import { ApplicationForm } from "../../application-form";

export const metadata: Metadata = { title: "Edit application · School OS" };
export const dynamic = "force-dynamic";

const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "");

export default async function EditApplicationPage({ params }: PageProps<"/admissions/[id]/edit">) {
  const auth = await requireRole(ADMISSIONS);
  const { id } = await params;
  const detail = await getApplicationDetail(auth.schoolId, id);
  if (!detail) notFound();
  const { application } = detail;
  if (application.status === "ADMITTED") redirect(`/admissions/${id}`);

  const { levels, years } = await getApplyOptions();
  // The year the child applied for may have ended since; keep it selectable so an old application can still be opened.
  const yearOptions = years.some((y) => y.id === application.academicYearId)
    ? years
    : [...years, { id: application.academicYearId, name: application.academicYear.name, isCurrent: false, endDate: new Date() }];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title={`Edit ${application.firstName} ${application.lastName}`} subtitle={application.reference} />
      <Card>
        <div className="p-4.5">
          <ApplicationForm
            mode="edit"
            id={id}
            levels={levels}
            years={yearOptions}
            initial={{
              firstName: application.firstName,
              middleName: application.middleName ?? "",
              lastName: application.lastName,
              gender: application.gender,
              dateOfBirth: iso(application.dateOfBirth),
              previousSchool: application.previousSchool ?? "",
              notes: application.notes ?? "",
              guardianName: application.guardianName,
              guardianPhone: application.guardianPhone,
              guardianEmail: application.guardianEmail ?? "",
              guardianRelationship: application.guardianRelationship,
              levelId: application.levelId,
              academicYearId: application.academicYearId,
            }}
          />
        </div>
      </Card>
    </div>
  );
}
