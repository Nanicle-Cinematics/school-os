import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getBillCodes } from "@/lib/billcode-data";
import { PageHeader, Card } from "../ui";
import { BillCodeSection } from "./bill-code-items";

export const metadata: Metadata = { title: "Bill codes · School OS" };

export default async function BillCodesPage() {
  await requireRole(FINANCE);
  const codes = await getBillCodes();

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Bill codes"
        subtitle="What kind of bill each invoice is — Term Fees, PTA, a Trip — distinct from the fee items a bill is made of."
      />

      <Card title={`Bill codes · ${codes.length}`}>
        <BillCodeSection items={codes} />
      </Card>
    </div>
  );
}
