import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth, requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getCumulativeRecord } from "@/lib/cumulative-data";
import { getBillSchool } from "@/lib/invoice-data";
import { PrintButton } from "../../../print-button";
import { Alert } from "../../../ui";
import { CumulativeRecordSheet } from "../../cumulative-record";

export const metadata: Metadata = { title: "Cumulative record · School OS" };

/**
 * One pupil's JHS 1 to JHS 3 results on one sheet, ready to print.
 *
 * Leadership only, like the earlier-year records it draws on: those are the
 * school's own office record and are not published to parents.
 */
export default async function CumulativeRecordPage({ params }: PageProps<"/results/[studentId]/cumulative">) {
  await requireRole(LEADERSHIP);
  const auth = await requireAuth();
  const { studentId } = await params;

  const data = await getCumulativeRecord(studentId);
  if (!data) {
    notFound();
  }
  const school = await getBillSchool(auth.schoolId);
  if (!school) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/students/${data.student.id}`} className="text-sm text-slate-500 hover:text-slate-900">
          ← {data.student.firstName} {data.student.lastName}
        </Link>
        {data.jhs ? <PrintButton label="Print record" /> : null}
      </div>

      {data.jhs ? (
        <CumulativeRecordSheet
          school={school}
          student={data.student}
          record={data.record}
          showClassPosition={data.showClassPosition}
          headSignatureUrl={auth.headSignatureUrl}
          headName={auth.headName}
          printedOn={new Date()}
        />
      ) : (
        <Alert tone="error">
          {data.student.firstName} {data.student.lastName} has not been in a JHS class, so there is no
          JHS record to print yet.
        </Alert>
      )}
    </div>
  );
}
