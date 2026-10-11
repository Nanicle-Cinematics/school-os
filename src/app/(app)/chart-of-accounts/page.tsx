import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import {
  getLedgerAccounts,
  getCategoryAccountMappings,
  getCoreAccountSettings,
} from "@/lib/ledger-data";
import { PageHeader, Card } from "../ui";
import { LedgerAccountSection } from "./ledger-account-items";
import { CategoryMappings } from "./category-mappings";
import { CoreAccountsForm } from "./core-accounts-form";

export const metadata: Metadata = { title: "Chart of accounts · School OS" };

export default async function ChartOfAccountsPage() {
  await requireRole(FINANCE);
  // ⚠️ The loaders are awaited one after another, NOT in a Promise.all. Each already fans out
  // three queries of its own, so three loaders at once put NINE in flight against an app-role
  // pool of FOUR, and under RLS each query is a transaction that holds its connection for
  // several round trips. On a slow link the tail outlasted the pool's 10s checkout timeout and
  // the page died with P2024. One loader at a time keeps three in flight, which fits the pool.
  // (Making the loaders themselves sequential too was measured: ~16s against ~9s, for no gain.)
  const accounts = await getLedgerAccounts();
  const mappings = await getCategoryAccountMappings();
  const coreAccounts = await getCoreAccountSettings();

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Chart of accounts"
        subtitle="The school's own accounts, classified Asset, Liability, Equity, Income or Expense."
      />

      <Card title={`Accounts · ${accounts.length}`}>
        <LedgerAccountSection accounts={accounts} />
      </Card>

      {coreAccounts.assetAccounts.length > 0 || coreAccounts.liabilityAccounts.length > 0 ? (
        <Card
          title="Default postings"
          action={<span className="text-xs text-slate-400">What every payment, bill and invoice posts to</span>}
        >
          <CoreAccountsForm
            values={coreAccounts}
            assetAccounts={coreAccounts.assetAccounts}
            liabilityAccounts={coreAccounts.liabilityAccounts}
          />
        </Card>
      ) : null}

      {mappings.feeCategories.length > 0 || mappings.expenseCategories.length > 0 ? (
        <Card
          title="Which account each item posts to"
          action={
            mappings.incomeAccounts.length === 0 || mappings.expenseAccounts.length === 0 ? (
              <span className="text-xs text-slate-400">Add income/expense accounts above first</span>
            ) : undefined
          }
        >
          <div className="p-4">
            <CategoryMappings
              feeCategories={mappings.feeCategories}
              expenseCategories={mappings.expenseCategories}
              incomeAccounts={mappings.incomeAccounts}
              expenseAccounts={mappings.expenseAccounts}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
