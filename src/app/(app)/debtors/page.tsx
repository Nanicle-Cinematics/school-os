import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, HandCoins, Users } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import {
  getDebtorsByStudent,
  getDebtorAgeing,
  getInvoiceFilterOptions,
} from "@/lib/invoice-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { formatCedis } from "@/lib/money";
import { AGE_BUCKETS, AGE_LABEL, type AgeBucket } from "@/lib/invoice-engine";
import { PageHeader, Card, Avatar, filterClass } from "../ui";
import { DataTable, Row, StatCard, type Column } from "../primitives";
import { buttonClass } from "../button-style";

export const metadata: Metadata = { title: "Debtors · School OS" };

const COLUMNS: Column[] = [
  { label: "Student" },
  { label: "Class" },
  { label: "Invoices", numeric: true },
  { label: "Oldest" },
  { label: "Owed", numeric: true },
];

export default async function DebtorsPage({
  searchParams,
}: PageProps<"/debtors">) {
  await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await getCurrentTerm();
  const termId =
    typeof params.term === "string" ? params.term : (currentTerm?.id ?? undefined);
  const classGroupId = typeof params.class === "string" ? params.class : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;
  const age =
    typeof params.age === "string" && (AGE_BUCKETS as readonly string[]).includes(params.age)
      ? (params.age as AgeBucket)
      : undefined;

  // The filter options run two queries, the debtor list three (it fans out its own) and the
  // ageing walks its buckets one after another, so all three in one Promise.all put about six
  // in flight against an app-role pool of four. The list and the ageing together make four, which
  // fits and keeps the long ageing chain overlapping the list; the filter options follow.
  // Measured on the dev server: all three parallel ~15s, this ~18s, fully sequential ~21s.
  // See "Don't fan a page's queries out past the pool" in CLAUDE.md.
  const [{ debtors, totalOwed }, ageing] = await Promise.all([
    getDebtorsByStudent({ termId, classGroupId, age, q }),
    getDebtorAgeing(termId),
  ]);
  const { terms, classGroups } = await getInvoiceFilterOptions();

  const oldestBucketTotal = ageing.find((row) => row.bucket === "D90_PLUS")?.total ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Debtors"
        subtitle={`${debtors.length} ${debtors.length === 1 ? "family" : "families"} owing money`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total owed"
          value={formatCedis(totalOwed)}
          icon={HandCoins}
          severity={totalOwed > 0 ? "blocking" : "done"}
        />
        <StatCard label="Debtors" value={String(debtors.length)} icon={Users} />
        <StatCard
          label="Over 90 days"
          value={formatCedis(oldestBucketTotal)}
          icon={Banknote}
          severity={oldestBucketTotal > 0 ? "blocking" : "done"}
        />
      </div>

      {/* Same buckets as /invoices, so the two screens cannot disagree about
          how long a debt has been owed — see ageFilterWhere. */}
      {totalOwed > 0 ? (
        <Card title="How long fees have been owed">
          <div className="grid grid-cols-2 divide-y divide-slate-100 sm:grid-cols-5 sm:divide-y-0 sm:divide-x">
            {ageing.map((row) => {
              const href = `/debtors?${new URLSearchParams({
                ...(termId ? { term: termId } : {}),
                ...(classGroupId ? { class: classGroupId } : {}),
                age: row.bucket,
              }).toString()}`;
              const active = age === row.bucket;
              const urgent = row.bucket === "D90_PLUS" && row.total > 0;
              return (
                <Link
                  key={row.bucket}
                  href={href}
                  className={`px-4 py-3 transition hover:bg-slate-50 ${
                    active ? "bg-slate-50 ring-1 ring-inset ring-brand-600" : ""
                  }`}
                >
                  <p className="text-xs text-slate-500">{AGE_LABEL[row.bucket]}</p>
                  <p
                    className={`mt-0.5 font-heading text-lg tabular-nums ${
                      urgent ? "text-danger-ink" : "text-slate-900"
                    }`}
                  >
                    {formatCedis(row.total)}
                  </p>
                  <p className="text-xs text-slate-400">
                    {row.count} invoice{row.count === 1 ? "" : "s"}
                  </p>
                </Link>
              );
            })}
          </div>
        </Card>
      ) : null}

      {age ? (
        <p className="text-sm text-slate-500">
          Showing {AGE_LABEL[age].toLowerCase()} ·{" "}
          <Link href="/debtors" className="underline hover:text-slate-900">
            clear
          </Link>
        </p>
      ) : null}

      <form className="flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
        <select name="term" defaultValue={termId ?? ""} className={`${filterClass} w-auto`}>
          <option value="">All terms</option>
          {terms.map((term) => (
            <option key={term.id} value={term.id}>
              Term {term.sequence} · {term.academicYear.name}
            </option>
          ))}
        </select>

        <select name="class" defaultValue={classGroupId ?? ""} className={`${filterClass} w-auto`}>
          <option value="">All classes</option>
          {classGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.level.name} {group.name}
            </option>
          ))}
        </select>

        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Name or admission no."
          className={`${filterClass} w-56`}
        />

        <button type="submit" className={buttonClass("secondary")}>
          Filter
        </button>
        <Link
          href="/debtors"
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      <Card>
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS}
            empty={{
              icon: HandCoins,
              title: "Nobody matching these filters currently owes the school money.",
              action: undefined,
            }}
          >
            {debtors.map((debtor) => (
              <Row key={debtor.studentId}>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Link
                    href={`/students/${debtor.studentId}`}
                    className="flex items-center gap-2.5 hover:underline"
                  >
                    <Avatar firstName={debtor.firstName} lastName={debtor.lastName} size="sm" />
                    <span>
                      <span className="font-medium text-slate-900">
                        {debtor.lastName}, {debtor.firstName}
                      </span>
                      <span className="ml-2 font-mono text-xs text-slate-400">
                        {debtor.admissionNo}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                  {debtor.className ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {debtor.invoiceCount}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span
                    className={
                      debtor.oldestBucket === "D90_PLUS"
                        ? "text-danger-ink"
                        : "text-slate-600"
                    }
                  >
                    {AGE_LABEL[debtor.oldestBucket]}
                  </span>
                  {debtor.onKeptPlan ? (
                    <span className="ml-2 text-xs text-success-ink">on plan</span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-danger-ink">
                  {formatCedis(debtor.totalOwed)}
                </td>
              </Row>
            ))}
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
