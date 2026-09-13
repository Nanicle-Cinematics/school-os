import type { Metadata } from "next";
import { DataTable, Row, StatCard, type Column } from "../(app)/primitives";
import { CircleAlert, CircleCheck, Home, TrendingUp } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import Link from "next/link";
import { getPlatformOverview, getPlatformTotals } from "@/lib/platform-data";
import { formatCedis } from "@/lib/money";
import { logout } from "@/lib/auth-actions";
import { NewSchoolForm } from "./school-form";

const COLUMNS: Column[] = [
  { label: "" },
  { label: "School" },
  { label: "Proprietor" },
  { label: "Plan" },
  { label: "On roll", numeric: true },
  { label: "Staff", numeric: true },
  { label: "Logins", numeric: true },
  { label: "Since" },
];

export const metadata: Metadata = { title: "Nanicle console" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const PLAN_TONE: Record<string, string> = {
  TRIAL: "bg-amber-50 text-amber-700",
  STANDARD: "bg-green-50 text-green-700",
  INSTITUTION_PLUS: "bg-brand-600 text-white",
};

/* The console had its OWN Stat — a second one, with its own tones and its own labels, so the platform screens drifted from the school screens by
   construction. Gone; it uses the shared StatCard like everything else. */

export default async function AdminPage() {
  const admin = await requirePlatformAdmin();
  const schools = await getPlatformOverview();
  const totals = await getPlatformTotals();

  const onRoll = schools.reduce((total, school) => total + school.onRoll, 0);
  const needsAttention =
    (totals.byStatus.PAST_DUE ?? 0) + (totals.byStatus.SUSPENDED ?? 0);

  return (
    <main className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Nanicle console
            </p>
            <p className="text-xs text-slate-500">
              {schools.length} school{schools.length === 1 ? "" : "s"} ·{" "}
              {onRoll} children on roll
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500">
              {admin.email ?? admin.name}
            </span>
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
        {/* The business in four numbers. Ordered by what a Monday morning asks:
            how many schools, how many children behind them, who has stopped
            paying, and what the texts are costing. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Schools"
            value={String(totals.schools)}
            caption={`${totals.pupils} children on roll`}
            icon={Home}
          />
          <StatCard
            label="Paying"
            value={String(totals.byStatus.ACTIVE ?? 0)}
            caption={`${totals.byStatus.TRIALING ?? 0} on trial`}
            icon={CircleCheck}
            severity="done"
          />
          <StatCard
            label="Needs chasing"
            value={String(needsAttention)}
            caption="Past due or suspended"
            icon={CircleAlert}
            severity={needsAttention > 0 ? "blocking" : "done"}
          />
          <StatCard
            label="Monthly revenue"
            value={formatCedis(totals.mrr)}
            /* SMS spend rides along here rather than in its own card, but it
               ALWAYS rides: it is the cost that scales with use, and hiding it
               in one branch of a conditional meant a platform with no priced
               schools could not see what it was spending. The onboarding walk
               asserts the phrase for exactly that reason. */
            caption={
              totals.unpriced > 0
                ? `${totals.unpriced} paying school${
                    totals.unpriced === 1 ? "" : "s"
                  } with no fee set · SMS spend ${formatCedis(totals.smsCost)}`
                : `${totals.byStatus.ACTIVE ?? 0} paying · SMS spend ${formatCedis(totals.smsCost)}`
            }
            icon={TrendingUp}
          />
        </div>

        {/* The morning's work: who owes now, and who owes this week. Overdue
            first, because a school past its date is losing access on a clock. */}
        {totals.dueSoon.length > 0 ? (
          <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
            <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
              Due this week
            </p>
            <ul className="divide-y divide-slate-100">
              {totals.dueSoon.map((school) => (
                <li
                  key={school.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/admin/${school.id}`}
                      className="text-sm font-medium text-slate-900 hover:underline"
                    >
                      {school.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {school.overdueDays > 0
                        ? `${school.overdueDays} day${school.overdueDays === 1 ? "" : "s"} overdue`
                        : school.paidUntil
                          ? `due ${dateFmt.format(school.paidUntil)}`
                          : "no date set"}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-sm font-semibold tabular-nums ${
                      school.overdueDays > 0
                        ? "text-accent-600"
                        : "text-slate-900"
                    }`}
                  >
                    {school.monthlyFee > 0
                      ? formatCedis(school.monthlyFee)
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {totals.trialsEndingSoon.length > 0 ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-700">
              {totals.trialsEndingSoon.length} trial
              {totals.trialsEndingSoon.length === 1 ? "" : "s"} ending within
              the week
            </p>
            <ul className="mt-1 space-y-0.5">
              {totals.trialsEndingSoon.map((school) => (
                <li key={school.id} className="text-sm text-amber-700">
                  <Link
                    href={`/admin/${school.id}`}
                    className="font-medium underline"
                  >
                    {school.name}
                  </Link>
                  {" — "}
                  {school.trialEndsAt ? dateFmt.format(school.trialEndsAt) : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Schools</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Every tenant on the platform. This console sits outside them all.
            </p>
          </div>
          <NewSchoolForm />
        </div>
          <DataTable
            columns={COLUMNS}
            empty={{ icon: Home, title: "No schools provisioned yet.", action: undefined }}
          >
            {schools.map((school) => (

                    <Row key={school.id}>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <Link
                          href={`/admin/${school.id}`}
                          className="font-medium text-slate-900 hover:text-brand-ink hover:underline"
                        >
                          {school.name}
                        </Link>
                        <span className="ml-2 font-mono text-xs text-slate-400">
                          {school.slug}
                        </span>
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
                            PLAN_TONE[school.plan] ??
                            "bg-slate-100 text-slate-500"
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
                          <span className="text-xs text-slate-400">
                            {" "}
                            / {school.studentCap}
                          </span>
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
                    </Row>
            ))}
          </DataTable>

        <p className="text-xs text-slate-400">
          A newly provisioned school arrives with the GES curriculum — KG 1 to
          JHS 3 and the subjects each level offers — plus a grading scale, the
          standard fee items and expense headings, and the assessment
          components. What it does not have is an academic year, its classes or
          a single child; those are set up from inside the school, starting
          under Settings.
        </p>
      </div>
    </main>
  );
}
