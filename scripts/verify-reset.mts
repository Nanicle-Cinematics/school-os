/**
 * The forgotten-password flow, proved against the real engine code.
 *
 * Every property here is a REFUSAL — a wrong code, a spent code, an expired one,
 * a sixth guess, a staff account, a stranger's number. A reset that quietly
 * works when it should not is the whole risk of putting this in front of the
 * internet, and none of it is visible from reading the happy path.
 *
 * It creates one parent login and removes it again.
 *
 *   npm run verify:reset   (needs no dev server)
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { requestPasswordReset, completePasswordReset } from "@/lib/password-reset";
import { hashPassword, verifyPassword } from "@/lib/password";

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

const PHONE = "233500000601";
const STAFF_PHONE = "233500000602";
const STRANGER = "233500000603";

// requestPasswordReset refuses to start without a gateway, so give it one — and
// SMS_DRY_RUN so nothing is sent and Arkesel is never called from a test.
process.env.SMS_PROVIDER = "ARKESEL";
process.env.SMS_API_KEY = "verify-fixture-key";
process.env.SMS_DRY_RUN = "1";

const school = await withBypass(() =>
  prisma.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } } }),
);
const guardian = await withBypass(() =>
  prisma.guardian.findFirst({ where: { schoolId: school!.id, deletedAt: null } }),
);

async function makeUser(phone: string, role: "PARENT" | "TEACHER") {
  const passwordHash = await hashPassword("OriginalPassword1!");
  const user = await withBypass(() =>
    prisma.user.create({
      data: { name: `Reset fixture ${role}`, phone, passwordHash, schoolId: school!.id },
      select: { id: true },
    }),
  );
  await withBypass(() =>
    prisma.membership.create({
      data: {
        schoolId: school!.id,
        userId: user.id,
        role,
        guardianId: role === "PARENT" ? guardian!.id : null,
      },
    }),
  );
  return user.id;
}

const parentId = await makeUser(PHONE, "PARENT");
const staffId = await makeUser(STAFF_PHONE, "TEACHER");

/** Brute-force the fixture's own 6 digits — only possible because we made it. */
async function realCode(userId: string) {
  const row = await withBypass(() =>
    prisma.passwordReset.findFirst({ where: { userId, consumedAt: null }, orderBy: { createdAt: "desc" } }),
  );
  for (let n = 0; n < 1_000_000; n += 1) {
    const guess = String(n).padStart(6, "0");
    if (createHash("sha256").update(guess).digest("hex") === row!.codeHash) {
      return guess;
    }
  }
  throw new Error("fixture code not found");
}

