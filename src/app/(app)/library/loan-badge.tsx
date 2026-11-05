import type { LoanState } from "@/lib/library-rules";
import { LOAN_STATE_LABEL } from "@/lib/library-rules";

const TONE: Record<LoanState, string> = {
  OUT: "bg-info-tint text-info-ink",
  OVERDUE: "bg-danger-tint text-danger-ink",
  RETURNED: "bg-slate-100 text-slate-500",
  LOST: "bg-warning-tint text-warning-ink",
};

/** Out, overdue, returned or lost. Overdue is worked out when the page is read, never read from a column. */
export function LoanBadge({ state, days }: { state: LoanState; days?: number }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${TONE[state]}`}>
      {LOAN_STATE_LABEL[state].toLowerCase()}
      {state === "OVERDUE" && days ? ` ${days}d` : ""}
    </span>
  );
}
