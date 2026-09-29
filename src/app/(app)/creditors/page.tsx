import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, HandCoins, Users } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getVendors, getActiveVendors, getBillCategories, getCreditorAgeing } from "@/lib/vendor-data";
import { formatCedis } from "@/lib/money";
import { AGE_LABEL } from "@/lib/bill-engine";
import { PageHeader, Card, filterClass } from "../ui";
import { DataTable, Row, StatCard, type Column } from "../primitives";
import { buttonClass } from "../button-style";
import { VendorForm } from "./vendor-form";
import { BillForm } from "./bill-form";
import { PaymentForm } from "./payment-form";

export const metadata: Metadata = { title: "Creditors · School OS" };

const COLUMNS: Column[] = [
  { label: "Vendor" },
  { label: "Contact" },
  { label: "Bills", numeric: true },
  { label: "Owed", numeric: true },
];

export default async function CreditorsPage({
  searchParams,
}: PageProps<"/creditors">) {
  await requireRole(FINANCE);
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : undefined;

  const [vendors, activeVendors, categories, ageing] = await Promise.all([
    getVendors({ q }),
    getActiveVendors(),
    getBillCategories(),
    getCreditorAgeing(),
  ]);

  const totalOwed = vendors.reduce((sum, v) => sum + v.owed, 0);
  const oldestBucketTotal = ageing.find((row) => row.bucket === "D90_PLUS")?.total ?? 0;
  const owingVendors = vendors.filter((v) => v.owed > 0);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Creditors"
        subtitle={`${owingVendors.length} ${owingVendors.length === 1 ? "vendor" : "vendors"} owed money`}
        action={
          <div className="flex flex-wrap gap-2">
            <VendorForm />
            <BillForm vendors={activeVendors} categories={categories} />
            <PaymentForm vendors={activeVendors} />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total owed"
          value={formatCedis(totalOwed)}
          icon={HandCoins}
          severity={totalOwed > 0 ? "blocking" : "done"}
        />
        <StatCard label="Vendors owed" value={String(owingVendors.length)} icon={Users} />
        <StatCard
          label="Over 90 days"
          value={formatCedis(oldestBucketTotal)}
          icon={Banknote}
          severity={oldestBucketTotal > 0 ? "blocking" : "done"}
        />
      </div>

      {totalOwed > 0 ? (
        <Card title="How long bills have been owed">
          <div className="grid grid-cols-2 divide-y divide-slate-100 sm:grid-cols-5 sm:divide-y-0 sm:divide-x">
            {ageing.map((row) => {
              const urgent = row.bucket === "D90_PLUS" && row.total > 0;
              return (
                <div key={row.bucket} className="px-4 py-3">
                  <p className="text-xs text-slate-500">{AGE_LABEL[row.bucket]}</p>
                  <p
                    className={`mt-0.5 font-heading text-lg tabular-nums ${
                      urgent ? "text-danger-ink" : "text-slate-900"
                    }`}
                  >
                    {formatCedis(row.total)}
                  </p>
                  <p className="text-xs text-slate-400">
                    {row.count} bill{row.count === 1 ? "" : "s"}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      <form className="flex flex-wrap items-end gap-2 rounded-card border border-hairline bg-surface p-3">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Vendor name"
          className={`${filterClass} w-56`}
        />
        <button type="submit" className={buttonClass("secondary")}>
          Filter
        </button>
        <Link
          href="/creditors"
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
              title: "No vendors match these filters. Add one above.",
              action: undefined,
            }}
          >
            {vendors.map((vendor) => (
              <Row key={vendor.id}>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Link href={`/creditors/${vendor.id}`} className="font-medium text-slate-900 hover:underline">
                    {vendor.name}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                  {[vendor.contactPerson, vendor.phone].filter(Boolean).join(" · ") || "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {vendor.billCount}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-danger-ink">
                  {vendor.owed > 0 ? formatCedis(vendor.owed) : "—"}
                </td>
              </Row>
            ))}
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
