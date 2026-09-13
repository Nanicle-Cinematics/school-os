import type { Metadata } from "next";
import { StatCard } from "../../primitives";
import { CircleAlert, Send, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getCampaign } from "@/lib/message-data";
import { formatCedis } from "@/lib/money";
import { Card, StatusBadge, EmptyRow, thClass, tableHeadClass } from "../../ui";

export const metadata: Metadata = { title: "Campaign · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function CampaignPage({
  params,
}: PageProps<"/messages/[id]">) {
  await requireRole(OFFICE);
  const { id } = await params;
  const campaign = await getCampaign(id);

  if (!campaign) {
    notFound();
  }

  const dryRun = campaign.messages.some((message) =>
    message.error?.startsWith("Dry run"),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link
        href="/messages"
        className="text-sm text-slate-500 hover:text-slate-900"
      >
        ← All campaigns
      </Link>

      <div className="rounded-card border border-hairline bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              {campaign.name}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {campaign.createdBy?.name
                ? `Sent by ${campaign.createdBy.name} · `
                : ""}
              {dateFmt.format(campaign.sentAt ?? campaign.createdAt)}
            </p>
          </div>
          <StatusBadge status={campaign.status} />
        </div>

        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {campaign.body}
        </p>

        {dryRun ? (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span className="font-medium">Dry run.</span> No SMS gateway is
            configured, so nothing was actually delivered. Every message below
            was rendered and recorded exactly as it would have been sent — add{" "}
            <code className="font-mono">SMS_PROVIDER</code> and{" "}
            <code className="font-mono">SMS_API_KEY</code> to send for real.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Recipients"
          value={String(campaign.totalRecipients)}
          icon={Users}
        />
        <StatCard
          label="Sent"
          value={String(campaign.sentCount)}
          icon={Send}
          severity="done"
        />
        <StatCard
          label="Failed"
          value={String(campaign.failedCount)}
          icon={CircleAlert}
          severity="blocking"
        />
        <StatCard
          label="Estimated cost"
          value={
            campaign.estimatedCost ? formatCedis(campaign.estimatedCost) : "—"
          }
          icon={Wallet}
        />
      </div>

      <Card title={`Delivery log (${campaign.messages.length})`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>To</th>
                <th className={thClass}>Recipient</th>
                <th className={thClass}>Message</th>
                <th className={`${thClass} text-right`}>Seg.</th>
                <th className={thClass}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {campaign.messages.length === 0 ? (
                <EmptyRow colSpan={5}>No messages recorded.</EmptyRow>
              ) : (
                campaign.messages.map((message) => (
                  <tr key={message.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-600">
                      {message.toPhone}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-slate-700">
                      {message.guardian
                        ? `${message.guardian.firstName} ${message.guardian.lastName}`
                        : "—"}
                      {message.student ? (
                        <span className="ml-2 text-xs text-slate-400">
                          {message.student.admissionNo}
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-md px-4 py-2 text-xs text-slate-600">
                      {message.body}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                      {message.segments ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <StatusBadge status={message.status} />
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
