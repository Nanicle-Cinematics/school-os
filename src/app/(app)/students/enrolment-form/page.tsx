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

export const metadata: Metadata = { title: "Student enrolment form · School OS" };

/**
 * A blank form for a parent to fill in by hand, on the school's letterhead. The office keys it into Admit student, so it
 * asks for what that screen stores: the pupil, health, and up to two parents or guardians. Nothing is saved here.
 */
export default async function StudentEnrolmentFormPage() {
  const auth = await requireRole(OFFICE);
  const school = await getBillSchool(auth.schoolId);
  if (!school) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/students" className="text-sm text-slate-500 hover:text-slate-900">
          ← Students
        </Link>
        <PrintButton label="Print form" />
      </div>

      <article className="paper rounded-xl border border-slate-200 bg-white p-6 print:border-0 print:p-0" style={paperWatermark(auth.schoolCrestUrl)}>
        <BillLetterhead school={school}>
          <p className="mt-2 text-sm font-semibold tracking-wide text-brand-800">Student enrolment form</p>
        </BillLetterhead>

        <Section title="The pupil">
          <Grid>
            <Line label="Surname" />
            <Line label="First name" />
            <Line label="Middle name" />
            <Line label="Date of birth" />
          </Grid>
          <Choice label="Gender" options={["Male", "Female"]} />
          <Grid>
            <Line label="Class applying for" />
            <Choice label="" options={["Day", "Boarding"]} />
            <Line label="Nationality" />
            <Line label="Hometown" />
            <Line label="Religion" />
            <Line label="First language" />
          </Grid>
          <Line label="Previous school" />
        </Section>

        <Section title="Health">
          <Grid>
            <Line label="Blood group" />
            <Line label="Allergies" />
          </Grid>
          <Line label="Special needs or medical conditions" />
        </Section>

        <Section title="Parent or guardian">
          <Grid>
            <Line label="Full name" />
            <Choice label="" options={["Father", "Mother", "Guardian"]} />
            <Line label="Phone" />
            <Line label="Other phone" />
            <Line label="Occupation" />
            <Line label="Email" />
          </Grid>
          <Line label="Address" />
          <Choice label="Send bills and reports to this person" options={["Yes", "No"]} />
        </Section>

        <Section title="Second parent, guardian or emergency contact">
          <Grid>
            <Line label="Full name" />
            <Choice label="" options={["Father", "Mother", "Guardian"]} />
            <Line label="Phone" />
            <Line label="Occupation" />
          </Grid>
        </Section>

        <Signatures signer="Parent or guardian's signature" office={["Admission no.", "Class", "Date admitted", "Entered by"]} />
      </article>
    </div>
  );
}
