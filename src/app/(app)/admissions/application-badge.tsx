import type { ApplicationStatus } from "@prisma/client";
import { STATUS_LABEL } from "@/lib/admissions-rules";

const TONE: Record<ApplicationStatus, string> = {
  APPLIED: "bg-info-tint text-info-ink",
  TESTING: "bg-info-tint text-info-ink",
  WAITLISTED: "bg-slate-100 text-slate-600",
  OFFERED: "bg-warning-tint text-warning-ink",
  ACCEPTED: "bg-success-tint text-success-ink",
  ADMITTED: "bg-success-tint text-success-ink",
  REJECTED: "bg-slate-100 text-slate-500",
  WITHDRAWN: "bg-slate-100 text-slate-500",
};

/** The pipeline step, in words. An offer past its date reads as lapsed, which only the reader can know. */
export function ApplicationBadge({ status, lapsed = false }: { status: ApplicationStatus; lapsed?: boolean }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${lapsed ? "bg-danger-tint text-danger-ink" : TONE[status]}`}>
      {lapsed ? "Offer lapsed" : STATUS_LABEL[status]}
    </span>
  );
}
