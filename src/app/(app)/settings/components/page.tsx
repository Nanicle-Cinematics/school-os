import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getAssessmentTemplates } from "@/lib/sheet-data";
import { prisma } from "@/lib/prisma";
import { Card } from "../../ui";
import { ComponentSection } from "./component-forms";

export const metadata: Metadata = { title: "Assessment components · School OS" };

export default async function ComponentsPage() {
  await requireRole(LEADERSHIP);
  const templates = await getAssessmentTemplates();
  const settings = await prisma.schoolSettings.findFirst({
    select: { classScoreWeight: true, examScoreWeight: true },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          ← Settings
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Assessment components</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          What every subject is marked out of. A teacher opening a mark sheet gets these
          automatically, and can change any component&rsquo;s total marks for their own class.
        </p>
      </div>

      <Card title={`Components · ${templates.length}`}>
        <ComponentSection
          components={templates.map((template) => ({
            id: template.id,
            title: template.title,
            type: template.type,
            maxScore: Number(template.maxScore),
            isExam: template.isExam,
            order: template.order,
          }))}
          classWeight={settings?.classScoreWeight ?? 30}
          examWeight={settings?.examScoreWeight ?? 70}
        />
      </Card>

      <div className="rounded-card border border-hairline bg-surface p-4 text-xs text-slate-500">
        <p className="mb-1 font-medium text-slate-700">How the marks reach the report card</p>
        <p>
          A student&rsquo;s class score is the marks they earned across the class components divided
          by the marks available, scaled to the class share. The exam is scaled the same way to its
          own share. So raising Class Test 1 from 20 marks to 30 makes it count for more, and
          nothing else needs adjusting.
        </p>
        <p className="mt-2">
          Changing a component here does not disturb sheets already open — those carry their own
          totals, so a term already being marked keeps the rules it started under.
        </p>
      </div>
    </div>
  );
}
