import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { ADMISSIONS } from "@/lib/permissions";
import { getApplyOptions } from "@/lib/admissions-data";
import { Card, PageHeader } from "../../ui";
import { ApplicationForm } from "../application-form";

export const metadata: Metadata = { title: "New application · School OS" };
export const dynamic = "force-dynamic";

export default async function NewApplicationPage() {
  await requireRole(ADMISSIONS);
  const { levels, years } = await getApplyOptions();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="New application" subtitle="For a walk-in or a phone call. Parents can also apply online." />
      <Card>
        <div className="p-4.5">
          {levels.length === 0 || years.length === 0 ? (
            <p className="text-sm text-slate-600">
              Set up the school&apos;s classes and academic year first (
              <Link href="/settings" className="font-semibold text-brand-ink hover:underline">
                Settings
              </Link>
              ).
            </p>
          ) : (
            <ApplicationForm mode="new" initial={{}} levels={levels} years={years} />
          )}
        </div>
      </Card>
    </div>
  );
}
