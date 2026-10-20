/**
 * Ten realistic schools, for the load test.
 *
 *   npm run load:seed                         # 10 schools x 650 pupils x 25 staff
 *   npm run load:seed -- --schools 3 --pupils 500 --staff 17
 *   npm run load:seed -- --only 4             # (re)build school 4 alone
 *   npm run load:seed -- --clean              # remove every load-* school and its logins
 *
 * ⚠️ THROWAWAY DATABASES ONLY. It refuses to start unless `.env.load` names a database that is
 * neither `.env`'s nor `.env.prod`'s (see guard.mts), and it never reads `.env` for a URL.
 *
 * Each school is a snapshot of mid-year, because that is what a school mid-term looks like to
 * the app: term 1 finished (every mark in, results computed and PUBLISHED, fees billed and
 * partly paid, a register for 20 days), term 2 current (the first two assessments marked, a
 * register for 10 days, NOT yet billed, so the invoice run has real work to do under load).
 * Everything derived is produced by the real engines (`provisionSchool`, `computeClassResults`,
 * `generateInvoicesForTerm`, `syncAttendanceTotals`), as seed-fullyear does, so the rows are
 * the ones the app writes and the arithmetic is the app's own.
 *
 * It reports the database's size at the end, which is the figure that answers "how fast does
 * this grow": a school-year is about twice what one school contributes here.
 *
 * One password for every login, hashed ONCE (about 0.65 s each on this laptop; 6,000 of them
 * would take over an hour). Fine for a throwaway; it is also why the logins here are not a
 * measure of the hashing cost, which the `login` scenario measures separately.
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { provisionSchool, PROVISION_TX_OPTS } from "@/lib/provisioning";
import { computeClassResults } from "@/lib/results-engine";
import { generateInvoicesForTerm, recalcInvoice } from "@/lib/invoice-engine";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { hashPassword } from "@/lib/password";
import { DOMAIN, LOAD_PASSWORD } from "./constants.mjs";
import { rng } from "./http.mjs";
import { requireSafeTarget } from "./preflight.mjs";

requireSafeTarget();


/** The OWNER connection: bypasses row security, and skips the per-operation GUC round trip. */
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
const asTenant = (tx: unknown) => tx as TenantTx;

