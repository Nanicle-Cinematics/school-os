import type { Metadata } from "next";
import Link from "next/link";
import type { InvoiceStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getInvoiceList, getInvoiceFilterOptions } from "@/lib/invoice-data";
import { getCurrentTerm } from "@/lib/fee-data";
import { formatCedis } from "@/lib/money";
import { PageHeader, Stat, Card, StatusBadge, EmptyRow, filterClass, thClass, tableHeadClass } from "../ui";
import { GenerateForm } from "./generate-form";

export const metadata: Metadata = { title: "Invoices · School OS" };

const STATUSES: (InvoiceStatus | "DEBTORS")[] = [
  "DEBTORS",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
];

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  await requireRole(FINANCE);
  const params = await searchParams;

  const currentTerm = await getCurrentTerm();
  const termId = typeof params.term === "string" ? params.term : (currentTerm?.id ?? undefined);
  const status = typeof params.status === "string" ? params.status : undefined;
  const classGroupId = typeof params.class === "string" ? params.class : undefined;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;

  const [{ terms, classGroups }, data] = await Promise.all([
    getInvoiceFilterOptions(),
    getInvoiceList({
      termId,
      classGroupId,
      status: status as InvoiceStatus | "DEBTORS" | undefined,
      q,
    }),
  ]);

  const collectionRate =
    Number(data.billed) > 0 ? (Number(data.collected) / Number(data.billed)) * 100 : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Invoices"
        subtitle={`${data.count} matching invoices`}
        action={
          termId ? (
            <Link
              href={`/invoices/print?term=${termId}${classGroupId ? `&class=${classGroupId}` : ""}`}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Print bills{classGroupId ? " for this class" : ""}
            </Link>
          ) : null
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Billed" value={formatCedis(data.billed)} />
        <Stat
          label="Collected"
          value={formatCedis(data.collected)}
          tone="positive"
          sub={`${collectionRate.toFixed(0)}% collection rate`}
        />
        <Stat label="Outstanding" value={formatCedis(data.outstanding)} tone="negative" />
        <Stat label="Invoices" value={String(data.count)} />
      </div>

      <GenerateForm terms={terms} currentTermId={currentTerm?.id} />

      <form className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <select name="term" defaultValue={termId ?? ""} className={`${filterClass} w-auto`}>
          <option value="">All terms</option>
          {terms.map((term) => (
            <option key={term.id} value={term.id}>
              Term {term.sequence} · {term.academicYear.name}
            </option>
          ))}
        </select>

        <select name="status" defaultValue={status ?? ""} className={`${filterClass} w-auto`}>
          <option value="">Any status</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value === "DEBTORS" ? "Owing (debtors)" : value.replace(/_/g, " ").toLowerCase()}
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
          placeholder="Name, admission or invoice no."
          className={`${filterClass} w-56`}
        />

        <button
          type="submit"
          className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-[0_6px_16px_rgba(18,128,92,0.22)] transition hover:bg-brand-700"
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
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Invoice</th>
                <th className={thClass}>Student</th>
                <th className={thClass}>Class</th>
                <th className={`${thClass} text-right`}>Total</th>
                <th className={`${thClass} text-right`}>Paid</th>
                <th className={`${thClass} text-right`}>Balance</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.invoices.length === 0 ? (
                <EmptyRow colSpan={7}>
                  No invoices match these filters. Generate them for the term above if you
                  haven&rsquo;t yet.
                </EmptyRow>
              ) : (
                data.invoices.map((invoice) => (
                  <tr key={invoice.id} className="hover:bg-slate-50">
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
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-green-700">
                      {formatCedis(invoice.amountPaid)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-red-600">
                      {Number(invoice.balance) > 0 ? formatCedis(invoice.balance) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StatusBadge status={invoice.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
