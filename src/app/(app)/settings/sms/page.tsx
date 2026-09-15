import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE, canAccess } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card } from "../../ui";
import { SmsGatewayForm } from "../settings-forms";

export const metadata: Metadata = { title: "SMS gateway · School OS" };

/**
 * The gateway, on its own page.
 *
 * OFFICE rather than OFFICE, which is the whole reason this was split out:
 * an IT admin can wire up a provider and prove it with a test message without
 * being handed the fees policy that used to sit two cards above it.
 */
export default async function SmsGatewayPage() {
  const auth = await requireRole(OFFICE);
  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId: auth.schoolId },
    select: { smsProvider: true, smsSenderId: true, smsEnabled: true },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          ← Settings
        </Link>
      </div>
      <PageHeader
        title="SMS gateway"
        subtitle="Which provider carries the school's messages, and the name they arrive from"
      />

      <Card title="Provider">
        <SmsGatewayForm
          values={{
            smsProvider: settings?.smsProvider ?? null,
            smsSenderId: settings?.smsSenderId ?? null,
            smsEnabled: settings?.smsEnabled ?? false,
          }}
        />
      </Card>

      <p className="text-xs text-slate-400">
        ⚠️ An unregistered sender ID is the usual reason a message is accepted and never arrives.
        It is at most 11 characters and must be registered with the provider, which takes days in
        Ghana — start that before you need it.
        {canAccess(auth.roles, OFFICE)
          ? " Whether the school sends at all is set under Settings → Messaging."
          : " Whether the school sends at all is set by the head, under Settings."}
      </p>
    </div>
  );
}
