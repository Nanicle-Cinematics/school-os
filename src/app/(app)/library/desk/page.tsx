import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LIBRARY } from "@/lib/permissions";
import { getBorrowerDesk, searchBorrowers } from "@/lib/library-data";
import { borrowerProblem, limitFor, renewCheck } from "@/lib/library-rules";
import { Avatar, Card, PageHeader, filterClass } from "../../ui";
import { day } from "../format";
import { LibraryNav } from "../library-nav";
import { BorrowerLoans, LendForm, ReturnForm, type LoanItem } from "../forms";

export const metadata: Metadata = { title: "Lend and return · School OS" };
export const dynamic = "force-dynamic";

/** The desk has one string for a name; the avatar wants the two ends of it. */
const ends = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.length > 1 ? parts[parts.length - 1]! : "" };
};

export default async function DeskPage({ searchParams }: PageProps<"/library/desk">) {
  const auth = await requireRole(LIBRARY);
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const kind = params.kind === "STUDENT" || params.kind === "STAFF" ? params.kind : null;
  const id = typeof params.id === "string" ? params.id : "";

  const hits = q && !(kind && id) ? await searchBorrowers(auth.schoolId, q) : [];
  const borrower = kind && id ? await getBorrowerDesk(auth.schoolId, kind, id) : null;

  const problem = borrower
    ? borrowerProblem(borrower.kind, { status: borrower.status, deletedAt: borrower.deletedAt, name: borrower.name })
    : null;
  const items: LoanItem[] = (borrower?.loans ?? []).map((loan) => ({
    id: loan.id,
    title: loan.title,
    author: loan.author,
    accessionNo: loan.accessionNo,
    dueOn: day(loan.dueOn),
    state: loan.state,
    daysOverdue: loan.daysOverdue,
    renewals: loan.renewals,
    // These are open loans, so there is no outcome yet; a copy that is out is in stock by definition.
    canRenew: renewCheck({ ...loan, outcome: null }, "ACTIVE").ok,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Lend and return" subtitle="Scan or type the number inside the book. Taking one back needs no name." />
      <LibraryNav current="/library/desk" />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Take a book back">
          <div className="px-4.5 py-4">
            <ReturnForm />
          </div>
        </Card>

        <Card title="Lend a book">
          {borrower ? (
            <div className="space-y-3 px-4.5 py-4">
              <div className="flex items-center gap-3">
                <Avatar {...ends(borrower.name)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{borrower.name}</p>
                  <p className="text-xs text-slate-500">
                    {borrower.detail} · {borrower.loans.length} of {limitFor(borrower.kind, borrower.policy)} books out
                    {borrower.overdue ? ` · ${borrower.overdue} overdue` : ""}
                  </p>
                </div>
                <Link href="/library/desk" className="text-sm text-brand-ink hover:underline">
                  Someone else
                </Link>
              </div>
              {problem ? <p role="alert" className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">{problem}</p> : <LendForm kind={borrower.kind} borrowerId={borrower.id} />}
            </div>
          ) : (
            <div className="space-y-3 px-4.5 py-4">
              {kind && id ? <p className="text-sm text-slate-600">That person was not found. Search again.</p> : null}
              <form className="flex gap-2" role="search">
                <input
                  type="search"
                  name="q"
                  defaultValue={q}
                  autoComplete="off"
                  aria-label="Find a pupil or member of staff"
                  placeholder="Name or admission number"
                  className={`${filterClass} min-w-0 flex-1`}
                />
                <button type="submit" className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
                  Find
                </button>
              </form>
              {q ? (
                hits.length > 0 ? (
                  <ul className="divide-y divide-hairline rounded-control border border-hairline">
                    {hits.map((hit) => (
                      <li key={`${hit.kind}-${hit.id}`}>
                        <Link href={`/library/desk?kind=${hit.kind}&id=${hit.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
                          <Avatar {...ends(hit.name)} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900">{hit.name}</span>
                            <span className="block truncate text-xs text-slate-500">{hit.detail}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">No pupil on the roll or member of staff matches &ldquo;{q}&rdquo;.</p>
                )
              ) : (
                <p className="text-xs text-slate-400">Two letters of a name, or an admission or staff number.</p>
              )}
            </div>
          )}
        </Card>
      </div>

      {borrower ? (
        <Card title={`Books ${borrower.name} has out`}>
          <BorrowerLoans loans={items} />
        </Card>
      ) : (
        <p className="px-0.5 text-sm text-slate-500">
          To see everything that is out at once, open{" "}
          <Link href="/library/loans" className="text-brand-ink hover:underline">
            Out now
          </Link>
          .
        </p>
      )}
    </div>
  );
}
