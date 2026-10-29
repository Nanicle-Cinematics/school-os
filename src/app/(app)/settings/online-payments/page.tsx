import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getGatewayOverview } from "@/lib/online-payment-data";
import { Card, PageHeader } from "../../ui";
import { GatewayKeyForm, GatewayRemoveForm, GatewaySwitchForm } from "./online-payments-forms";

export const metadata: Metadata = { title: "Online payments · School OS" };

/**
 * Where parents' online payments go: the school's own Paystack account.
 *
 * LEADERSHIP only. This is the key to where the school's money lands, and the IT admin is kept out of
 * the money on purpose (see FINANCE in permissions.ts). Nothing here ever shows the key back.
 */
export default async function OnlinePaymentsPage() {
  const auth = await requireRole(LEADERSHIP);

  const overview = await getGatewayOverview();

  const base = (process.env.APP_URL ?? "https://www.schoolosafrica.com").replace(/\/$/, "");
  const webhook = `${base}/api/paystack/webhook/${auth.schoolId}`;
  const hasKey = overview.hasKey;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          ← Settings
        </Link>
      </div>
      <PageHeader
        title="Online payments"
        subtitle="Let parents pay fees from their phone, straight into the school's own Paystack account"
      />

      <Card title="1. Paystack secret key">
        <p className="px-4 pt-4 text-sm text-slate-600">
          {hasKey
            ? `A ${overview.mode ?? ""} key is saved. It cannot be shown again; paste a new one to replace it.`
            : "No key saved yet. Create a Paystack account for the school, then paste its secret key here."}
        </p>
        <GatewayKeyForm hasKey={hasKey} />
      </Card>

      <Card title="2. Tell Paystack where to report payments">
        <div className="space-y-2 p-4 text-sm text-slate-600">
          <p>
            In Paystack, open Settings → API Keys &amp; Webhooks and paste this address into{" "}
            <strong>Live Webhook URL</strong> (and <strong>Test Webhook URL</strong> while testing):
          </p>
          <code className="block break-all rounded-card border border-hairline bg-slate-50 p-3 text-xs text-slate-900">
            {webhook}
          </code>
          <p className="text-xs text-slate-500">
            Payments are also picked up when the parent comes back to the school page, so a missed
            webhook delays a receipt rather than losing it. The webhook is what records the payment
            when a parent closes the page after paying.
          </p>
        </div>
      </Card>

      <Card title="3. Switch it on">
        <GatewaySwitchForm enabled={overview.enabled} hasKey={hasKey} />
      </Card>

      <Card title="Last 30 days">
        <dl className="grid grid-cols-3 gap-3 p-4 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Paid</dt>
            <dd className="text-lg font-bold tabular-nums">{overview.paid}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Started, not finished</dt>
            <dd className="text-lg font-bold tabular-nums">{overview.pending}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Did not go through</dt>
            <dd className="text-lg font-bold tabular-nums">{overview.failed}</dd>
          </div>
        </dl>
      </Card>

      {hasKey ? (
        <Card title="Remove the key">
          <GatewayRemoveForm />
        </Card>
      ) : null}

      <p className="text-xs text-slate-400">
        Paystack charges its own fee on every payment, taken from what the school receives. Money
        goes to the school&apos;s Paystack balance and from there to its bank account on Paystack&apos;s
        schedule; School OS never holds it.
      </p>
    </div>
  );
}
