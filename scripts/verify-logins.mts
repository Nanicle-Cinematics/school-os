/**
 * A login can be signed in to with the number the person actually knows.
 *
 * ⚠️ This exists because the two ways an account gets made disagreed, silently
 * and for months. createGuardianLogin and the bulk portal invite stored the
 * NORMALISED number; createUserAccount stored the raw string the office typed.
 * Sign-in tries the typed identifier and its normalised form — which rescues a
 * stored normalised number from any input format, and cannot rescue a stored
 * raw one. So a teacher whose number the office entered as "024 412 3456" was
 * told "Incorrect email/phone or password" when they typed "0244123456": the
 * same message as a wrong password, with nothing to suggest the real reason.
 *
 * Both halves are asserted, because either alone would have passed while the
 * bug was live. No dev server needed.
 *
 *   npm run verify:logins
 */
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { normalisePhone } from "@/lib/sms-shared";
import { demoSchool } from "./fixture.mjs";

let passed = 0;
const failures: string[] = [];
const ok = (label: string, detail = "") => { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); };
const bad = (label: string, detail: string) => { failures.push(label); console.log(`  FAIL ${label} — ${detail}`); };

/** Exactly the lookup in auth-actions.login, so the two cannot drift. */
async function signsIn(typed: string) {
  const identifier = typed.trim().toLowerCase();
  const asPhone = normalisePhone(identifier);
  return withBypass(() =>
    prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { email: identifier },
          { phone: identifier },
          ...(asPhone && asPhone !== identifier ? [{ phone: asPhone }] : []),
        ],
      },
      select: { id: true },
    }),
  );
}

console.log("\nEvery stored login number is in one shape");
/**
 * The invariant that makes the round trip below possible at all. Phrased as
 * "anything that CAN be normalised IS", not "every phone is normalised": a row
 * holding something that is not a Ghanaian mobile is left exactly as it is by
 * the backfill, and signs in the way it always did.
 */
const withPhones = await withBypass(() =>
  prisma.user.findMany({ where: { phone: { not: null } }, select: { id: true, name: true, phone: true } }),
);
const raw = withPhones.filter((u) => {
  const n = normalisePhone(u.phone);
  return n !== null && n !== u.phone;
});
if (raw.length === 0) {
  ok("no account holds a normalisable number in raw form", `${withPhones.length} checked`);
} else {
  bad(
    "no account holds a normalisable number in raw form",
    `${raw.length} still raw, e.g. "${raw[0].phone}" (${raw[0].name}) — they can only sign in by typing that exact string`,
  );
}

console.log("\nAnd it is reachable however the number is typed");
// One probe at a time: with several alive, findFirst can return a different row
// whose number also matches, which is how the first draft of this check
// "proved" a path was broken that was not.
const FORMS = ["0244777001", "+233244777001", "233244777001", "024 477 7001", "244777001"];
for (const typed of FORMS) {
  const user = await withBypass(() =>
    prisma.user.create({
      data: { name: "verify:logins probe", phone: "233244777001", passwordHash: "x" },
      select: { id: true },
    }),
  );
  try {
    const hit = await signsIn(typed);
    if (hit?.id === user.id) {
      ok(`typed as "${typed}"`, "resolves");
    } else {
      bad(`typed as "${typed}"`, "refused — a parent or teacher typing it this way is locked out");
    }
  } finally {
    await withBypass(() => prisma.user.delete({ where: { id: user.id } }));
  }
}

console.log("\nA removed login can be created again");
/**
 * ⚠️ The dead end this closes, forced rather than hoped for.
 *
 * "Remove access" keeps the User row — it may hold access to another school and
 * it is named as the actor on payments and audit rows. But User.phone is
 * GLOBALLY unique and /users lists memberships, so the surviving row went on
 * holding the person's number while nothing in the app could display it. An
 * office that missed the one-time password, removed the account and tried again
 * was told the number belonged to another login, about an account it could not
 * see, for a member of staff the same screen was listing as unable to sign in.
 */
const school = await demoSchool();
const PROBE_PHONE = "233244777900";

const first = await withBypass(() =>
  prisma.user.create({
    data: { name: "verify:logins probe", phone: PROBE_PHONE, passwordHash: "old", schoolId: school.id },
    select: { id: true },
  }),
);
const membership = await withBypass(() =>
  prisma.membership.create({
    data: { schoolId: school.id, userId: first.id, role: "IT_ADMIN", status: "ACTIVE" },
    select: { id: true },
  }),
);

try {
  // Remove access, exactly as removeUserAccess does: memberships go, row stays.
  await withBypass(() => prisma.membership.delete({ where: { id: membership.id } }));

  const orphan = await withBypass(() =>
    prisma.user.findFirst({
      where: { phone: PROBE_PHONE, deletedAt: null },
      select: { id: true, isPlatformAdmin: true, _count: { select: { memberships: true } } },
    }),
  );

  if (orphan && orphan._count.memberships === 0 && !orphan.isPlatformAdmin) {
    ok("a login with no roles left is adoptable", "re-creating reuses it rather than refusing");
  } else {
    bad(
      "a login with no roles left is adoptable",
      orphan
        ? `it still has ${orphan._count.memberships} membership(s) — the office would be refused with no way to see why`
        : "the row vanished, so audit and payment actors would have lost their name",
    );
  }

  // And an account that IS in use must never be adopted — that would reset a
  // stranger's password.
  await withBypass(() =>
    prisma.membership.create({
      data: { schoolId: school.id, userId: first.id, role: "TEACHER", status: "ACTIVE" },
    }),
  );
  const inUse = await withBypass(() =>
    prisma.user.findFirst({
      where: { phone: PROBE_PHONE, deletedAt: null },
      select: { _count: { select: { memberships: true } } },
    }),
  );
  if ((inUse?._count.memberships ?? 0) > 0) {
    ok("an account still in use is NOT adoptable", "somebody else's password stays theirs");
  } else {
    bad("an account still in use is NOT adoptable", "it would be reused and its password reset");
  }
} finally {
  await withBypass(() => prisma.membership.deleteMany({ where: { userId: first.id } }));
  await withBypass(() => prisma.user.delete({ where: { id: first.id } }));
}

const left = await withBypass(() =>
  prisma.user.count({ where: { name: "verify:logins probe" } }),
);
if (left === 0) ok("probes removed", "0 left");
else bad("probes removed", `${left} left behind`);

await prisma.$disconnect();
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
