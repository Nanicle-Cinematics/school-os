import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { getDuplicateCards, type DuplicateSide } from "@/lib/duplicate-data";
import { REASON_TEXT } from "@/lib/duplicate-detect";
import { mergeDuplicate } from "@/lib/duplicate-actions";
import { Alert, Card, PageHeader } from "../../ui";
import { SubmitButton } from "../../submit-button";

export const metadata: Metadata = { title: "Possible duplicates · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

function Facts({ side }: { side: DuplicateSide }) {
  const history = [
    side.invoices ? `${side.invoices} invoice${side.invoices === 1 ? "" : "s"}` : null,
    side.payments ? `${side.payments} payment${side.payments === 1 ? "" : "s"}` : null,
    side.scores ? `${side.scores} score${side.scores === 1 ? "" : "s"}` : null,
    side.results ? `${side.results} report card${side.results === 1 ? "" : "s"}` : null,
    side.register ? `${side.register} register mark${side.register === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return (
    <dl className="mt-2 space-y-1 text-sm text-slate-600">
      <div>Admission no. <span className="font-mono text-slate-900">{side.admissionNo}</span></div>
      <div>Born {side.dateOfBirth ? dateFmt.format(side.dateOfBirth) : "not recorded"} · {side.gender.toLowerCase()} · {side.status.toLowerCase()}</div>
      <div>Class: {side.className ?? "none this year"}</div>
      <div>Parents: {side.guardians.length ? side.guardians.join(", ") : "none linked"}</div>
      <div>Holds: {history.length ? history.join(", ") : "nothing yet"}</div>
      <div>Entered {dateFmt.format(side.createdAt)}</div>
      <div>
        <Link href={`/students/${side.id}`} className="font-semibold text-brand-ink hover:underline">
          Open the record
        </Link>
      </div>
    </dl>
  );
}

export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole(LEADERSHIP);
  const query = await searchParams;
  const cards = await getDuplicateCards();
  const error = typeof query.error === "string" ? query.error : "";
  const merged = typeof query.merged === "string" ? query.merged : "";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Possible duplicates"
        subtitle={cards.length === 0 ? "None found" : `${cards.length} ${cards.length === 1 ? "pair" : "pairs"} to check`}
        action={
          <Link href="/students" className="text-sm font-semibold text-slate-600 hover:text-slate-900">
            Back to students
          </Link>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {merged ? <Alert tone="success">Merged. {merged}</Alert> : null}

      <p className="text-sm text-slate-600">
        These are suggestions, not decisions: two different children can share a name. For each pair, choose the record
        to <strong>keep</strong>. Its payments, marks, register entries and parents are joined with the other
        record&apos;s, and the other record is removed from the school. A pair is refused, with the reason, when both
        records hold the same kind of record (for example a score for the same test).
      </p>

      {cards.length === 0 ? (
        <Card>
          <p className="px-4.5 py-8 text-center text-sm text-slate-500">
            No pupil looks like another. Check again after an import or a batch of new admissions.
          </p>
        </Card>
      ) : null}

      {cards.map(({ pair, a, b, suggestKeep }) => (
        <Card key={`${pair.a}-${pair.b}`} title={REASON_TEXT[pair.reason]} action={<span className="text-xs font-semibold text-slate-500">{pair.confidence === "high" ? "Very likely" : "Possible"}</span>}>
          <form action={mergeDuplicate} className="space-y-4 px-4.5 py-4">
            <input type="hidden" name="a" value={pair.a} />
            <input type="hidden" name="b" value={pair.b} />
            <div className="grid gap-4 md:grid-cols-2">
              {[a, b].map((side) => (
                <label key={side.id} className="block cursor-pointer rounded-card border border-hairline p-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
                  <span className="flex items-center gap-2 font-semibold text-slate-900">
                    <input type="radio" name="keep" value={side.id} defaultChecked={side.id === suggestKeep} required />
                    Keep {side.name}
                    {side.id === suggestKeep ? <span className="text-xs font-medium text-slate-500">(suggested)</span> : null}
                  </span>
                  <Facts side={side} />
                </label>
              ))}
            </div>
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" name="confirm" value="yes" className="mt-0.5" required />
              <span>I have checked these are the same child. I understand this cannot be undone from the screen.</span>
            </label>
            <SubmitButton pendingLabel="Merging…">Merge the two records</SubmitButton>
          </form>
        </Card>
      ))}
    </div>
  );
}
