import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getBillSchool } from "@/lib/invoice-data";
import { paperWatermark } from "@/lib/paper";
import { PrintButton } from "../../print-button";
import { BillLetterhead } from "../../bill-letterhead";
import { Choice, Grid, Line, Section, Signatures } from "../../enrolment-paper";

export const metadata: Metadata = { title: "Staff enrolment form · School OS" };

/**
 * A blank form for a new member of staff to fill in by hand, on the school's letterhead. The office keys it into
 * Add staff, so it asks for what that screen stores. Nothing is saved here.
 */
export default async function StaffEnrolmentFormPage() {
  const auth = await requireRole(OFFICE);
  const school = await getBillSchool(auth.schoolId);
  if (!school) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/staff" className="text-sm text-slate-500 hover:text-slate-900">
          ← Staff
        </Link>
        <PrintButton label="Print form" />
      </div>

      <article className="paper rounded-xl border border-slate-200 bg-white p-6 print:border-0 print:p-0" style={paperWatermark(auth.schoolCrestUrl)}>
        <BillLetterhead school={school}>
          <p className="mt-2 text-sm font-semibold tracking-wide text-brand-800">Staff enrolment form</p>
        </BillLetterhead>

        <Section title="Personal details">
          <Grid>
            <Line label="Surname" />
            <Line label="First name" />
            <Line label="Middle name" />
            <Line label="Date of birth" />
            <Line label="Phone" />
            <Line label="Email" />
          </Grid>
          <Choice label="Gender" options={["Male", "Female"]} />
          <Line label="Home address" />
        </Section>

        <Section title="The post">
          <Grid>
            <Line label="Designation" />
            <Line label="Qualification" />
            <Line label="Date of joining" />
            <Choice label="Teaching staff" options={["Yes", "No"]} />
          </Grid>
          <Choice label="Employment" options={["Full time", "Part time", "Contract", "National service", "Volunteer"]} />
        </Section>

        <Section title="Statutory numbers">
          <Grid>
            <Line label="SSNIT no." />
            <Line label="TIN" />
          </Grid>
        </Section>

        <Section title="Emergency contact">
          <Grid>
            <Line label="Full name" />
            <Line label="Relationship" />
            <Line label="Phone" />
          </Grid>
        </Section>

        <Signatures signer="Signature" office={["Staff no.", "Entered by"]} />
      </article>
    </div>
  );
}
