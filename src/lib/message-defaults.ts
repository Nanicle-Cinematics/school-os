import type { TenantTx } from "@/lib/prisma";

/**
 * The texts a school sends without composing them, and the names the app finds
 * them by.
 *
 * A `MessageTemplate` is looked up by NAME, and provisioning created none — only
 * the demo seed did. So every real school had an empty table, and
 * `queueTransactionalSms` answered a missing template by returning: payment
 * receipts have never gone out for a school that was not the demo, and nothing
 * anywhere said so. The compose screen's "start from a template" picker was
 * empty for the same reason, which is the visible half of the same gap.
 *
 * ⚠️ **No `import "server-only"` here**, unlike the other defaults modules: the
 * demo seed imports this list so the two cannot drift, and it runs under plain
 * `tsx`, where that import throws. Keep this file free of runtime imports from
 * the app — the `TenantTx` import is type-only and erased.
 */

/**
 * The templates the APP sends by itself, keyed by the name it looks up.
 *
 * Referenced rather than typed out at the call site, so renaming one here
 * renames it everywhere it is sent from — a literal that drifted from the
 * seeded name would be indistinguishable from having no template at all.
 */
export const TRANSACTIONAL = {
  paymentReceived: "Payment Received",
  resultsPublished: "Results Published",
} as const;

export const DEFAULT_MESSAGE_TEMPLATES: { name: string; body: string }[] = [
  {
    name: TRANSACTIONAL.paymentReceived,
    body:
      "Dear {{guardian_name}}, we have received GHS {{amount}} for {{student_name}}. " +
      "Outstanding balance: GHS {{balance}}. Receipt No: {{receipt_no}}. Thank you. - {{school_name}}",
  },
  {
    name: "Fee Reminder",
    body:
      "Dear {{guardian_name}}, {{student_name}} has an outstanding balance of GHS {{balance}} " +
      "for {{term}}. Kindly settle on or before {{due_date}}. - {{school_name}}",
  },
  {
    name: TRANSACTIONAL.resultsPublished,
    body:
      "Dear {{guardian_name}}, {{student_name}}'s {{term}} report is now ready. " +
      "Log in to the parent portal to view it. - {{school_name}}",
  },
  {
    name: "Term Reopening",
    body:
      "Dear Parent, {{school_name}} reopens on {{reopening_date}} for {{term}}. " +
      "Please ensure {{student_name}} reports on time. Thank you.",
  },
];

/**
 * The packaged wording for a template the school does not have.
 *
 * The last line of defence for an automatic text: a school that never got these
 * rows, or deleted one, still sends the standard message instead of nothing.
 * Silence is the failure that cannot be noticed — a parent does not report a
 * receipt they never expected.
 */
export function defaultTemplateBody(name: string): string | undefined {
  return DEFAULT_MESSAGE_TEMPLATES.find((t) => t.name === name)?.body;
}

export type MessageDefaultsResult = { created: number; skipped: number };

/**
 * Give a school the standard messages.
 *
 * Idempotent on `name`, which is unique per school — so it fills the gap for a
 * school provisioned before this existed, and never overwrites wording the
 * school has since edited.
 */
export async function applyDefaultMessageTemplates(
  tx: TenantTx,
  schoolId: string,
): Promise<MessageDefaultsResult> {
  // Read then bulk-write, for the reason spelled out in ges-curriculum.ts: this
  // runs inside the provisioning transaction over a single pooled connection,
  // where a per-row existence check is four more sequential round trips.
  const existing = await tx.messageTemplate.findMany({
    where: { schoolId, name: { in: DEFAULT_MESSAGE_TEMPLATES.map((t) => t.name) } },
    select: { name: true },
  });
  const have = new Set(existing.map((t) => t.name));

  const missing = DEFAULT_MESSAGE_TEMPLATES.filter((t) => !have.has(t.name));
  if (missing.length === 0) {
    return { created: 0, skipped: existing.length };
  }

  const created = await tx.messageTemplate.createMany({
    data: missing.map((t) => ({ schoolId, ...t, channel: "SMS" as const, isSystem: true })),
  });

  return { created: created.count, skipped: existing.length };
}
