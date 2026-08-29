import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { prisma } from "@/lib/prisma";
import { Card } from "../../ui";
import { AssetForm, type AssetSlot } from "./branding-forms";

export const metadata: Metadata = { title: "Crest and signature · School OS" };

export default async function BrandingPage() {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });

  const school = await prisma.school.findUnique({
    where: { id: auth.schoolId },
    select: { crestUrl: true, logoUrl: true, headSignatureUrl: true, headName: true, motto: true },
  });

  const slots: AssetSlot[] = [
    {
      kind: "CREST",
      title: "School crest",
      blurb:
        "Prints at the head of every report card and fee invoice, beside the school name. A square image on a plain or transparent background works best.",
      url: school?.crestUrl ?? null,
      frame: "square",
    },
    {
      kind: "HEAD_SIGNATURE",
      title: "Headteacher's signature",
      blurb: school?.headName
        ? `Prints above ${school.headName}'s name at the foot of a report card. Sign on white paper, photograph it, and crop to the signature.`
        : "Prints at the foot of a report card. Set the headteacher's name under School profile so it can be captioned.",
      url: school?.headSignatureUrl ?? null,
      frame: "wide",
    },
    {
      kind: "LOGO",
      title: "Logo",
      blurb:
        "Used in the app itself, in place of the two-letter block beside the school name. Optional — the crest is the one that matters on paper.",
      url: school?.logoUrl ?? null,
      frame: "wide",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          ← Settings
        </Link>
        <h1 className="font-heading mt-1 text-2xl text-slate-900">Crest and signature</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          What makes a report card look like it came from this school and no other.
        </p>
      </div>

      <Card>
        <div className="divide-y divide-slate-100">
          {slots.map((slot) => (
            <AssetForm key={slot.kind} slot={slot} />
          ))}
        </div>
      </Card>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">
        <p className="mb-1 font-medium text-slate-700">Before you upload</p>
        <p>
          PNG, JPEG or WebP, under 512 KB. A crest scanned at about 600 pixels square prints
          cleanly on A4 without making every report card slow to open. SVG is not accepted — it can
          carry script, and these files are served to every parent who opens a report card.
        </p>
      </div>
    </div>
  );
}
