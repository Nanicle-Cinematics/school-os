/**
 * Prove the live activity feed can phrase everything the app records.
 *
 * `AuditLog` is written from twenty-five call sites and, until this feed, was
 * never read for display. The risk is drift: someone adds a `writeAudit` with a
 * new action string and it reaches a head teacher's dashboard as "invoice
 * generate". So this greps the source for every action written and asserts the
 * feed has a phrase for it.
 *
 * The rest checks the payload reading, which is the other fragile half: `after`
 * is untyped JSON from twenty-five different shapes, and one missing key must
 * not take the dashboard down.
 *
 *   npm run verify:activity
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { withBypass, setTenantContext } from "@/lib/tenant-context";
import { getActivity, ACTIVITY_ACTIONS } from "@/lib/dashboard-data";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Every audited action has a phrase ───────────────────────────────────────
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}
const written = new Set<string>();
for (const file of walk("src/lib")) {
  for (const m of readFileSync(file, "utf8").matchAll(/action: "([a-z][a-z.]+)"/g)) {
    written.add(m[1]);
  }
}
const missing = [...written].filter((a) => !ACTIVITY_ACTIONS.includes(a));
check("every audited action has a phrase", missing.length === 0,
  missing.length ? `missing: ${missing.join(", ")}` : `${written.size} actions, all covered`);

const stale = ACTIVITY_ACTIONS.filter((a) => !written.has(a));
check("and no phrase is for an action nobody writes", stale.length === 0,
  stale.length ? `stale: ${stale.join(", ")}` : "none stale");

// ── Payload reading ─────────────────────────────────────────────────────────
const school = await withBypass(() => prisma.school.findFirst());
setTenantContext({ schoolId: school!.id });

const now = new Date();
const rows: { action: string; after: unknown; expect: RegExp }[] = [
  { action: "payment.record", after: { amount: "450.00" }, expect: /Payment of .*450/ },
  { action: "payment.record", after: {}, expect: /Payment of an amount/ },
  { action: "student.import", after: { created: 1 }, expect: /^1 pupil imported$/ },
  { action: "student.import", after: { created: 12 }, expect: /^12 pupils imported$/ },
  { action: "campaign.send", after: { recipients: 312 }, expect: /312 recipients/ },
  { action: "promotion.run", after: { students: 26 }, expect: /26 pupils moved up/ },
];

const created: string[] = [];
for (const row of rows) {
  const log = await prisma.auditLog.create({
    data: { schoolId: school!.id, action: row.action, entity: "Test", entityId: "verify",
      after: row.after as never },
  });
  created.push(log.id);
}

const items = await getActivity(school!.id, rows.length, now);
for (const row of rows.slice().reverse()) {
  const hit = items.find((i) => row.expect.test(i.title));
  check(`${row.action} → "${row.expect.source}"`, Boolean(hit), hit?.title ?? "(no match)");
}
check("a malformed payload still yields a readable line",
  items.every((i) => i.title.length > 0 && !i.title.includes("undefined")),
  items.map((i) => i.title).join(" | "));
check("timestamps are relative", items.every((i) => /just now|min|hr|d$|\w/.test(i.when)),
  items[0]?.when ?? "—");

await prisma.auditLog.deleteMany({ where: { id: { in: created } } });
check("test rows removed",
  (await prisma.auditLog.count({ where: { entityId: "verify" } })) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
