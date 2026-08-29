import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { canAccess, isTeacherOnly, landingFor, FINANCE } from "@/lib/permissions";
import { getDashboard, formatCedis } from "@/lib/dashboard-data";
import { Card, Stat } from "../ui";

export const metadata: Metadata = { title: "Dashboard · School OS" };


export default async function DashboardPage() {
  const auth = await requireAuth();
  // A class teacher has no business on the school-wide dashboard: it carries
  // collections, outstanding fees and every class's enrolment.
  if (isTeacherOnly(auth.roles)) {
    redirect(landingFor(auth.roles));
  }
  const data = await getDashboard(auth.schoolId);
  const showMoney = canAccess(auth.roles, FINANCE);

  const firstName = auth.name.split(" ")[0];
  const maxLevel = Math.max(1, ...data.enrolmentByLevel.map((l) => l.count));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Good day, {firstName}</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {data.term
            ? `Here is where ${auth.schoolName} stands this term.`
            : "No term is marked as current — set one in Settings to see termly figures."}
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
