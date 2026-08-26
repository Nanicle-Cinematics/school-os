import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getStructure } from "@/lib/structure-data";
import { PageHeader } from "../ui";
import { Card } from "../ui";
import { HouseSection } from "../settings/structure/structure-forms";

export const metadata: Metadata = { title: "Houses · School OS" };

export default async function HousesPage() {
  await requireRole(OFFICE);
  const { houses } = await getStructure();

  const placed = houses.reduce((total, house) => total + house._count.students, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Houses"
        subtitle={
          houses.length === 0
            ? "No houses yet."
            : `${houses.length} houses · ${placed} students placed`
        }
      />

      <Card title="Houses">
        {houses.length === 0 ? (
          <p className="px-4 pt-4 text-sm text-slate-500">
            Add the school&rsquo;s houses below. A student is assigned one when they are admitted or
            edited, and the house prints on their report card.
          </p>
        ) : null}
        <HouseSection houses={houses} />
      </Card>

      <p className="text-xs text-slate-400">
        Houses are optional — leave this empty if the school does not run a house system. A house
        holding students cannot be deleted; move them first. Levels and programmes live under{" "}
        <Link href="/settings/structure" className="underline">
          School structure
        </Link>
        .
      </p>
    </div>
  );
}
