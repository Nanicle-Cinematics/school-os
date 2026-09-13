import type { Metadata } from "next";
import { StatCard } from "../primitives";
import { CircleAlert, Send, Wallet } from "lucide-react";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getMessagingSetup, getMessageStats } from "@/lib/message-data";
import { formatCedis } from "@/lib/money";
import { PageHeader, Card, StatusBadge } from "../ui";
import { DataTable, Row, type Column } from "../primitives";
import { Compose } from "./compose";
import { StandardMessages } from "./standard-messages";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/lib/message-defaults";

export const metadata: Metadata = { title: "Messages · School OS" };

const COLUMNS: Column[] = [
  { label: "" },
  { label: "Name" },
  { label: "Audience" },
  { label: "Recipients", numeric: true },
  { label: "Sent", numeric: true },
  { label: "Failed", numeric: true },
  { label: "Cost", numeric: true },
  { label: "When" },
];

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const AUDIENCE_LABEL: Record<string, string> = {
  ALL_PARENTS: "All parents",
  ALL_STAFF: "All staff",
  CLASS: "Selected classes",
  LEVEL: "Selected levels",
  DEBTORS: "Parents owing fees",
  CUSTOM: "Custom numbers",
};

export default async function MessagesPage() {
  await requireRole(OFFICE);
  const [{ templates, campaigns, classGroups, levels, settings }, stats] =
    await Promise.all([getMessagingSetup(), getMessageStats()]);

  const gatewayConfigured = Boolean(
    process.env.SMS_API_KEY && process.env.SMS_PROVIDER,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Messages"
        subtitle={
          gatewayConfigured
            ? `Sending via ${settings?.smsProvider ?? process.env.SMS_PROVIDER}`
            : "No SMS gateway configured — everything runs as a dry run"
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Messages" value={String(stats.total)} icon={Send} />
        <StatCard
          label="Sent"
          value={String(stats.sent)}
          icon={Send}
          severity="done"
        />
        <StatCard
          label="Failed"
          value={String(stats.failed)}
          icon={CircleAlert}
          severity={stats.failed > 0 ? "blocking" : "done"}
        />
        <StatCard
          label="Spend"
          value={formatCedis(stats.cost)}
          caption="estimated"
          icon={Wallet}
        />
      </div>

      <StandardMessages
        missing={
          DEFAULT_MESSAGE_TEMPLATES.filter(
            (d) => !templates.some((t) => t.name === d.name),
          ).length
        }
        total={templates.length}
      />

      <Compose
        templates={templates}
        classGroups={classGroups}
        levels={levels}
        smsEnabled={Boolean(settings?.smsEnabled) && gatewayConfigured}
      />

      <Card title="Campaigns">
        <div className="overflow-x-auto">
          <DataTable
            columns={COLUMNS}
            empty={{ icon: Send, title: "No campaigns yet. Compose one to a class, a level or the families who owe.", action: undefined }}
          >
            {campaigns.map((campaign) => (
                  <Row key={campaign.id}>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <Link
                        href={`/messages/${campaign.id}`}
                        className="font-medium text-slate-900 underline-offset-2 hover:underline"
                      >
                        {campaign.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                      {AUDIENCE_LABEL[campaign.audienceType] ??
                        campaign.audienceType}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {campaign.totalRecipients}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-green-700">
                      {campaign.sentCount}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-red-600">
                      {campaign.failedCount || "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                      {campaign.estimatedCost
                        ? formatCedis(campaign.estimatedCost)
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
                      {dateFmt.format(campaign.sentAt ?? campaign.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={campaign.status} />
                    </td>
                  </Row>
                ))
              }
          </DataTable>
        </div>
      </Card>
    </div>
  );
}
