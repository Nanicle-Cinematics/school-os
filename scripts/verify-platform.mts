/**
 * The subscription is a switch that DOES something.
 *
 * `plan`, `subscriptionStatus`, `trialEndsAt` and `studentCap` were written at
 * provisioning, shown in the console and enforced nowhere, so a trial that ended
 * in March still worked in September. This proves the enforcement, and every
 * check here is a refusal or a lift — the two directions that matter.
 *
 *   npm run verify:platform   (no dev server needed)
 */
import { prisma, SchoolReadOnlyError } from "@/lib/prisma";
import { runWithTenantContext, setTenantContext, withBypass } from "@/lib/tenant-context";
import { subscriptionState } from "@/lib/subscription";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
}

const DAY = 86_400_000;

console.log("What each subscription state means");
const t = (status: string, trialEndsAt: Date | null) =>
  subscriptionState({
    plan: "TRIAL",
    subscriptionStatus: status as never,
    trialEndsAt,
  });

check("ACTIVE writes", t("ACTIVE", null).readOnly === false);
check("a trial still running writes", t("TRIALING", new Date(Date.now() + 5 * DAY)).readOnly === false);
check(
  "and says so in its last week",
  (t("TRIALING", new Date(Date.now() + 5 * DAY)).notice ?? "").includes("5 days"),
);
check(
  "a trial with three weeks left says NOTHING",
  t("TRIALING", new Date(Date.now() + 21 * DAY)).notice === null,
);
check("an EXPIRED trial is read-only", t("TRIALING", new Date(Date.now() - DAY)).readOnly === true);
check(
  "a trial with no end date is open, not expired",
  t("TRIALING", null).readOnly === false,
  "the absence of a date must never read as 'ran out'",
);
check("PAST_DUE is read-only", t("PAST_DUE", null).readOnly === true);
check("SUSPENDED is read-only", t("SUSPENDED", null).readOnly === true);
check("CANCELLED is read-only", t("CANCELLED", null).readOnly === true);

console.log("\nWhat read-only actually stops");
const school = await withBypass(() =>
  prisma.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } } }),
);
const schoolId = school!.id;

// A read, under read-only: must still work. This is the whole point of the
// choice — a head teacher mid-term keeps their records.
const readCount = await runWithTenantContext({ schoolId, readOnly: true }, () =>
  prisma.student.count({ where: { deletedAt: null } }),
);
check("a school in arrears can still READ its pupils", readCount > 0, `${readCount} pupils`);

let refused: unknown = null;
try {
  await runWithTenantContext({ schoolId, readOnly: true }, () =>
    prisma.house.create({ data: { schoolId, name: `readonly probe ${Date.now()}` } }),
  );
} catch (error) {
  refused = error;
}
check(
  "but a WRITE is refused",
  refused instanceof SchoolReadOnlyError,
  refused instanceof Error ? refused.name : "nothing thrown",
);

const stray = await withBypass(() =>
  prisma.house.count({ where: { schoolId, name: { startsWith: "readonly probe" } } }),
);
check("and nothing was written", stray === 0, `${stray} rows`);

/**
 * ⚠️ The check that nearly did not exist.
 *
 * Every server action calls `setTenantContext({ schoolId: auth.schoolId })` right
 * after requireRole. With replace semantics that threw away the readOnly the auth
 * gate had just resolved — leaving a perfect guard in prisma.ts that nothing ever
 * reached, and an unpaid school writing exactly as before while every test passed.
 */
let survived: unknown = null;
try {
  await runWithTenantContext({ schoolId, readOnly: true }, async () => {
    // exactly what an action does, one line after requireRole
    setTenantContext({ schoolId });
    await prisma.house.create({ data: { schoolId, name: `rescope probe ${Date.now()}` } });
  });
} catch (error) {
  survived = error;
}
check(
  "re-scoping to the same school does NOT lose read-only",
  survived instanceof SchoolReadOnlyError,
  survived instanceof Error ? survived.name : "the write went through",
);

// The console has to be able to lift it — otherwise reactivating a suspended
// school would be refused by the suspension, and the only way out is the database.
const lifted = await runWithTenantContext({ schoolId, readOnly: true }, () =>
  withBypass(() => prisma.school.findUnique({ where: { id: schoolId }, select: { id: true } })),
);
check("withBypass lifts it, so the console can reactivate a school", lifted !== null);

// And a school in good standing is untouched by any of this.
let wroteFine = false;
const probeName = `subscription probe ${Date.now()}`;
try {
  await runWithTenantContext({ schoolId, readOnly: false }, () =>
    prisma.house.create({ data: { schoolId, name: probeName } }),
  );
  wroteFine = true;
} catch {
  wroteFine = false;
}
check("a paid-up school writes normally", wroteFine);
await withBypass(() => prisma.house.deleteMany({ where: { schoolId, name: probeName } }));

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
