import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "../../ui";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Invite parents · School OS" };

export default async function InviteParentsPage() {
  const auth = await requireRole(OFFICE);

  const classes = await prisma.classGroup.findMany({
    select: { id: true, name: true, level: { select: { name: true, order: true } } },
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
  });

  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId: auth.schoolId },
    select: { smsEnabled: true, smsProvider: true },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Invite parents to the portal"
        subtitle="Creates a portal login for each guardian and texts them their temporary password."
      />

      <InviteForm
        classes={classes.map((c) => ({ id: c.id, label: `${c.level.name} ${c.name}` }))}
        smsLive={Boolean(settings?.smsEnabled && settings?.smsProvider)}
      />
    </div>
  );
}
