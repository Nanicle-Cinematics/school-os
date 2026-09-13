import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { paymentSource } from "@/lib/payment-labels";
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
                <span className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-[11.5px] font-bold text-brand-ink transition group-hover:border-brand-200 group-hover:bg-brand-50">
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
      {/* The same large title every other screen got. This one kept a 20px
          heading, so the page a head teacher opens every morning was the only
          one with no entry point — six equal cards and nothing to read first. */}
      <div className="px-0.5 pt-1">
        <h1 className="font-heading text-[31px] leading-[1.1] text-slate-900">
          Good day, {firstName}
        </h1>
        <p className="mt-1.5 text-[13.5px] text-slate-500">
          {data.term ? (
            `Here is where ${auth.schoolName} stands this term.`
          ) : (
            <>
              No term is marked as current, so there are no termly figures yet.{" "}
              <Link href="/settings/terms" className="font-medium text-brand-ink hover:underline">
                Set up the year and its terms
              </Link>
              .
            </>
          )}
        </p>
      </div>

      {/* Five columns, not four: "Outstanding" is the number that decides what a
          head teacher does today, so it is given twice the room rather than
          being the fourth of four identical tiles. */}
      <div className={`grid grid-cols-2 gap-3 ${showMoney ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
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
              hero
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

      {/**
       * TWO INDEPENDENT COLUMNS, not three two-cell grids.
       *
       * ⚠️ `items-start` stopped a short card being STRETCHED to its neighbour's
       * height, but it could not stop the ROW being as tall as its tallest cell.
       * So the chart — now four lines instead of a plot — left a void the depth
       * of the activity feed beneath it before the next row began. Independent
       * columns let each card sit directly under the one above it, and the two
       * columns simply end at different heights, which is what a dashboard
       * should do.
       *
       * Stacked on a phone the order is money first, then the feed, which is
       * also the right order for the person reading it on one.
       */}
      {showMoney ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            {collections ? (
              <CollectionsChart collections={collections} billed={data.billed} />
            ) : null}
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
                                    {paymentSource(payment.method, payment.momoNetwork)}
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
          </div>

          <div className="space-y-4">
            <ActivityFeed items={activity} />
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
          </div>
        </div>
      ) : (
        /* No money on screen for this role, so there is no second column to
           balance — full width beats a half-width card with dead air beside it,
           which is what the two-cell grid gave them. */
        <>
          <ActivityFeed items={activity} />
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
        </>
      )}
    </div>
  );
}
