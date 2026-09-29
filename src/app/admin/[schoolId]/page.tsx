import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { getSchoolForPlatform } from "@/lib/platform-data";
import { subscriptionState, PLANS, STATUS_LABELS } from "@/lib/subscription";
import { formatCedis } from "@/lib/money";
import { SubscriptionForm } from "./subscription-form";
import { SchoolBackupButton } from "./backup-button";

export const metadata: Metadata = { title: "School · Nanicle console" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-slate-900">{value}</span>
    </div>
  );
}

export default async function PlatformSchoolPage({ params }: PageProps<"/admin/[schoolId]">) {
  await requirePlatformAdmin();
  const { schoolId } = await params;

  const school = await getSchoolForPlatform(schoolId);
  if (!school) {
    notFound();
  }

  const state = subscriptionState(school);
  const cap = school.studentCap ?? PLANS[school.plan].studentCap;
  const overCap = cap !== null && school.pupils > cap;

  return (
    <main className="min-h-full bg-slate-50">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6">
        <div>
          <Link href="/admin" className="text-sm text-slate-500 hover:text-slate-900">
            ← All schools
          </Link>
          <h1 className="font-heading mt-1 text-title text-slate-900">{school.name}</h1>
          <p className="mt-1.5 text-caption text-slate-500">
            <span className="font-mono">{school.slug}</span>
            {school.town ? ` · ${school.town}` : ""}
            {school.region ? `, ${school.region}` : ""} · opened {dateFmt.format(school.createdAt)}
          </p>
        </div>

        {/* The state this school is actually in, before the controls that change
            it — so the answer to "what is happening to them right now" does not
            have to be inferred from two dropdowns. */}
        <div
          className={`rounded-2xl border px-4 py-3 ${
            state.readOnly
              ? "border-hairline bg-danger-tint"
              : "border-slate-200 bg-surface"
          }`}
        >
          <p className={`text-sm font-semibold ${state.readOnly ? "text-danger-ink" : "text-slate-900"}`}>
            {PLANS[school.plan].label} · {STATUS_LABELS[school.subscriptionStatus]}
            {state.readOnly ? " · read-only" : ""}
          </p>
          <p className={`mt-0.5 text-sm ${state.readOnly ? "text-danger-ink" : "text-slate-600"}`}>
            {state.notice ??
              (state.trialDaysLeft !== null && school.subscriptionStatus === "TRIALING"
                ? `Trial ends in ${state.trialDaysLeft} days.`
                : "Everything is working normally for this school.")}
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
            <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
              Use
            </p>
            <div className="divide-y divide-slate-100">
              <Row
                label="Children on roll"
                value={cap === null ? String(school.pupils) : `${school.pupils} of ${cap}`}
              />
              <Row label="Staff" value={String(school.staff)} />
              <Row label="Parent logins" value={String(school.parents)} />
              <Row
                label="Last signed in"
                value={school.lastSignIn ? dateFmt.format(school.lastSignIn) : "never"}
              />
            </div>
            {overCap ? (
              <p className="border-t border-hairline bg-warning-tint px-4 py-2.5 text-xs text-warning-ink">
                Over the cap for this plan. Existing pupils keep working; new admissions are refused
                until the cap or the plan changes.
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
            <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
              Money and messages
            </p>
            <div className="divide-y divide-slate-100">
              <Row label="Fees billed" value={formatCedis(school.billed)} />
              <Row label="Fees collected" value={formatCedis(school.collected)} />
              <Row label="Texts sent" value={String(school.smsSent)} />
              {/* The cost that scales with use, and the one a school can run up
                  without noticing — it is the platform's account behind it. */}
              <Row label="SMS spend" value={formatCedis(school.smsCost)} />
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
          <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
            Who to call
          </p>
          <div className="divide-y divide-slate-100">
            {school.owners.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No proprietor login on this school.</p>
            ) : (
              school.owners.map((owner) => (
                <div key={owner.email ?? owner.name} className="px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">{owner.name}</p>
                  <p className="text-sm text-slate-500">
                    {[owner.email, owner.phone].filter(Boolean).join(" · ") || "no contact recorded"}
                  </p>
                </div>
              ))
            )}
            {school.phone || school.email ? (
              <div className="px-4 py-3">
                <p className="text-xs font-semibold text-slate-500">
                  School office
                </p>
                <p className="text-sm text-slate-600">
                  {[school.phone, school.email].filter(Boolean).join(" · ")}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
          <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
            Subscription
          </p>
          <SubscriptionForm school={school} />
        </div>

        <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
          <p className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">
            Backups
          </p>
          <SchoolBackupButton schoolId={school.id} />
        </div>
      </div>
    </main>
  );
}
