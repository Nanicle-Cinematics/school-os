import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ITEMS_MAX } from "@/lib/proforma";
import { PageHeader } from "../../ui";
import { buttonClass } from "../../button-style";
import { ItemsForm } from "./items-form";

export const metadata: Metadata = { title: "Items to bring · School OS" };

/**
 * What each level's families are asked to bring (toilet rolls, soap), printed on next term's advance bill.
 * Per level, because a nursery child and a JHS pupil are not asked for the same things.
 */
export default async function ItemsToBringPage() {
  await requireRole(FINANCE);
  const levels = await prisma.level.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true, itemsToBring: true },
  });
  const listed = levels.filter((level) => level.itemsToBring).length;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Items to bring"
        subtitle={`${listed} of ${levels.length} levels have a list`}
        action={
          <Link href="/fees" className={buttonClass("secondary")}>
            Fee structure
          </Link>
        }
      />
      <div className="rounded-card border border-hairline bg-surface px-4 py-3 text-sm text-slate-600">
        One item on each line, as the family should read it, for example <em>5 – Toilet rolls</em> or{" "}
        <em>1 – Medium size Dettol</em>. Up to {ITEMS_MAX} a level. The list prints on the advance bill for
        next term; a level with no list prints nothing extra.
      </div>
      <ItemsForm levels={levels.map((level) => ({ id: level.id, name: level.name, items: level.itemsToBring ?? "" }))} />
    </div>
  );
}