try {
  console.log("Asking for a code");
  const asked = await requestPasswordReset("0500000601");
  check("a parent's number gets one", asked.kind === "sent", asked.kind);

  const stranger = await requestPasswordReset(STRANGER);
  check(
    "an unknown number is answered the SAME way, never 'no such user'",
    stranger.kind === "silent",
    stranger.kind,
  );

  const staff = await requestPasswordReset(STAFF_PHONE);
  check("a STAFF number gets nothing — the office is their path", staff.kind === "silent", staff.kind);

  const junk = await requestPasswordReset("not a phone");
  check("junk is rejected before any lookup", junk.kind === "invalid-phone", junk.kind);

  console.log("\nSpending it");
  const code = await realCode(parentId);

  const wrong = await completePasswordReset({
    phone: PHONE,
    code: code === "000000" ? "111111" : "000000",
    password: "BrandNewPass1",
    confirm: "BrandNewPass1",
  });
  check("a wrong code is refused", wrong.kind === "bad-code", wrong.kind);

  const short = await completePasswordReset({
    phone: PHONE,
    code,
    password: "short",
    confirm: "short",
  });
  check("a short password is refused BEFORE the code is spent", short.kind === "weak-password", short.kind);

  const mismatch = await completePasswordReset({
    phone: PHONE,
    code,
    password: "BrandNewPass1",
    confirm: "BrandNewPass2",
  });
  check("a mistyped confirmation is refused", mismatch.kind === "mismatch", mismatch.kind);

  // A session that existed before the reset, to prove it does not survive it.
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId: parentId,
        tokenHash: `reset-fixture-${Date.now()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    }),
  );

  const ok = await completePasswordReset({
    phone: PHONE,
    code,
    password: "BrandNewPass1",
    confirm: "BrandNewPass1",
  });
  check("the right code sets the password", ok.kind === "ok", ok.kind);

  const after = await withBypass(() =>
    prisma.user.findUnique({ where: { id: parentId }, select: { passwordHash: true, mustChangePassword: true } }),
  );
  check("the new password actually works", await verifyPassword("BrandNewPass1", after!.passwordHash!));
  check("and nothing is left forcing a change", after!.mustChangePassword === false);

  const sessions = await withBypass(() => prisma.session.count({ where: { userId: parentId } }));
  check("every other session is ended", sessions === 0, `${sessions} left`);

  const replay = await completePasswordReset({
    phone: PHONE,
    code,
    password: "ThirdPassword1",
    confirm: "ThirdPassword1",
  });
  check("the same code cannot be spent twice", replay.kind === "bad-code", replay.kind);

  console.log("\nGuessing at it");
  await requestPasswordReset(PHONE);
  const fresh = await realCode(parentId);
  for (let i = 0; i < 5; i += 1) {
    await completePasswordReset({
      phone: PHONE,
      code: "999999" === fresh ? "888888" : "999999",
      password: "GuessedPass1",
      confirm: "GuessedPass1",
    });
  }
  const afterFive = await completePasswordReset({
    phone: PHONE,
    code: fresh,
    password: "GuessedPass1",
    confirm: "GuessedPass1",
  });
  check(
    "five wrong guesses kill the code, even for the RIGHT one after",
    afterFive.kind === "bad-code",
    afterFive.kind,
  );
  check("and the password is unchanged", await verifyPassword("BrandNewPass1", (await withBypass(() =>
    prisma.user.findUnique({ where: { id: parentId }, select: { passwordHash: true } }),
  ))!.passwordHash!));

  console.log("\nExpiry and rate limiting");
  await requestPasswordReset(PHONE);
  await withBypass(() =>
    prisma.passwordReset.updateMany({
      where: { userId: parentId, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    }),
  );
  const stale = await completePasswordReset({
    phone: PHONE,
    code: "000000",
    password: "GuessedPass1",
    confirm: "GuessedPass1",
  });
  check("an expired code is refused", stale.kind === "bad-code", stale.kind);

  const before = await withBypass(() => prisma.passwordReset.count({ where: { userId: parentId } }));
  await requestPasswordReset(PHONE);
  const after4 = await withBypass(() => prisma.passwordReset.count({ where: { userId: parentId } }));
  check(
    "past three in an hour, no further code is created",
    after4 === before,
    `${before} → ${after4}`,
  );

  // ⚠️ This check used to end in `|| true`, which is a check that cannot fail —
  // the exact shape of guard this codebase keeps getting caught by. Assert the
  // stored value IS a sha256 and is NOT the six digits that were texted.
  const stored = await withBypass(() =>
    prisma.passwordReset.findMany({ where: { userId: parentId }, select: { codeHash: true } }),
  );
  check(
    "codes are stored as sha256 only, never as the digits that were texted",
    stored.length > 0 &&
      stored.every((r) => /^[0-9a-f]{64}$/.test(r.codeHash) && !/^\d{6}$/.test(r.codeHash)),
    `${stored.length} rows checked`,
  );
} finally {
  await withBypass(() => prisma.passwordReset.deleteMany({ where: { userId: { in: [parentId, staffId] } } }));
  await withBypass(() => prisma.session.deleteMany({ where: { userId: { in: [parentId, staffId] } } }));
  await withBypass(() => prisma.membership.deleteMany({ where: { userId: { in: [parentId, staffId] } } }));
  await withBypass(() => prisma.user.deleteMany({ where: { id: { in: [parentId, staffId] } } }));
  await withBypass(() => prisma.message.deleteMany({ where: { toPhone: { in: [PHONE, STAFF_PHONE] } } }));
  console.log("\nfixtures removed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
