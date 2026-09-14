import Link from "next/link";
import {
  BookOpenCheck,
  Building2,
  Coins,
  FileText,
  MessageSquare,
  Printer,
  ShieldCheck,
  Users,
} from "lucide-react";
import { ButtonLink } from "./(app)/primitives";
import { PLANS, TRIAL_DAYS } from "@/lib/subscription";

/**
 * ⚠️ CHANGE THIS. It is a personal address on a public page.
 *
 * Left as the owner's own inbox because a trial request that reaches nobody is
 * worse than an unpolished one, and this is the address that certainly works
 * today. Swap it for a Nanicle one — and add a phone or WhatsApp number, which
 * for a Ghanaian school proprietor is likelier to convert than any form.
 */
const CONTACT = "degraftnanaaboagye@gmail.com";

const SUBJECT = encodeURIComponent("School OS — trial for my school");
const mailto = `mailto:${CONTACT}?subject=${SUBJECT}`;

/** What a school gets on the first day, in the order a head teacher cares. */
const FEATURES = [
  {
    icon: BookOpenCheck,
    title: "The GES curriculum, already set up",
    body:
      "11 levels from KG1 to JHS3, 18 subjects and 104 subject offerings arrive with the school — " +
      "KG's four thematic areas, OWOP and History through B6, Social Studies from B7, French and " +
      "Computing from B4. Nobody types a subject list.",
  },
  {
    icon: Users,
    title: "Pupils, staff and guardians",
    body:
      "Admit a pupil and the admission number writes itself. Classes, houses, programmes, " +
      "placements and withdrawals — with a guardian on every child, which is what makes the rest work.",
  },
  {
    icon: FileText,
    title: "Marks, results and report cards",
    body:
      "Score entry by class and subject, continuous assessment and exams weighted your way, " +
      "positions, and terminal reports the head signs off before a parent ever sees them.",
  },
  {
    icon: Printer,
    title: "Report cards that print properly",
    body:
      "A whole class, one A4 sheet each, in the format your school already uses. Unpublished " +
      "cards are withheld from the print run rather than going home half-finished.",
  },
  {
    icon: Coins,
    title: "Fees, in cedis",
    body:
      "Fee structures per level, invoices per term, part-payments in cash or mobile money, " +
      "discounts, and a debtors list that tells the bursar who to call on Monday.",
  },
  {
    icon: Building2,
    title: "A bursar's cash book",
    body:
      "Expenses against headings the school recognises, recorded and approved, so the money going " +
      "out is as visible as the money coming in.",
  },
];

export function Marketing() {
  const price = PLANS.INSTITUTION_PLUS.monthlyPrice;

  return (
    <div className="min-h-full bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-hairline bg-chrome backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5">
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 font-heading text-base text-white">
              S
            </span>
            <span className="text-sm font-semibold text-slate-900">School OS</span>
          </span>
          <Link
            href="/login"
            className="text-sm font-semibold text-brand-ink hover:text-brand-700"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-5xl px-5 pb-16 pt-16 sm:pt-24">
          <p className="text-sm font-semibold text-accent-700">
            For Ghanaian schools, from KG to JHS
          </p>
          <h1 className="mt-3 max-w-2xl font-heading text-4xl leading-tight text-slate-900 sm:text-5xl">
            One place for the pupils, the marks and the fees.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-600">
            School OS keeps the register, works out the terminal results, prints the report cards
            and chases the fees — built around three terms, GES conventions and the way a Ghanaian
            school office actually runs.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href={mailto} variant="primary">
              Ask for a free trial
            </ButtonLink>
            <ButtonLink href="#pricing" variant="secondary">
              What it costs
            </ButtonLink>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            {TRIAL_DAYS} days free. No card, no setup fee.
          </p>
        </section>

        <section className="mx-auto max-w-5xl px-5 pb-20">
          <div className="grid gap-4 sm:grid-cols-2">
            {FEATURES.map(({ icon: Glyph, title, body }) => (
              <div
                key={title}
                className="rounded-card border border-hairline bg-surface p-6 shadow-card"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-ink">
                  <Glyph className="h-5 w-5" aria-hidden="true" />
                </span>
                <h2 className="mt-4 text-base font-semibold text-slate-900">{title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-y border-hairline bg-surface">
          <div className="mx-auto grid max-w-5xl gap-8 px-5 py-16 sm:grid-cols-2">
            <div>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-ink">
                <MessageSquare className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="mt-4 font-heading text-2xl text-slate-900">
                Parents see their own child, and nobody else&rsquo;s
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                A parent signs in and finds the results the school has published, the fees owed and
                what has been paid. They cannot see another family&rsquo;s child, and they cannot
                change anything. Guardians with children in two schools get one login.
              </p>
            </div>
            <div>
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-ink">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </span>
              <h2 className="mt-4 font-heading text-2xl text-slate-900">
                Your school&rsquo;s records stay your school&rsquo;s
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                Every school&rsquo;s data is separated by the database itself, not by code that
                remembers to filter — so one school cannot read another&rsquo;s pupils, guardians or
                invoices. Backed up nightly, and the backup is restored and checked every night
                rather than assumed.
              </p>
            </div>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-5xl px-5 py-20">
          <div className="mx-auto max-w-md rounded-panel border border-hairline bg-surface p-8 text-center shadow-raised">
            <p className="text-sm font-semibold text-accent-700">Institution Plus</p>
            <p className="mt-3 font-heading text-5xl text-slate-900">
              GH&#8373;{price}
            </p>
            <p className="mt-1 text-sm text-slate-500">a month, for the whole school</p>
            <p className="mt-6 text-sm leading-relaxed text-slate-600">
              Every pupil, every member of staff, every term. No per-pupil charge and no limit on
              roll size — a school of 900 pays what a school of 90 pays, because the work the
              software does is the same.
            </p>
            <div className="mt-7">
              <ButtonLink href={mailto} variant="primary">
                Ask for a free trial
              </ButtonLink>
            </div>
            <p className="mt-4 text-sm text-slate-500">
              {TRIAL_DAYS} days free first. Cancel by saying so — there is no contract.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline bg-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-5 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <span>Nanicle Enterprise Solutions</span>
          <a href={mailto} className="font-semibold text-brand-ink hover:text-brand-700">
            {CONTACT}
          </a>
        </div>
      </footer>
    </div>
  );
}
