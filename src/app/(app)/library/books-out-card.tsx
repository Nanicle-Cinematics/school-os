import Link from "next/link";
import type { LoanRow } from "@/lib/library-data";
import { Card } from "../ui";
import { day } from "./format";
import { LoanBadge } from "./loan-badge";

/**
 * The books a pupil or a member of staff has out, on their own page, so the office sees it where the conversation
 * happens. Shown only when something is out: a person with no library books costs the page nothing but one query.
 */
export function BooksOutCard({ loans, kind, id }: { loans: LoanRow[]; kind: "STUDENT" | "STAFF"; id: string }) {
  if (loans.length === 0) return null;
  const late = loans.filter((loan) => loan.state === "OVERDUE").length;
  return (
    <Card
      title={`Library · ${loans.length} ${loans.length === 1 ? "book" : "books"} out${late ? `, ${late} overdue` : ""}`}
      action={
        <Link href={`/library/desk?kind=${kind}&id=${id}`} className="text-sm text-brand-ink hover:underline">
          Open at the library desk
        </Link>
      }
    >
      <ul className="divide-y divide-hairline">
        {loans.map((loan) => (
          <li key={loan.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900">{loan.title}</p>
              <p className="text-xs text-slate-500">
                {loan.accessionNo} · due {day(loan.dueOn)}
              </p>
            </div>
            <LoanBadge state={loan.state} days={loan.daysOverdue} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
