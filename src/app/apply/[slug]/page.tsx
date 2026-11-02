import type { Metadata } from "next";
import { isBusy, publicLookup } from "@/lib/public-route";
import { getPublicForm, looksLikeSlug } from "@/lib/admissions-public";
import { ApplyForm } from "./apply-form";

export const metadata: Metadata = {
  title: "Apply for a place",
  // A school shares this link by text and QR code. It is not something to find through a search engine.
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/**
 * A school's public application form, for a parent with no login.
 *
 * Outside both `(app)` and `(portal)`, like /login and /forgot: those layouts divert a signed-in session, and
 * a page for a stranger must sit where no such redirect can reach it. The lookup runs inside the public
 * budget; a school with no form, a closed form and a slug that is not a school show the same page.
 */
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-full justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-xl">
        <h1 className="mb-1 text-center font-heading text-2xl text-slate-900">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export default async function ApplyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let form = null;
  if (looksLikeSlug(slug)) {
    try {
      form = await publicLookup(() => getPublicForm(slug));
    } catch (error) {
      if (isBusy(error)) {
        return (
          <Shell title="Please try again in a moment">
            <p className="mt-3 text-center text-sm text-slate-500">The page is busy. Refresh in a few seconds.</p>
          </Shell>
        );
      }
      throw error;
    }
  }

  if (!form) {
    return (
      <Shell title="This form is not available">
        <p className="mt-3 text-center text-sm text-slate-500">
          The school is not taking applications here right now. Please ask the school office.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title={`Apply to ${form.school.name}`}>
      {form.school.motto ? <p className="text-center text-sm italic text-slate-500">{form.school.motto}</p> : null}
      {form.note ? (
        <p className="mt-4 whitespace-pre-line rounded-control bg-info-tint px-3.5 py-3 text-sm text-info-ink">{form.note}</p>
      ) : null}
      <div className="mt-5 rounded-card border border-hairline bg-surface p-5 shadow-card">
        <ApplyForm slug={slug} levels={form.levels} years={form.years} />
      </div>
      <p className="mt-4 text-center text-xs text-slate-400">
        The school keeps this information to decide on your application and, if it is accepted, to register your child.
      </p>
    </Shell>
  );
}
