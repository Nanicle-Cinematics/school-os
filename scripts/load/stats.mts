/**
 * Numbers for the load test's report. Pure.
 */

export type Sample = {
  /** What was asked for, in words a report can print: "portal home", "save register". */
  label: string;
  /** Wall time until the whole response body arrived. */
  ms: number;
  /** HTTP status, or 0 for a timeout / refused connection. */
  status: number;
  /** The request did what it was for, not merely answered. */
  ok: boolean;
  /** "page" for a read, "action" for a form post, "login" for a sign-in. */
  kind: "page" | "action" | "login";
};

/** Nearest-rank percentile of an ASCENDING array. 0 for an empty one. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export type Row = {
  label: string;
  kind: Sample["kind"];
  count: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  perSecond: number;
};

export function summarise(samples: Sample[], elapsedSeconds: number): Row[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = groups.get(sample.label) ?? [];
    list.push(sample);
    groups.set(sample.label, list);
  }
  const rows: Row[] = [];
  for (const [label, list] of groups) {
    const times = list.map((s) => s.ms).sort((a, b) => a - b);
    rows.push({
      label,
      kind: list[0]!.kind,
      count: list.length,
      failed: list.filter((s) => !s.ok).length,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      p99: percentile(times, 99),
      max: times[times.length - 1] ?? 0,
      perSecond: elapsedSeconds > 0 ? list.length / elapsedSeconds : 0,
    });
  }
  return rows.sort((a, b) => b.p95 - a.p95);
}

/** What "good enough" means, per kind of request. Overridable on the command line. */
export type Budget = {
  pageP95Ms: number;
  actionP95Ms: number;
  loginP95Ms: number;
  /** Fraction of ALL requests, 0.01 = 1%. */
  errorRate: number;
};

export const DEFAULT_BUDGET: Budget = {
  pageP95Ms: 1500,
  actionP95Ms: 4000,
  loginP95Ms: 3000,
  errorRate: 0.01,
};

export function judge(rows: Row[], budget: Budget): string[] {
  const failures: string[] = [];
  const limit: Record<Sample["kind"], number> = {
    page: budget.pageP95Ms,
    action: budget.actionP95Ms,
    login: budget.loginP95Ms,
  };
  for (const row of rows) {
    if (row.count >= 5 && row.p95 > limit[row.kind]) {
      failures.push(`${row.label}: p95 ${Math.round(row.p95)} ms is over the ${limit[row.kind]} ms budget for a ${row.kind}`);
    }
  }
  const total = rows.reduce((n, r) => n + r.count, 0);
  const failed = rows.reduce((n, r) => n + r.failed, 0);
  if (total > 0 && failed / total > budget.errorRate) {
    failures.push(`${failed} of ${total} requests failed (${((failed / total) * 100).toFixed(1)}%), over the ${(budget.errorRate * 100).toFixed(1)}% budget`);
  }
  if (total === 0) failures.push("no requests were made, so nothing was measured");
  return failures;
}
