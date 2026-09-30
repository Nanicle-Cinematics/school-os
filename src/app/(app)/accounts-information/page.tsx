import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getAccountsInformation } from "@/lib/accounts-information-data";
import { PageHeader, Card } from "../ui";
import { AccountsInformationForm } from "./accounts-information-form";

export const metadata: Metadata = { title: "Billing details · School OS" };

export default async function AccountsInformationPage() {
  const auth = await requireRole(FINANCE);
  const info = await getAccountsInformation(auth.schoolId);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Billing details"
        subtitle="What prints on every bill: the school's tax ID and how a parent pays."
      />

      <Card title="Billing details">
        <AccountsInformationForm values={info} />
      </Card>

      <p className="text-xs text-slate-400">
        The school&rsquo;s name, address and GES/Ministry number are on{" "}
        <Link href="/settings" className="underline hover:text-slate-600">
          Settings → School profile
        </Link>
        .
      </p>

      {/* This page is what prints on a bill, not a record of money received —
          the confusion that landed a real accountant here looking for the
          latter. Point them at the actual report rather than leaving them to
          conclude the app has no such thing. */}
      <p className="text-xs text-slate-400">
        Looking for how much came in each week?{" "}
        <Link href="/payments/collections" className="underline hover:text-slate-600">
          Weekly collections →
        </Link>
      </p>
    </div>
  );
}
