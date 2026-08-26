import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { deleteAcademicYear } from "@/lib/term-actions";
import { setCurrentTerm } from "@/lib/settings-actions";
import { getYearUsage } from "@/lib/settings-data";
import { Alert, Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { NewYearForm, TermRowForm } from "./term-forms";

export const metadata: Metadata = { title: "Years and terms · School OS" };

function iso(value: Date | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

export default async function TermsPage() {
  await requireRole(OFFICE);

  const years = await prisma.academicYear.findMany({
    orderBy: { startDate: "desc" },
    include: { terms: { orderBy: { sequence: "asc" } } },
  });

  const usage = await getYearUsage(years);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          ← Settings
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Years and terms</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          The calendar every other screen hangs off. Invoicing, score entry and the dashboard all
          read the current term.
        </p>
      </div>

      <Card title="Add an academic year">
        <NewYearForm />
      </Card>

      {years.length === 0 ? (
        <Alert tone="error">
          No academic year exists yet, so nothing can be invoiced or graded. Add one above.
        </Alert>
      ) : null}

      {years.map((year) => {
        const used = usage.get(year.id) ?? 0;
        return (
          <Card
            key={year.id}
            title={`${year.name}${year.isCurrent ? " · current" : ""}`}
            action={
              used > 0 ? (
                <span className="text-xs text-slate-400" title="Billed, graded or enrolled against.">
                  {used} record{used === 1 ? "" : "s"} attached
                </span>
              ) : (
                <form action={deleteAcademicYear}>
                  <input type="hidden" name="id" value={year.id} />
                  <SubmitButton variant="danger" pendingLabel="…">
                    Delete year
                  </SubmitButton>
                </form>
              )
            }
          >
            <ul>
              {year.terms.map((term) => (
                <TermRowForm
                  key={term.id}
                  term={{
                    id: term.id,
                    name: term.name,
                    sequence: term.sequence,
                    startDate: iso(term.startDate),
                    endDate: iso(term.endDate),
                    vacationDate: iso(term.vacationDate),
                    nextTermBegins: iso(term.nextTermBegins),
                    isCurrent: term.isCurrent,
                  }}
                />
              ))}
            </ul>

            {year.terms.some((term) => !term.isCurrent) ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 p-4">
                <span className="text-xs text-slate-500">Switch the school to:</span>
                {year.terms
                  .filter((term) => !term.isCurrent)
                  .map((term) => (
                    <form key={term.id} action={setCurrentTerm}>
                      <input type="hidden" name="termId" value={term.id} />
                      <SubmitButton variant="secondary" pendingLabel="…">
                        Term {term.sequence}
                      </SubmitButton>
                    </form>
                  ))}
              </div>
            ) : null}
          </Card>
        );
      })}

      <p className="text-xs text-slate-400">
        A year that has been billed, graded or enrolled against cannot be deleted — invoices and
        results hang off its terms and would go with it. Deleting the current year is allowed while
        it is still empty; the school is then left with no current term until you set one.
      </p>
    </div>
  );
}
