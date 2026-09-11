import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { canAccess, isTeacherOnly, isParentOnly, landingFor, FINANCE } from "@/lib/permissions";
import {
  getActivity,
  getAttention,
  getCollections,
  getDashboard,
  formatCedis,
  type AttentionItem,
} from "@/lib/dashboard-data";
import { CollectionsChart } from "./collections-chart";
import { ActivityFeed } from "./activity-feed";
import { Card, Stat } from "../ui";

export const metadata: Metadata = { title: "Dashboard · School OS" };



const DOT: Record<AttentionItem["kind"], string> = {
  marking: "bg-accent-500",
  fees: "bg-red-500",
  results: "bg-brand-500",
  staffing: "bg-slate-400",
  // Setup items only exist before the school is running, and they are the whole
  // job at that point — the brand dot, not a warning colour.
  setup: "bg-brand-600",
};

/**
 * What needs doing, and the link that does it. Deliberately above the money
 * panels: those report how the term is going, this one changes it.
 */
function Attention({ items }: { items: AttentionItem[] }) {
  return (
    <Card title="Needs your attention">
      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Nothing is waiting on you — marking is up to date, results are published and every
          class has its teachers.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.kind}>
              <Link
                href={item.href}
                className="group flex items-center gap-3.5 px-4 py-3.5 transition hover:bg-slate-50"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[item.kind]}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-extrabold uppercase tracking-[0.12em] text-slate-400">
                    {item.tag}
                  </span>
                  <span className="mt-0.5 block truncate text-sm font-bold text-slate-900">
                    {item.title}
                  </span>
                  <span className="block truncate text-xs text-slate-500">{item.detail}</span>
                </span>
                <span className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11.5px] font-bold text-brand-700 transition group-hover:border-brand-200 group-hover:bg-brand-50">
                  {item.cta}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default async function DashboardPage() {
  const auth = await requireAuth();
  // A class teacher has no business on the school-wide dashboard: it carries
  // collections, outstanding fees and every class's enrolment.
  // This page uses requireAuth rather than requireRole on purpose: a nurse or
  // librarian holds no listed role and still belongs here, and refusing them
  // would bounce them back to /dashboard forever. The cost is that anyone whose
  // home is elsewhere has to be named explicitly — and a parent was not, so the
  // portal's first release rendered the school's attention list, collections and
  // activity feed to any guardian who typed the URL. Caught by verify:parent.
  if (isTeacherOnly(auth.roles) || isParentOnly(auth.roles)) {
    redirect(landingFor(auth.roles));
  }
  const data = await getDashboard(auth.schoolId);
  const showMoney = canAccess(auth.roles, FINANCE);

  // Sequential, not alongside getDashboard: DATABASE_URL pins the pool small and
  // the two fan out into it. The fee counts are handed over rather than re-read.
  const collections = showMoney
    ? await getCollections(
        auth.schoolId,
        data.term
          ? { id: data.term.id, startDate: data.term.startDate, endDate: data.term.endDate }
          : null,
      )
    : null;

  const activity = await getActivity(auth.schoolId);

  const attention = await getAttention(
    auth.schoolId,
    data.term ? { id: data.term.id, academicYearId: data.term.academicYearId } : null,
    { outstanding: data.outstanding, debtorCount: data.debtorCount },
  );

  const firstName = auth.name.split(" ")[0];
  const maxLevel = Math.max(1, ...data.enrolmentByLevel.map((l) => l.count));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Good day, {firstName}</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {data.term ? (
            `Here is where ${auth.schoolName} stands this term.`
          ) : (
            <>
              No term is marked as current, so there are no termly figures yet.{" "}
              <Link href="/settings/terms" className="font-medium text-brand-600 hover:underline">
                Set up the year and its terms
              </Link>
              .
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Students"
          value={String(data.students)}
          sub={`${data.boys} boys · ${data.girls} girls`}
        />
        <Stat label="Staff" value={String(data.staff)} sub={`${data.classGroups} classes`} />
        {showMoney ? (
          <>
            <Stat
              label="Collected"
              value={formatCedis(data.collected)}
              sub={`${data.collectionRate.toFixed(0)}% of ${formatCedis(data.billed)} billed`}
            />
            <Stat
              label="Outstanding"
              value={formatCedis(data.outstanding)}
              sub={`${data.debtorCount} students owing`}
              tone={data.outstanding > 0 ? "attention" : "default"}
            />
          </>
        ) : (
          <>
            <Stat label="Classes" value={String(data.classGroups)} />
            <Stat
              label="Term"
              value={data.term ? `Term ${data.term.sequence}` : "—"}
              sub={data.term?.academicYear.name}
            />
          </>
        )}
      </div>

      <Attention items={attention} />

      {/* Side by side: neither the chart nor the feed needs the full width, and
          stacking them pushed the payments, the debtors and the term's finances
          a screen and a half down a page a head teacher opens every morning. */}
      {showMoney && collections ? (
        // items-start: without it the grid stretches both cards to the taller
        // one, and the chart grew a hand's width of nothing under its axis.
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <CollectionsChart collections={collections} billed={data.billed} />
          <ActivityFeed items={activity} />
        </div>
      ) : (
        <ActivityFeed items={activity} />
      )}

      {showMoney ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Recent payments">
            {data.recentPayments.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">No payments recorded yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.recentPayments.map((payment) => (
                  <li key={payment.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {payment.student.firstName} {payment.student.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {payment.student.admissionNo} · {payment.receiptNo} ·{" "}
                        {payment.method.replace(/_/g, " ").toLowerCase()}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                      {formatCedis(Number(payment.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Largest balances">
            {data.topDebtors.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">Every invoice is settled.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {data.topDebtors.map((invoice) => (
                  <li key={invoice.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {invoice.student.firstName} {invoice.student.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {invoice.student.admissionNo}
                        {invoice.student.currentClassGroup
                          ? ` · ${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
                          : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-red-600">
                      {formatCedis(Number(invoice.balance))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Enrolment by level">
          <ul className="divide-y divide-slate-100">
            {data.enrolmentByLevel.map((level) => (
              <li key={level.id} className="flex items-center gap-3 px-4 py-2">
                <span className="w-28 shrink-0 truncate text-sm text-slate-700">{level.name}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-brand-600"
                    style={{ width: `${(level.count / maxLevel) * 100}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right text-sm tabular-nums text-slate-600">
                  {level.count}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {showMoney ? (
          <Card title="Term finances">
            <dl className="divide-y divide-slate-100">
              {[
                ["Billed", formatCedis(data.billed), "text-slate-900"],
                ["Collected", formatCedis(data.collected), "text-green-700"],
                ["Outstanding", formatCedis(data.outstanding), "text-red-600"],
                ["Expenditure", formatCedis(data.spent), "text-slate-900"],
                ["Net", formatCedis(data.collected - data.spent), "text-slate-900"],
              ].map(([label, value, tone]) => (
                <div key={label} className="flex items-center justify-between px-4 py-2.5">
                  <dt className="text-sm text-slate-600">{label}</dt>
                  <dd className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
