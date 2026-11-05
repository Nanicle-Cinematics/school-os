import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { LIBRARY, LIBRARY_POLICY, canAccess } from "@/lib/permissions";
import { getLibraryPolicy } from "@/lib/library-data";
import { Card, PageHeader } from "../../ui";
import { PolicyForm } from "../forms";
import { LibraryNav } from "../library-nav";

export const metadata: Metadata = { title: "Rules · Library · School OS" };
export const dynamic = "force-dynamic";

export default async function LibrarySettingsPage() {
  const auth = await requireRole(LIBRARY);
  const policy = await getLibraryPolicy(auth.schoolId);
  const canEdit = canAccess(auth.roles, LIBRARY_POLICY);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Library rules" subtitle="How long a book goes out for, and how many one person may hold." />
      <LibraryNav current="/library/settings" />

      {canEdit ? (
        <Card title="Loan rules">
          <PolicyForm policy={policy} />
        </Card>
      ) : (
        <Card title="Loan rules">
          <dl className="divide-y divide-hairline text-sm">
            <div className="flex justify-between px-4.5 py-3">
              <dt className="text-slate-600">A pupil may keep a book for</dt>
              <dd className="font-semibold text-slate-900">{policy.pupilDays} days</dd>
            </div>
            <div className="flex justify-between px-4.5 py-3">
              <dt className="text-slate-600">A member of staff may keep a book for</dt>
              <dd className="font-semibold text-slate-900">{policy.staffDays} days</dd>
            </div>
            <div className="flex justify-between px-4.5 py-3">
              <dt className="text-slate-600">A pupil may hold</dt>
              <dd className="font-semibold text-slate-900">{policy.pupilMax} books</dd>
            </div>
            <div className="flex justify-between px-4.5 py-3">
              <dt className="text-slate-600">A member of staff may hold</dt>
              <dd className="font-semibold text-slate-900">{policy.staffMax} books</dd>
            </div>
            <div className="flex justify-between px-4.5 py-3">
              <dt className="text-slate-600">With an overdue book</dt>
              <dd className="font-semibold text-slate-900">{policy.blockOverdue ? "cannot borrow another" : "can still borrow"}</dd>
            </div>
          </dl>
          <p className="border-t border-hairline px-4.5 py-3 text-sm text-slate-500">A head teacher or the proprietor changes these.</p>
        </Card>
      )}
    </div>
  );
}
