import Link from "next/link";
import { MessageSquare, Image as ImageIcon } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card } from "../ui";

/**
 * Settings, as an IT admin sees it.
 *
 * Two entries, and nothing about money, marks or the school's policy. The point
 * of splitting this page was that configuring a gateway should not require
 * being handed the fees due-days, the arrears hold and the expense approval
 * threshold — so this does not render them, rather than rendering them disabled.
 * A control someone can see and not use is a question they will ask somebody
 * about.
 */
export async function TechnicalSettings({ schoolId }: { schoolId: string }) {
  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId },
    select: { smsProvider: true, smsSenderId: true, smsEnabled: true },
  });

  const gateway = settings?.smsProvider
    ? `${settings.smsProvider}${settings.smsSenderId ? ` · ${settings.smsSenderId}` : ""}`
    : "No provider set";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Settings"
        subtitle="The technical setup. Fees, marks and school policy are with the head."
      />

      <Card title="SMS gateway">
        <Link
          href="/settings/sms"
          className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-slate-50"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-slate-100">
            <MessageSquare className="h-[18px] w-[18px] text-slate-600" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-900">
              Provider and sender ID
            </span>
            <span className="block text-xs text-slate-500">
              {gateway}
              {settings?.smsEnabled ? " · sending is on" : " · sending is off"}
            </span>
          </span>
        </Link>
      </Card>

      <Card title="Branding">
        <Link
          href="/settings/branding"
          className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-slate-50"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-slate-100">
            <ImageIcon className="h-[18px] w-[18px] text-slate-600" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-900">
              Crest, logo and the head&rsquo;s signature
            </span>
            <span className="block text-xs text-slate-500">
              Printed on report cards and fee invoices.
            </span>
          </span>
        </Link>
      </Card>
    </div>
  );
}
