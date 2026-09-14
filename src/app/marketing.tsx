import Image from "next/image";
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
 * The real dashboard, captured from the demo school.
 *
 * ⚠️ It is a CAPTURE, so it goes stale the moment the screen changes. Retake it
 * from a signed-in session rather than editing it, and check two things the
 * first version got wrong: the demo proprietor is a platform admin on dev, so
 * the header carried a "Nanicle console" button no customer will ever see; and
 * the activity feed was six "rows exported" entries left over from testing the
 * export. Both are true of the product only for me.
 */
import dashboardShot from "../../public/product-dashboard.png";

/**
 * How a school reaches a person. Two ways, deliberately.
 *
 * The phone is not a nicety here: a Ghanaian school proprietor is far likelier
 * to WhatsApp a number than to fill in anything, and an email-only page quietly
 * loses the people most ready to buy.
 *
 * ⚠️ Still a personal inbox and a personal number. Swap both for Nanicle ones
 * before this page is advertised anywhere — an address on a public page is an
 * address that gets scraped.
 */
const CONTACT = {
  email: "degraftnanaaboagye@gmail.com",
  /** E.164 for the links; `phoneShown` is the same number for human eyes. */
  phone: "+233503635922",
  phoneShown: "+233 50 363 5922",
};

const SUBJECT = encodeURIComponent("School OS — trial for my school");
const mailto = `mailto:${CONTACT.email}?subject=${SUBJECT}`;
/** wa.me wants the number with no plus and no spaces. */
const whatsapp = `https://wa.me/${CONTACT.phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(
  "Hello, I would like a trial of School OS for my school.",
)}`;

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
  const plan = PLANS.INSTITUTION;

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
            {TRIAL_DAYS} days free. No card, no setup fee. Or call or WhatsApp{" "}
            <a href={`tel:${CONTACT.phone}`} className="font-semibold text-brand-ink hover:text-brand-700">
              {CONTACT.phoneShown}
            </a>
            .
          </p>

          {/* The product, not a drawing of it. A school office decides in about
              four seconds whether software looks like something they could sit
              a secretary in front of, and no paragraph does that work. */}
          {/* ⚠️ On a phone the whole dashboard is a grey smudge — 1440px of
              screen squeezed into 414 makes every figure illegible, and an
              illegible screenshot is 400KB that says nothing. So small screens
              get the top-left CORNER at a readable scale and the rest clipped,
              which is the part that carries the meaning: the school, the roll,
              and the money. Full width from `sm` up. */}
          <div className="mt-14 overflow-hidden rounded-panel border border-hairline bg-surface shadow-raised">
            <Image
              src={dashboardShot}
              alt="The School OS dashboard: 44 pupils on roll, fees collected against fees billed, families owing, and the report cards still waiting to be published."
              placeholder="blur"
              priority
              sizes="(max-width: 640px) 240vw, (max-width: 1024px) 100vw, 1024px"
              className="w-[240%] max-w-none sm:w-full"
            />
          </div>
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
            <p className="text-sm font-semibold text-accent-700">{plan.label}</p>
            <p className="mt-3 font-heading text-5xl text-slate-900">
              GH&#8373;{plan.monthlyPrice}
            </p>
            <p className="mt-1 text-sm text-slate-500">a month, for the whole school</p>
            <p className="mt-6 text-sm leading-relaxed text-slate-600">
              Every pupil, every member of staff, every term. No per-pupil charge and no limit on
              roll size — a school of 900 pays what a school of 90 pays, because the work the
              software does is the same.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <ButtonLink href={mailto} variant="primary">
                Ask for a free trial
              </ButtonLink>
              <ButtonLink href={whatsapp} variant="secondary" icon={MessageSquare}>
                WhatsApp us
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
          <span className="flex flex-wrap gap-x-5 gap-y-1">
            <a href={mailto} className="font-semibold text-brand-ink hover:text-brand-700">
              {CONTACT.email}
            </a>
            <a
              href={`tel:${CONTACT.phone}`}
              className="font-semibold text-brand-ink hover:text-brand-700"
            >
              {CONTACT.phoneShown}
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
