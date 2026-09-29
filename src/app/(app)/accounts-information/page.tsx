import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getAccountsInformation } from "@/lib/accounts-information-data";
import { PageHeader, Card } from "../ui";
import { AccountsInformationForm } from "./accounts-information-form";

export const metadata: Metadata = { title: "Accounts information · School OS" };

export default async function AccountsInformationPage() {
  const auth = await requireRole(FINANCE);
  const info = await getAccountsInformation(auth.schoolId);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Accounts information"
        subtitle="What prints on every bill: the school's tax ID and how a parent pays."
      />

      <Card title="Accounts information">
        <AccountsInformationForm values={info} />
      </Card>

      <p className="text-xs text-slate-400">
        The school&rsquo;s name, address and GES/Ministry number are on{" "}
        <Link href="/settings" className="underline hover:text-slate-600">
          Settings → School profile
        </Link>
        .
      </p>
    </div>
  );
}
