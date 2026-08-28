import type { Metadata } from "next";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { getPlatformOverview } from "@/lib/platform-data";
import { logout } from "@/lib/auth-actions";
import { NewSchoolForm } from "./school-form";

export const metadata: Metadata = { title: "Nanicle console" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const PLAN_TONE: Record<string, string> = {
  TRIAL: "bg-amber-50 text-amber-700",
  STARTER: "bg-blue-50 text-blue-700",
  GROWTH: "bg-green-50 text-green-700",
  SCHOOL_PLUS: "bg-slate-900 text-white",
};

export default async function AdminPage() {
  const admin = await requirePlatformAdmin();
  const schools = await getPlatformOverview();

  const onRoll = schools.reduce((total, school) => total + school.onRoll, 0);

  return (
    <main className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Nanicle console</p>
            <p className="text-xs text-slate-500">
              {schools.length} school{schools.length === 1 ? "" : "s"} · {onRoll} children on roll
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">{admin.email ?? admin.name}</span>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Schools</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Every tenant on the platform. This console sits outside them all.
            </p>
          </div>
          <NewSchoolForm />
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">School</th>
                  <th className="px-4 py-2.5 font-medium">Proprietor</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">On roll</th>
                  <th className="px-4 py-2.5 font-medium">Staff</th>
                  <th className="px-4 py-2.5 font-medium">Logins</th>
                  <th className="px-4 py-2.5 font-medium">Since</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {schools.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">
                      No schools yet.
                    </td>
                  </tr>
                ) : (
                  schools.map((school) => (
                    <tr key={school.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className="font-medium text-slate-900">{school.name}</span>
                        <span className="ml-2 font-mono text-xs text-slate-400">{school.slug}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {school.owner ? (
                          <>
                            {school.owner.name}
                            <span className="ml-2 text-xs text-slate-400">
                              {school.owner.email}
                            </span>
                          </>
                        ) : (
                          <span className="text-amber-600">no proprietor</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            PLAN_TONE[school.plan] ?? "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {school.plan.toLowerCase()}
                        </span>
                        <span className="ml-2 text-xs text-slate-400">
                          {school.subscriptionStatus.toLowerCase()}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {school.onRoll}
                        {school.studentCap ? (
                          <span className="text-xs text-slate-400"> / {school.studentCap}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {school._count.staff}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {school._count.memberships}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {dateFmt.format(school.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-slate-400">
          A newly provisioned school arrives with the GES curriculum — KG 1 to JHS 3 and the
          subjects each level offers — plus a grading scale, the standard fee items and expense
          headings, and the assessment components. What it does not have is an academic year, its
          classes or a single child; those are set up from inside the school, starting under
          Settings.
        </p>
      </div>
    </main>
  );
}
