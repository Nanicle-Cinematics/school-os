import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { PageHeader } from "../../ui";
import { ReconcileForm } from "./reconcile-form";

export const metadata: Metadata = { title: "Reconcile · School OS" };

export default async function ReconcilePage() {
  await requireRole(FINANCE);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/payments" className="text-sm text-slate-500 hover:text-slate-900">
          ← Payments
        </Link>
      </div>
      <PageHeader
        title="Reconcile"
        subtitle="Match the bank or MoMo statement against what the office recorded"
      />
      <ReconcileForm />
    </div>
  );
}