/* ── Options ──────────────────────────────────────────────────────────────── */

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(process.argv[at + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
const SCHOOLS = arg("schools", 10);
const PUPILS = arg("pupils", 650);
const STAFF = Math.max(8, arg("staff", 25));
const ONLY = arg("only", 0);

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const money = (n: number) => new Prisma.Decimal(n.toFixed(2));
const DAY = 24 * 60 * 60 * 1000;
const midnight = (ms: number) => new Date(Math.floor(ms / DAY) * DAY);
const NOW = midnight(Date.now());
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);

const slugOf = (n: number) => `load-${pad(n, 2)}`;

/** Chunked createMany: one huge statement exceeds Postgres's bind-parameter limit. */
async function insert<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

const MALE = ["Kwame", "Kofi", "Yaw", "Kojo", "Kwabena", "Kwaku", "Nana", "Kwesi", "Fiifi", "Ebo"];
const FEMALE = ["Ama", "Akosua", "Abena", "Adwoa", "Afua", "Yaa", "Esi", "Aba", "Maame", "Akua"];
const SURNAMES = ["Mensah", "Boateng", "Owusu", "Asante", "Agyeman", "Appiah", "Darko", "Frimpong", "Osei", "Amoah", "Sarpong", "Bediako", "Ofori", "Adjei", "Quartey", "Tetteh"];
const ASSESSMENTS = [
  { title: "Class Test 1", type: "CLASS_TEST", max: 20 },
  { title: "Class Test 2", type: "CLASS_TEST", max: 20 },
  { title: "Group Work 1", type: "GROUP_WORK", max: 10 },
  { title: "Group Work 2", type: "GROUP_WORK", max: 10 },
  { title: "Project Work", type: "PROJECT", max: 20 },
  { title: "Examination", type: "END_OF_TERM_EXAM", max: 100 },
] as const;
const FEE_BY_STAGE: Record<string, number> = { NURSERY: 400, KINDERGARTEN: 450, PRIMARY: 620, JHS: 890 };
const FEE_SPLIT: Record<string, number> = { TUITION: 0.55, FEEDING: 0.15, EXAM: 0.1, ICT: 0.06, PTA: 0.05, SPORTS: 0.05, STATIONERY: 0.04 };

/* ── Teardown ─────────────────────────────────────────────────────────────── */

async function clean() {
  const schools = await prisma.school.findMany({ where: { slug: { startsWith: "load-" } }, select: { id: true, slug: true } });
  const ids = schools.map((s) => s.id);
  // `User.schoolId` is SetNull, so removing a school leaves its logins behind as orphans.
  const users = await prisma.user.deleteMany({ where: { OR: [{ schoolId: { in: ids } }, { email: { endsWith: `.${DOMAIN}` } }] } });
  for (const school of schools) {
    await prisma.school.delete({ where: { id: school.id } });
    console.log(`  removed ${school.slug}`);
  }
  console.log(`Removed ${schools.length} schools and ${users.count} logins.`);
}

/* ── One school ───────────────────────────────────────────────────────────── */

async function buildSchool(n: number, passwordHash: string, actorId: string, phoneBase: number) {
  const started = Date.now();
  const slug = slugOf(n);
  const rand = rng(20261017 + n);
  const tag = `${slug}.${DOMAIN}`;

  const existing = await prisma.school.findUnique({ where: { slug } });
  if (existing) {
    await prisma.user.deleteMany({ where: { schoolId: existing.id } });
    await prisma.school.delete({ where: { id: existing.id } });
  }

  console.log(`\n── ${slug}: ${PUPILS} pupils, ${STAFF} staff ──`);
  const { school, owner } = await prisma.$transaction(
    (tx) =>
      provisionSchool(asTenant(tx), {
        name: `Load Test Academy ${pad(n, 2)}`,
        slug,
        shortName: `LTA${pad(n, 2)}`,
        plan: "INSTITUTION",
        classScoreWeight: 50,
        ownerName: `Proprietor ${pad(n, 2)}`,
        ownerEmail: `owner@${tag}`,
        passwordHash,
        actorUserId: actorId,
      }),
    PROVISION_TX_OPTS,
  );
  const schoolId = school.id;
  await prisma.user.update({ where: { id: owner.id }, data: { mustChangePassword: false, schoolId } });

  // A school that has set up its books has mapped its receivable account, and only then does an invoice run post a
  // journal entry per pupil (the heavier path). Provisioning creates the chart but leaves the mapping to the school,
  // so without this every load run measured a school that had not done it.
  const receivable = await prisma.ledgerAccount.findFirst({ where: { schoolId, type: "ASSET", name: { contains: "eceivable", mode: "insensitive" } } });
  if (receivable) await prisma.schoolSettings.update({ where: { schoolId }, data: { receivableAccountId: receivable.id } });

  // ── The calendar: term 1 over, term 2 under way, so there is something published AND something open.
  const year = await prisma.academicYear.findFirstOrThrow({ where: { schoolId } });
  const shapes = [
    { sequence: 1, start: at(-140), end: at(-55), next: at(-30), current: false },
    { sequence: 2, start: at(-30), end: at(60), next: at(90), current: true },
    { sequence: 3, start: at(90), end: at(170), next: at(210), current: false },
  ];
  await prisma.academicYear.update({ where: { id: year.id }, data: { startDate: shapes[0]!.start, endDate: shapes[2]!.end, isCurrent: true } });
  const terms = [];
  for (const shape of shapes) {
    const term = await prisma.term.findFirstOrThrow({ where: { schoolId, academicYearId: year.id, sequence: shape.sequence } });
    terms.push(
      await prisma.term.update({
        where: { id: term.id },
        data: { startDate: shape.start, endDate: shape.end, vacationDate: shape.end, nextTermBegins: shape.next, isCurrent: shape.current },
      }),
    );
  }
  const [term1, term2] = [terms[0]!, terms[1]!];

  const levels = await prisma.level.findMany({ where: { schoolId }, orderBy: { order: "asc" }, include: { levelSubjects: { select: { subjectId: true } } } });

  // ── Staff and their logins. The OWNER came with the school; the rest are made here.
  const officeRoles = [
    { role: "HEAD", local: "head", first: "Grace", designation: "Headmistress" },
    { role: "ACCOUNTANT", local: "bursar", first: "Emmanuel", designation: "Bursar" },
    { role: "ADMIN", local: "admin", first: "Comfort", designation: "Registrar" },
    { role: "IT_ADMIN", local: "it", first: "Michael", designation: "IT Administrator" },
  ] as const;
  const teacherCount = STAFF - officeRoles.length;
  const staffRows: Prisma.StaffCreateManyInput[] = [];
  const userRows: Prisma.UserCreateManyInput[] = [];
  const memberRows: Prisma.MembershipCreateManyInput[] = [];
  const teacherIds: string[] = [];

  const person = (i: number, designation: string, teaching: boolean, first: string, local: string, role: string) => {
    const staffId = randomUUID();
    const userId = randomUUID();
    staffRows.push({
      id: staffId,
      schoolId,
      staffNo: `STF-${pad(i + 1, 4)}`,
      firstName: first,
      lastName: SURNAMES[i % SURNAMES.length]!,
      gender: i % 2 ? "MALE" : "FEMALE",
      designation,
      isTeaching: teaching,
      dateHired: at(-900),
      status: "ACTIVE",
    });
    userRows.push({ id: userId, schoolId, email: `${local}@${tag}`, name: `${first} ${SURNAMES[i % SURNAMES.length]}`, passwordHash, mustChangePassword: false });
    memberRows.push({ schoolId, userId, role: role as "TEACHER", staffId, status: "ACTIVE" });
    return staffId;
  };
  officeRoles.forEach((o, i) => person(i, o.designation, false, o.first, o.local, o.role));
  for (let t = 0; t < teacherCount; t += 1) {
    teacherIds.push(person(officeRoles.length + t, t < 13 ? "Class Teacher" : "Subject Teacher", true, rand.pick([...MALE, ...FEMALE]), `t${pad(t + 1, 2)}`, "TEACHER"));
  }
  await prisma.staff.createMany({ data: staffRows });
  await prisma.user.createMany({ data: userRows });
  await prisma.membership.createMany({ data: memberRows });

  // ── One class per level, a form teacher each (as many teachers as there are classes, then they double up).
  const classRows: Prisma.ClassGroupCreateManyInput[] = levels.map((level, i) => ({
    id: randomUUID(),
    schoolId,
    levelId: level.id,
    name: "A",
    capacity: Math.ceil(PUPILS / levels.length) + 5,
    formTeacherId: teacherIds[i % teacherIds.length]!,
  }));
  await prisma.classGroup.createMany({ data: classRows });
  const classes = classRows.map((row, i) => ({ id: row.id!, levelIndex: i, level: levels[i]!, formTeacherId: row.formTeacherId! }));

  // ── Pupils, spread across the ladder; guardians are shared between siblings, and every guardian has at least one child.
  const guardianCount = Math.ceil(PUPILS * 0.8);
  const studentRows: Prisma.StudentCreateManyInput[] = [];
  const enrolRows: Prisma.EnrollmentCreateManyInput[] = [];
  const linkRows: Prisma.StudentGuardianCreateManyInput[] = [];
  const guardianRows: Prisma.GuardianCreateManyInput[] = [];
  const guardianIds: string[] = [];
  const guardianPhone: string[] = [];
  for (let g = 0; g < guardianCount; g += 1) {
    const id = randomUUID();
    const local = `024${pad(phoneBase + g, 7)}`;
    guardianIds.push(id);
    guardianPhone.push(local);
    guardianRows.push({ id, schoolId, firstName: rand.pick([...MALE, ...FEMALE]), lastName: rand.pick(SURNAMES), phone: local, occupation: "Trader", address: "Adum, Kumasi" });
  }
  const order = [...Array(PUPILS).keys()].sort(() => rand.next() - 0.5);
  const byClass = new Map<string, { id: string; weak: boolean }[]>();
  const perClass = Math.ceil(PUPILS / classes.length);
  for (let i = 0; i < PUPILS; i += 1) {
    const cls = classes[Math.min(classes.length - 1, Math.floor(i / perClass))]!;
    const studentId = randomUUID();
    const male = rand.next() > 0.5;
    const weak = rand.next() < 0.12;
    studentRows.push({
      id: studentId,
      schoolId,
      admissionNo: `LTA${pad(n, 2)}/${pad(i + 1, 4)}`,
      firstName: male ? rand.pick(MALE) : rand.pick(FEMALE),
      lastName: rand.pick(SURNAMES),
      gender: male ? "MALE" : "FEMALE",
      dateOfBirth: at(-365 * (5 + cls.levelIndex)),
      admissionDate: at(-400),
      status: "ACTIVE",
      residency: "DAY",
      currentClassGroupId: cls.id,
    });
    enrolRows.push({ schoolId, studentId, academicYearId: year.id, classGroupId: cls.id, rollNumber: (i % perClass) + 1, status: "ACTIVE", enrolledOn: at(-140) });
    const k = order[i]!;
    linkRows.push({ schoolId, studentId, guardianId: guardianIds[k < guardianCount ? k : rand.int(guardianCount)]!, relationship: i % 2 ? "FATHER" : "MOTHER", isPrimary: true, receivesBills: true, receivesReports: true });
    const roll = byClass.get(cls.id) ?? [];
    roll.push({ id: studentId, weak });
    byClass.set(cls.id, roll);
  }
  await insert(guardianRows, (data) => prisma.guardian.createMany({ data }));
  await insert(studentRows, (data) => prisma.student.createMany({ data }));
  await insert(enrolRows, (data) => prisma.enrollment.createMany({ data }));
  await insert(linkRows, (data) => prisma.studentGuardian.createMany({ data }));

  // ── A parent login for every guardian, by phone, as most Ghanaian parents sign in.
  const parentUsers: Prisma.UserCreateManyInput[] = [];
  const parentMembers: Prisma.MembershipCreateManyInput[] = [];
  guardianIds.forEach((guardianId, g) => {
    const userId = randomUUID();
    parentUsers.push({ id: userId, schoolId, phone: `233${guardianPhone[g]!.slice(1)}`, name: `Parent ${n}-${g + 1}`, passwordHash, mustChangePassword: false });
    parentMembers.push({ schoolId, userId, role: "PARENT", staffId: null, guardianId, status: "ACTIVE" });
  });
  await insert(parentUsers, (data) => prisma.user.createMany({ data }));
  await insert(parentMembers, (data) => prisma.membership.createMany({ data }));

  // ── Who teaches what: one class teacher through primary, a subject teacher each at JHS.
  const assignments: Prisma.TeachingAssignmentCreateManyInput[] = [];
  for (const cls of classes) {
    const jhs = cls.level.stage === "JHS";
    cls.level.levelSubjects.forEach((ls, i) => {
      assignments.push({ schoolId, academicYearId: year.id, staffId: jhs ? teacherIds[(i + 3) % teacherIds.length]! : cls.formTeacherId, subjectId: ls.subjectId, classGroupId: cls.id });
    });
  }
  await prisma.teachingAssignment.createMany({ data: assignments });

  // ── Fees: every level priced for the year, applying to every term.
  const categories = await prisma.feeCategory.findMany({ where: { schoolId }, orderBy: { order: "asc" } });
  for (const level of levels) {
    const termly = FEE_BY_STAGE[level.stage] ?? 600;
    await prisma.feeStructure.create({
      data: {
        schoolId,
        academicYearId: year.id,
        termId: null,
        levelId: level.id,
        name: `${level.name} - termly`,
        isActive: true,
        items: { create: categories.filter((c) => FEE_SPLIT[c.code] !== undefined).map((c) => ({ schoolId, feeCategoryId: c.id, amount: money(Math.round(termly * FEE_SPLIT[c.code]!)) })) },
      },
    });
  }

  // ── Term by term. Term 1 is finished; term 2 is a marking term caught part-way.
  let receiptSeq = 0;
  const totals = { scores: 0, entries: 0, invoices: 0, payments: 0 };
  for (const [index, term] of [term1, term2].entries()) {
    const finished = index === 0;
    const rows: Prisma.AssessmentCreateManyInput[] = [];
    for (const cls of classes) {
      for (const ls of cls.level.levelSubjects) {
        for (const a of ASSESSMENTS) {
          rows.push({ schoolId, termId: term.id, classGroupId: cls.id, subjectId: ls.subjectId, type: a.type, title: a.title, maxScore: money(a.max), weight: money(a.max), status: finished ? "APPROVED" : "OPEN", createdByStaffId: cls.formTeacherId });
        }
      }
    }
    await insert(rows, (data) => prisma.assessment.createMany({ data }));
    const saved = await prisma.assessment.findMany({ where: { schoolId, termId: term.id }, select: { id: true, classGroupId: true, maxScore: true, title: true } });

    // Term 1: everything marked. Term 2: only the first two components, so the sheet has blanks to fill.
    const scoreRows: Prisma.ScoreCreateManyInput[] = [];
    for (const a of saved) {
      if (!finished && !["Class Test 1", "Group Work 1"].includes(a.title)) continue;
      const max = Number(a.maxScore);
      for (const student of byClass.get(a.classGroupId) ?? []) {
        const floor = student.weak ? 0.3 : 0.45;
        const span = student.weak ? 0.22 : 0.5;
        scoreRows.push({ schoolId, assessmentId: a.id, studentId: student.id, rawScore: money(Math.round(max * (floor + rand.next() * span))), isAbsent: false });
      }
    }
    await insert(scoreRows, (data) => prisma.score.createMany({ data }));
    totals.scores += scoreRows.length;

    // The register: every other weekday, so twenty days in term 1 and ten so far in term 2.
    const wanted = finished ? 20 : 10;
    const dates: Date[] = [];
    for (let t = new Date(term.startDate!); t <= (finished ? term.endDate! : NOW) && dates.length < wanted; t = new Date(t.getTime() + 2 * DAY)) {
      if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) dates.push(new Date(t));
    }
    const dayRows: Prisma.AttendanceDayCreateManyInput[] = [];
    for (const cls of classes) for (const date of dates) dayRows.push({ schoolId, termId: term.id, classGroupId: cls.id, date, takenByStaffId: cls.formTeacherId });
    await insert(dayRows, (data) => prisma.attendanceDay.createMany({ data }));
    const days = await prisma.attendanceDay.findMany({ where: { schoolId, termId: term.id }, select: { id: true, classGroupId: true } });
    const entries: Prisma.AttendanceEntryCreateManyInput[] = [];
    for (const day of days) {
      for (const student of byClass.get(day.classGroupId) ?? []) {
        const r = rand.next();
        entries.push({ schoolId, attendanceDayId: day.id, studentId: student.id, mark: r > 0.93 ? "ABSENT" : r > 0.89 ? "LATE" : r > 0.87 ? "EXCUSED" : "PRESENT" });
      }
    }
    await insert(entries, (data) => prisma.attendanceEntry.createMany({ data }));
    totals.entries += entries.length;

    if (!finished) continue;

    for (const cls of classes) {
      await prisma.$transaction((tx) => computeClassResults(asTenant(tx), schoolId, term.id, cls.id), { timeout: 600_000, maxWait: 30_000 });
      await prisma.$transaction((tx) => syncAttendanceTotals(asTenant(tx), schoolId, term.id, cls.id), { timeout: 300_000, maxWait: 30_000 });
    }
    await prisma.termResult.updateMany({ where: { schoolId, termId: term.id }, data: { status: "PUBLISHED" } });

    // Billed and part-paid, so /debtors and the dashboard have a real list to draw.
    await prisma.$transaction((tx) => generateInvoicesForTerm(asTenant(tx), schoolId, term.id, 21), { timeout: 180_000, maxWait: 20_000 });
    const invoices = await prisma.invoice.findMany({ where: { schoolId, termId: term.id }, select: { id: true, studentId: true, total: true } });
    totals.invoices += invoices.length;
    const guardianOf = new Map(linkRows.map((l) => [l.studentId, l.guardianId]));
    const payments: Prisma.PaymentCreateManyInput[] = [];
    const paid: { invoiceId: string; receiptNo: string; amount: number }[] = [];
    for (const invoice of invoices) {
      const roll = rand.next();
      if (roll > 0.88) continue;
      const amount = Math.round(Number(invoice.total) * (roll < 0.7 ? 1 : 0.35 + rand.next() * 0.4));
      if (amount <= 0) continue;
      receiptSeq += 1;
      const receiptNo = `RCT-${pad(receiptSeq, 6)}`;
      payments.push({ schoolId, studentId: invoice.studentId, guardianId: guardianOf.get(invoice.studentId) ?? null, receiptNo, amount: money(amount), method: rand.next() > 0.45 ? "MOBILE_MONEY" : "CASH", momoNetwork: "MTN", status: "CONFIRMED", paidAt: term.startDate!, recordedByUserId: owner.id });
      paid.push({ invoiceId: invoice.id, receiptNo, amount });
    }
    await insert(payments, (data) => prisma.payment.createMany({ data }));
    const savedPayments = await prisma.payment.findMany({ where: { schoolId }, select: { id: true, receiptNo: true } });
    const idOf = new Map(savedPayments.map((p) => [p.receiptNo, p.id]));
    await insert(paid, (chunk) => prisma.paymentAllocation.createMany({ data: chunk.map((p) => ({ schoolId, paymentId: idOf.get(p.receiptNo)!, invoiceId: p.invoiceId, amount: money(p.amount) })) }));
    await prisma.$transaction(async (tx) => { for (const p of paid) await recalcInvoice(asTenant(tx), p.invoiceId); }, { timeout: 600_000, maxWait: 20_000 });
    totals.payments += paid.length;
  }

  // Seeded rows are numbered without touching the counter, so line the counters up behind them.
  const invoiceCount = await prisma.invoice.count({ where: { schoolId } });
  for (const [key, used] of [["ADMISSION", PUPILS], ["INVOICE", invoiceCount], ["RECEIPT", receiptSeq], ["STAFF", STAFF]] as const) {
    await prisma.numberSequence.updateMany({ where: { schoolId, key }, data: { next: used + 1 } });
  }

  console.log(`  ${classes.length} classes, ${totals.scores} scores, ${totals.entries} register marks, ${totals.invoices} invoices, ${totals.payments} payments, ${parentUsers.length} parent logins  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  if (process.argv.includes("--clean")) {
    await clean();
    return;
  }

  // One hash for everybody. See the header: a throwaway's logins do not need to cost 0.65 s each.
  const passwordHash = await hashPassword(LOAD_PASSWORD);

  // provisionSchool wants a platform admin for the audit trail; reuse the one that exists, or make one.
  const actor =
    (await prisma.user.findFirst({ where: { isPlatformAdmin: true } })) ??
    (await prisma.user.create({ data: { name: "Load Platform Admin", email: `platform@${DOMAIN}`, passwordHash, isPlatformAdmin: true } }));

  const range = ONLY ? [ONLY] : [...Array(SCHOOLS).keys()].map((i) => i + 1);
  for (const n of range) {
    // Parent phones are unique ACROSS schools (User.phone is unique), so each school draws from its own block.
    await buildSchool(n, passwordHash, actor.id, n * 100_000);
  }

  const [size] = await prisma.$queryRaw<{ pretty: string; bytes: bigint }[]>`select pg_size_pretty(pg_database_size(current_database())) as pretty, pg_database_size(current_database()) as bytes`;
  const [counts] = await prisma.$queryRaw<{ students: bigint; scores: bigint; entries: bigint; invoices: bigint }[]>`
    select (select count(*) from "Student") as students, (select count(*) from "Score") as scores,
           (select count(*) from "AttendanceEntry") as entries, (select count(*) from "Invoice") as invoices`;
  const schools = await prisma.school.count({ where: { slug: { startsWith: "load-" } } });
  console.log(`\nDatabase is ${size!.pretty} with ${schools} load schools: ${counts!.students} pupils, ${counts!.scores} scores, ${counts!.entries} register marks, ${counts!.invoices} invoices.`);
  console.log(`That is about ${(Number(size!.bytes) / Math.max(1, schools) / 1e6).toFixed(0)} MB per school at mid-year, so roughly twice that for a full year.`);
  console.log(`\nEvery login uses LOAD_PASSWORD (scripts/load/constants.mts). Owners: owner@load-NN.${DOMAIN}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
