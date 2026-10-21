import type { Metadata } from "next";
import { buttonClass } from "../button-style";
import { Banknote, CircleAlert, FileText } from "lucide-react";
import Link from "next/link";
import { InvoiceStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import {
  getInvoiceList,
  getInvoiceFilterOptions,
  getDebtorAgeing,
  invoicesOnKeptPlans,
  getNextTermId,
} from "@/lib/invoice-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { formatCedis } from "@/lib/money";
import {
  AGE_BUCKETS,
  AGE_LABEL,
  displayStatus,
  daysOverdue,
  type AgeBucket,
} from "@/lib/invoice-engine";
import { PageHeader, Card, StatusBadge, filterClass } from "../ui";
import { DataTable, Row, StatCard, type Column } from "../primitives";
import { GenerateForm } from "./generate-form";

export const metadata: Metadata = { title: "Invoices · School OS" };

const COLUMNS: Column[] = [
  { label: "Invoice" },
  { label: "Student" },
  { label: "Class" },
  { label: "Total", numeric: true },
  { label: "Paid", numeric: true },
  { label: "Balance", numeric: true },
  { label: "Status" },
];

const STATUSES: (InvoiceStatus | "DEBTORS")[] = [
  "DEBTORS",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
];

export default async function InvoicesPage({
  searchParams,
}: PageProps<"/invoices">) {
  await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await getCurrentTerm();
  const termId =
    typeof params.term === "string"
      ? params.term
      : (currentTerm?.id ?? undefined);
  const status = typeof params.status === "string" ? params.status : undefined;
  const classGroupId =
    typeof params.class === "string" ? params.class : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;
  const age =
    typeof params.age === "string" && (AGE_BUCKETS as readonly string[]).includes(params.age)
      ? (params.age as AgeBucket)
      : undefined;

  const [{ terms, classGroups }, data] = await Promise.all([
    getInvoiceFilterOptions(),
    getInvoiceList({
      termId,
      classGroupId,
      status:
        status === "DEBTORS" || (status && status in InvoiceStatus)
          ? (status as InvoiceStatus | "DEBTORS")
          : undefined,
      age,
      q,
    }),
  ]);

  /**
   * The term AFTER the one being viewed — what an advance bill is for.
   *
   * Within the year by sequence, and at the third term it rolls to the first
   * term of the next academic year. That last case is the one that matters:
   * July is exactly when a Ghanaian school wants parents to know September's
   * figure, and it is also when the next year's terms have just been created.
   *
   * ⚠️ Sequentially, not by date. Terms are re-dated by hand on
   * /settings/terms, and a school correcting last year's dates must not change
   * which term follows which.
   */
  const nextTermId = termId ? await getNextTermId(termId) : null;

  const ageing = await getDebtorAgeing(termId);
  const owed = ageing.reduce((sum, row) => sum + row.total, 0);
  const plans = await invoicesOnKeptPlans(termId);

  const collectionRate =
    Number(data.billed) > 0
      ? (Number(data.collected) / Number(data.billed)) * 100
      : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Invoices"
        subtitle={`${data.count} matching invoices`}
        action={
          termId ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/invoices/print?term=${termId}${classGroupId ? `&class=${classGroupId}` : ""}`}
                className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Print bills{classGroupId ? " for this class" : ""}
              </Link>
              {/* The NEXT term, costed but not invoiced — what a parent can pay
                  against during the holidays. */}
              {nextTermId ? (
                <Link
                  href={`/invoices/proforma?term=${nextTermId}${classGroupId ? `&class=${classGroupId}` : ""}`}
                  className="rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Advance bills for next term
                </Link>
              ) : null}
            </div>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Billed"
          value={formatCedis(data.billed)}
          icon={FileText}
        />
        <StatCard
          label="Collected"
          value={formatCedis(data.collected)}
          caption={`${collectionRate.toFixed(0)}% collection rate`}
          icon={Banknote}
          severity="done"
        />
        <StatCard
          label="Outstanding"
          value={formatCedis(data.outstanding)}
          icon={CircleAlert}
          severity={Number(data.outstanding) > 0 ? "blocking" : "done"}
        />
        <StatCard label="Invoices" value={String(data.count)} icon={FileText} />
      </div>

      <GenerateForm terms={terms} currentTermId={currentTerm?.id} />

      {/* ⚠️ Ageing, not just "who owes".
          A `balance > 0` list treats a parent a week late and one who has not
          paid since last term as the same row, and they need different phone
          calls. Each bucket is a link into the same list, so the figure and the
          names behind it come from one rule (ageFilterWhere) and cannot drift. */}
      {owed > 0 ? (
        <Card title="How long fees have been owed">
          <div className="grid grid-cols-2 divide-y divide-slate-100 sm:grid-cols-5 sm:divide-y-0 sm:divide-x">
            {ageing.map((row) => {
              const href = `/invoices?${new URLSearchParams({
                ...(termId ? { term: termId } : {}),
                ...(classGroupId ? { class: classGroupId } : {}),
                age: row.bucket,
              }).toString()}`;
              const active = age === row.bucket;
              // Only the oldest bucket is tinted. Colour has to mean one thing,
              // and here it means "these are the calls to make first".
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

      {/* Named under the buckets rather than subtracted from them. A plan is
          not a way to disappear from the ageing report — the money is still
          owed and still late — but a bursar picking up the phone needs to know
          which of these families the school already agreed a date with. */}
      {plans.kept.size > 0 ? (
        <p className="text-sm text-slate-500">
          {plans.kept.size} of these {plans.kept.size === 1 ? "bill is" : "bills are"} on an agreed
          plan and up to date — {formatCedis(plans.covered)}. Chase the rest first.
          {plans.total > plans.kept.size ? (
            <span className="text-danger-ink">
              {" "}
              {plans.total - plans.kept.size} more had a plan and have fallen behind it.
            </span>
          ) : null}
        </p>
      ) : null}

      {age ? (
        <p className="text-sm text-slate-500">
          Showing {AGE_LABEL[age].toLowerCase()} ·{" "}
          <Link href="/invoices" className="underline hover:text-slate-900">
            clear
          </Link>
        </p>
      ) : null}

      <form className="flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
        <select
          name="term"
          defaultValue={termId ?? ""}
          className={`${filterClass} w-auto`}
        >
          <option value="">All terms</option>
          {terms.map((term) => (
            <option key={term.id} value={term.id}>
              Term {term.sequence} · {term.academicYear.name}
            </option>
          ))}
        </select>

        <select
          name="status"
          defaultValue={status ?? ""}
          className={`${filterClass} w-auto`}
        >
          <option value="">Any status</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value === "DEBTORS"
                ? "Owing (debtors)"
                : value.replace(/_/g, " ").toLowerCase()}
            </option>
          ))}
        </select>

        <select
          name="class"
          defaultValue={classGroupId ?? ""}
          className={`${filterClass} w-auto`}
        >
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
          placeholder="Name, admission or invoice no."
          className={`${filterClass} w-56`}
        />

        <button
          type="submit"
          className={buttonClass("secondary")}
        >
          Filter
        </button>
        <Link
          href="/invoices"
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
              icon: FileText,
              title:
                "No invoices match these filters. Generate the term's bills, or widen the search.",
              action: undefined,
            }}
          >
            {data.invoices.map((invoice) => (
              <Row key={invoice.id}>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Link
                    href={`/invoices/${invoice.id}`}
                    className="font-mono text-xs text-slate-900 underline-offset-2 hover:underline"
                  >
                    {invoice.invoiceNo}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span className="font-medium text-slate-900">
                    {invoice.student.lastName}, {invoice.student.firstName}
                  </span>
                  <span className="ml-2 font-mono text-xs text-slate-400">
                    {invoice.student.admissionNo}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                  {invoice.student.currentClassGroup
                    ? `${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
                    : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {formatCedis(invoice.total)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-success-ink">
                  {formatCedis(invoice.amountPaid)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-danger-ink">
                  {Number(invoice.balance) > 0
                    ? formatCedis(invoice.balance)
                    : "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {/* displayStatus, not invoice.status: lateness is derived
                          on every read, because no row is ever written OVERDUE. */}
                  <StatusBadge status={displayStatus(invoice)} />
                  {daysOverdue(invoice) !== null ? (
                    <span className="ml-2 text-xs text-danger-ink">
                      {daysOverdue(invoice)}d
                    </span>
                  ) : null}
                </td>
              </Row>
            ))}
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
