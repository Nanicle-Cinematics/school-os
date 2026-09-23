/**
 * A COMPLETE academic year, for testing — all three terms, finance and all.
 *
 * `npm run db:seed` gives one term of marks and a second term left open so the
 * mark sheet can be tried. That is the right shape for the guard suite, which
 * asserts against it, but it means nothing in a development database has ever
 * shown what the product looks like after a full year: three sets of report
 * cards, a year's fee history with real debtors, an attendance record behind
 * the figures on the card, and the end-of-year promotion decision.
 *
 * This builds that, as a SECOND school so the seeded one is left exactly as the
 * guards expect it.
 *
 *   npm run db:seed:fullyear
 *   npm run db:seed:fullyear -- --clean     # remove it again
 *
 * ⚠️ DEVELOPMENT DATABASES ONLY. It writes a school, ~66 children and their
 * families, and thousands of marks. Production holds a real school.
 *
 * Everything derived is produced by the REAL engines — `provisionSchool`,
 * `generateInvoicesForTerm`, `computeClassResults` (which applies the year's
 * promotion itself in the third term), `syncAttendanceTotals` — rather than by
 * writing the answers straight into the tables. Hand-written report cards would
 * demo beautifully and prove nothing; these are the rows the app itself
 * produces, so a bug in the arithmetic shows up here as it would for a school.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";

/**
 * A PLAIN client on the OWNER connection, exactly as prisma/seed.ts uses —
 * and for a second reason beyond keeping the RLS extension out of the way.
 *
 * ⚠️ The extension issues `set_config('app.school_id', …)` before EVERY
 * operation, so each write costs two round trips rather than one. That is
 * correct and cheap in production, where the app and the database are both in
 * eu-central-1 — and ruinous from here, where a round trip to Frankfurt is
 * ~1.5s. `computeClassResults` upserts once per student per subject: ~80
 * operations for one JHS class, which through the extended client overran a
 * 120s transaction budget and failed with P2028.
 *
 * The owner role holds `rolbypassrls`, so this connection needs no GUC at all.
 */
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

/** The app's withBypass, minus the round trip: this connection already bypasses. */
const withBypass = <T,>(fn: () => Promise<T>) => fn();

/** The engines are typed against the EXTENDED client's tx; the plain one is
 *  structurally compatible for the operations they use. */
const asTenant = (tx: unknown) => tx as TenantTx;
import { provisionSchool, PROVISION_TX_OPTS } from "@/lib/provisioning";
import { computeClassResults } from "@/lib/results-engine";
import { generateInvoicesForTerm, recalcInvoice } from "@/lib/invoice-engine";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { hashPassword } from "@/lib/password";
import sharp from "sharp";

const SLUG = "demo-fullyear";
const NAME = "Osei Kwadwo Memorial Academy";
const DOMAIN = "oseikwadwo.edu.gh";
const YEAR_NAME = "2025/2026";
const PASSWORD = "Password123!";

/** A finished year: every date is in the past, so all three terms are history. */
const YEAR_START = "2025-09-09";
const YEAR_END = "2026-07-31";
const TERMS = [
  { name: "FIRST", sequence: 1, start: "2025-09-09", end: "2025-12-19", next: "2026-01-13" },
  { name: "SECOND", sequence: 2, start: "2026-01-13", end: "2026-04-10", next: "2026-05-05" },
  { name: "THIRD", sequence: 3, start: "2026-05-05", end: "2026-07-31", next: "2026-09-08" },
] as const;

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const money = (n: number) => new Prisma.Decimal(n.toFixed(2));
const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** Deterministic, so two runs give the same school and a bug is reproducible. */
let seed = 20260922;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

const MALE_NAMES = ["Kwame", "Kofi", "Yaw", "Kojo", "Kwabena", "Kwaku", "Nana", "Kwesi", "Fiifi", "Ebo"];
const FEMALE_NAMES = ["Ama", "Akosua", "Abena", "Adwoa", "Afua", "Yaa", "Esi", "Aba", "Maame", "Akua"];
const SURNAMES = [
  "Mensah", "Boateng", "Owusu", "Asante", "Agyeman", "Appiah", "Darko", "Frimpong",
  "Osei", "Amoah", "Sarpong", "Bediako", "Ofori", "Adjei", "Quartey", "Tetteh",
];

const STAFF_SEED = [
  { first: "Grace", last: "Asamoah", gender: "FEMALE", designation: "Headmistress", teaching: false },
  { first: "Emmanuel", last: "Nkrumah", gender: "MALE", designation: "Bursar", teaching: false },
  { first: "Comfort", last: "Anane", gender: "FEMALE", designation: "KG Coordinator", teaching: true },
  { first: "Daniel", last: "Antwi", gender: "MALE", designation: "Class Teacher", teaching: true },
  { first: "Mercy", last: "Opoku", gender: "FEMALE", designation: "Class Teacher", teaching: true },
  { first: "Samuel", last: "Addo", gender: "MALE", designation: "Class Teacher", teaching: true },
  { first: "Patience", last: "Baidoo", gender: "FEMALE", designation: "Class Teacher", teaching: true },
  { first: "Isaac", last: "Gyamfi", gender: "MALE", designation: "Class Teacher", teaching: true },
  { first: "Rebecca", last: "Yeboah", gender: "FEMALE", designation: "Class Teacher", teaching: true },
  { first: "Michael", last: "Tagoe", gender: "MALE", designation: "Mathematics Teacher", teaching: true },
  { first: "Gifty", last: "Arthur", gender: "FEMALE", designation: "English Teacher", teaching: true },
  { first: "Joseph", last: "Dadzie", gender: "MALE", designation: "Science Teacher", teaching: true },
] as const;

/** Termly fee per level, in GHS — it rises up the school, as fees do. */
const FEE_BY_STAGE: Record<string, number> = {
  KINDERGARTEN: 450,
  PRIMARY: 620,
  JHS: 890,
};

/**
 * How a termly fee splits across the school's fee items, by CODE.
 *
 * ⚠️ Keyed, never sliced. The first version took the first seven categories in
 * code order and applied a descending list of weights, which put 55% of the
 * fee on "Examination Fee" and 3% on "Tuition" — arithmetically fine, and
 * nonsense on a bill a parent reads.
 */
const FEE_SPLIT: Record<string, number> = {
  TUITION: 0.55,
  FEEDING: 0.15,
  EXAM: 0.1,
  ICT: 0.06,
  PTA: 0.05,
  SPORTS: 0.05,
  STATIONERY: 0.04,
};

const EXPENSES_PER_TERM = [
  { desc: "Teaching staff salaries", amount: 18500, payee: "Payroll" },
  { desc: "Electricity (ECG)", amount: 1450, payee: "ECG" },
  { desc: "Water (GWCL)", amount: 620, payee: "Ghana Water" },
  { desc: "Exercise books and stationery", amount: 2300, payee: "Kingdom Books" },
  { desc: "Bus fuel and maintenance", amount: 3100, payee: "Goil Filling Station" },
  { desc: "Cleaning and sanitation", amount: 780, payee: "Zoomlion" },
  { desc: "Internet and phone", amount: 540, payee: "MTN Ghana" },
  { desc: "Building repairs", amount: 4200, payee: "Nsiah Works" },
] as const;

const ASSESSMENTS = [
  { title: "Class Test 1", type: "CLASS_TEST", max: 20, isExam: false },
  { title: "Class Test 2", type: "CLASS_TEST", max: 20, isExam: false },
  { title: "Group Work 1", type: "GROUP_WORK", max: 10, isExam: false },
  { title: "Group Work 2", type: "GROUP_WORK", max: 10, isExam: false },
  { title: "Project Work", type: "PROJECT", max: 20, isExam: false },
  { title: "Examination", type: "END_OF_TERM_EXAM", max: 100, isExam: true },
] as const;

/* ── Teardown ─────────────────────────────────────────────────────────────── */

async function wipe() {
  await withBypass(async () => {
    const school = await prisma.school.findUnique({ where: { slug: SLUG } });
    if (!school) return;
    await prisma.school.delete({ where: { id: school.id } });
    // `User.schoolId` is SetNull, so the cascade leaves this school's own logins
    // behind as orphans — the same shape `platform delete-school` cleans up.
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${DOMAIN}` }, isPlatformAdmin: false },
    });
  });
}


/* ── The crest ────────────────────────────────────────────────────────────── */

/**
 * A crest, drawn rather than pasted.
 *
 * The watermark behind a printed document is only visible for a school that has
 * uploaded one, so a demo school without a crest demonstrates nothing. Drawn as
 * SVG and rasterised with sharp, exactly as scripts/make-icons.mjs does, because
 * a binary checked into the repo would be one more thing to keep in step.
 *
 * ⚠️ Stored as PNG, not SVG: `uploadSchoolAsset` refuses SVG outright — it is a
 * document format that executes script, and these files are served to every
 * parent who opens a report card.
 */
async function makeCrest(initials: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#12805c"/><stop offset="100%" stop-color="#0b5740"/>
    </linearGradient>
  </defs>
  <path d="M256 24 L470 96 V268 C470 372 372 452 256 488 C140 452 42 372 42 268 V96 Z"
        fill="url(#g)" stroke="#b07d1d" stroke-width="14"/>
  <path d="M256 60 L432 120 V266 C432 352 350 420 256 452 C162 420 80 352 80 266 V120 Z"
        fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="6"/>
  <path d="M150 300 h95 v22 h-95 z M267 300 h95 v22 h-95 z" fill="#ffffff" opacity="0.9"/>
  <path d="M150 300 C150 270 200 262 245 276 V300 Z M362 300 C362 270 312 262 267 276 V300 Z"
        fill="#ffffff" opacity="0.75"/>
  <text x="256" y="215" text-anchor="middle" font-family="Georgia, serif"
        font-size="104" font-weight="bold" fill="#ffffff">${initials}</text>
  <circle cx="256" cy="378" r="26" fill="#b07d1d"/>
</svg>`;
  return sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
}

/** Attach the crest to a school, the way the branding screen would. */
async function attachCrest(schoolId: string, initials: string) {
  const bytes = await makeCrest(initials);
  await prisma.schoolAsset.upsert({
    where: { schoolId_kind: { schoolId, kind: "CREST" } },
    create: { schoolId, kind: "CREST", mimeType: "image/png", bytes, byteSize: bytes.byteLength },
    update: { mimeType: "image/png", bytes, byteSize: bytes.byteLength },
  });
  await prisma.school.update({
    where: { id: schoolId },
    // The `?v=` is what stops a replaced crest being served from a stale cache.
    data: { crestUrl: `/api/school-asset/crest?v=${Date.now().toString(36)}` },
  });
}

/* ── Build ────────────────────────────────────────────────────────────────── */

async function main() {
  if (process.argv.includes("--clean")) {
    await wipe();
    console.log(`Removed ${SLUG}.`);
    return;
  }

  // Re-draw the crest on a school that already exists, rather than rebuilding
  // a year's data to change one image.
  if (process.argv.includes("--crest-only")) {
    const existing = await prisma.school.findUniqueOrThrow({ where: { slug: SLUG } });
    await attachCrest(existing.id, "OKMA");
    await prisma.school.update({
      where: { id: existing.id },
      data: { motto: "Knowledge, Discipline, Service" },
    });
    console.log(`Crest and motto attached to ${SLUG}.`);
    return;
  }

  const started = Date.now();
  console.log(`Building ${NAME} — a complete ${YEAR_NAME}\n`);

  console.log("Clearing any previous run…");
  await wipe();

  /* The platform admin the console would have been signed in as. Reused if the
   * database already has one, so this never adds a second. */
  const actor = await withBypass(async () => {
    const existing = await prisma.user.findFirst({ where: { isPlatformAdmin: true } });
    if (existing) return existing;
    return prisma.user.create({
      data: {
        name: "Demo Platform Admin",
        email: `platform@${DOMAIN}`,
        passwordHash: await hashPassword(PASSWORD),
        isPlatformAdmin: true,
      },
    });
  });

  console.log("Provisioning the school (GES curriculum, fee items, templates)…");
  const passwordHash = await hashPassword(PASSWORD);
  const { school, owner } = await withBypass(() =>
    prisma.$transaction(
      (tx) =>
        provisionSchool(asTenant(tx), {
          name: NAME,
          slug: SLUG,
          shortName: "OKMA",
          plan: "INSTITUTION",
          classScoreWeight: 50,
          ownerName: "Mrs Grace Asamoah",
          ownerEmail: `owner@${DOMAIN}`,
          passwordHash,
          actorUserId: actor.id,
        }),
      PROVISION_TX_OPTS,
    ),
  );
  const schoolId = school.id;

  // The proprietor signs in without the change-password diversion; this school
  // exists to be clicked through, and that screen is covered by verify:parent.
  await withBypass(() =>
    prisma.user.update({ where: { id: owner.id }, data: { mustChangePassword: false } }),
  );

  /* Provisioning gives a CURRENT-year calendar. Re-date it to the finished year
   * this school is meant to show, keeping the three terms it already made. */
  console.log("Re-dating the calendar to a finished year…");
  const year = await withBypass(() =>
    prisma.academicYear.findFirstOrThrow({ where: { schoolId } }),
  );
  await withBypass(() =>
    prisma.academicYear.update({
      where: { id: year.id },
      data: { name: YEAR_NAME, startDate: d(YEAR_START), endDate: d(YEAR_END), isCurrent: true },
    }),
  );
  const terms = [];
  for (const shape of TERMS) {
    const term = await withBypass(() =>
      prisma.term.findFirstOrThrow({
        where: { schoolId, academicYearId: year.id, sequence: shape.sequence },
      }),
    );
    terms.push(
      await withBypass(() =>
        prisma.term.update({
          where: { id: term.id },
          data: {
            name: shape.name,
            startDate: d(shape.start),
            endDate: d(shape.end),
            vacationDate: d(shape.end),
            nextTermBegins: d(shape.next),
            // The year is over, so the third term is where the school stands.
            isCurrent: shape.sequence === 3,
          },
        }),
      ),
    );
  }

  /* The NEXT year, empty, so /promotions has somewhere to promote into.
   *
   * Without it that screen refuses outright — "Only one academic year exists,
   * so there is nowhere to promote anyone to" — and the whole end-of-year
   * decision this school exists to demonstrate is unreachable. A real school
   * in September is in exactly this state: last year marked and decided, next
   * year created and not yet begun. It is deliberately NOT current, so the app
   * keeps showing the finished year's data. */
  const nextYear = await prisma.academicYear.create({
    data: {
      schoolId,
      name: "2026/2027",
      startDate: d("2026-09-08"),
      endDate: d("2027-07-30"),
      isCurrent: false,
      terms: {
        create: [
          { schoolId, name: "FIRST", sequence: 1, startDate: d("2026-09-08"), endDate: d("2026-12-18") },
          { schoolId, name: "SECOND", sequence: 2, startDate: d("2027-01-12"), endDate: d("2027-04-09") },
          { schoolId, name: "THIRD", sequence: 3, startDate: d("2027-05-04"), endDate: d("2027-07-30") },
        ],
      },
    },
  });
  console.log(`  next year ${nextYear.name} created, empty — the promotion target`);

  await attachCrest(schoolId, "OKMA");
  await prisma.school.update({
    where: { id: schoolId },
    data: { motto: "Knowledge, Discipline, Service" },
  });

  const levels = await withBypass(() =>
    prisma.level.findMany({
      where: { schoolId },
      orderBy: { order: "asc" },
      include: { levelSubjects: { select: { subjectId: true } } },
    }),
  );
  console.log(`  ${levels.length} levels, ${levels.reduce((n, l) => n + l.levelSubjects.length, 0)} subject offerings`);

  console.log("Creating staff…");
  await withBypass(() =>
    prisma.staff.createMany({
      data: STAFF_SEED.map((s, i) => ({
        schoolId,
        staffNo: `STF-${pad(i + 1, 4)}`,
        firstName: s.first,
        lastName: s.last,
        gender: s.gender,
        designation: s.designation,
        isTeaching: s.teaching,
        phone: `024${pad(1000000 + i * 7919, 7)}`,
        email: `${s.first}.${s.last}`.toLowerCase() + `@${DOMAIN}`,
        dateHired: d("2023-09-01"),
        status: "ACTIVE" as const,
      })),
    }),
  );
  const staff = await withBypass(() =>
    prisma.staff.findMany({ where: { schoolId }, orderBy: { staffNo: "asc" } }),
  );
  const teachers = staff.filter((s) => s.isTeaching);

  console.log("Creating one class per level…");
  for (const [i, level] of levels.entries()) {
    await withBypass(() =>
      prisma.classGroup.create({
        data: {
          schoolId,
          levelId: level.id,
          // Just the stream letter. The report card and the class pages render
          // the LEVEL alongside it, so "Kindergarten 1 A" here prints as
          // "Kindergarten 1 Kindergarten 1 A". The schema says so too: "Gold".
          name: "A",
          capacity: 30,
          formTeacherId: teachers[i % teachers.length]!.id,
        },
      }),
    );
  }
  const classes = await withBypass(() =>
    prisma.classGroup.findMany({
      where: { schoolId },
      include: { level: { include: { levelSubjects: true } } },
      orderBy: { level: { order: "asc" } },
    }),
  );

  console.log("Admitting students and linking guardians…");
  /* ⚠️ BULK, not row-at-a-time. 66 children written one at a time — a student,
   * a guardian and the link between them — is ~200 sequential round trips, and
   * on this link that is minutes. See "Provisioning must stay bulk" in
   * CLAUDE.md; the same lesson, learnt again here. */
  let admissionSeq = 0;
  const studentRows: Prisma.StudentCreateManyInput[] = [];
  const guardianRows: Prisma.GuardianCreateManyInput[] = [];
  const plan: { admissionNo: string; classId: string; roll: number; weak: boolean; surname: string }[] = [];

  for (const cls of classes) {
    for (let n = 0; n < 6; n += 1) {
      admissionSeq += 1;
      const gender = rand() > 0.5 ? "MALE" : "FEMALE";
      const first = gender === "MALE" ? pick(MALE_NAMES) : pick(FEMALE_NAMES);
      const last = pick(SURNAMES);
      // One child in eight is genuinely struggling, so the year-end promotion
      // has someone to repeat and the attention screens have something real.
      const weak = rand() < 0.12;
      const admissionNo = `OKMA/${pad(admissionSeq, 4)}`;

      studentRows.push({
        schoolId,
        admissionNo,
        firstName: first,
        lastName: last,
        gender,
        dateOfBirth: d("2015-05-14"),
        admissionDate: d(YEAR_START),
        status: "ACTIVE",
        residency: "DAY",
        currentClassGroupId: cls.id,
      });
      guardianRows.push({
        schoolId,
        firstName: rand() > 0.5 ? pick(MALE_NAMES) : pick(FEMALE_NAMES),
        lastName: last,
        phone: `05${pad(Math.floor(rand() * 90000000) + 10000000, 8)}`,
        occupation: pick(["Trader", "Teacher", "Farmer", "Driver", "Seamstress", "Mason"]),
        address: pick(["Adum", "Bantama", "Asokwa", "Suame", "Tafo"]) + ", Kumasi",
      });
      plan.push({ admissionNo, classId: cls.id, roll: n + 1, weak, surname: last });
    }
  }

  await withBypass(() => prisma.student.createMany({ data: studentRows }));
  await withBypass(() => prisma.guardian.createMany({ data: guardianRows }));

  const students = await withBypass(() =>
    prisma.student.findMany({
      where: { schoolId },
      select: { id: true, admissionNo: true, lastName: true },
      orderBy: { admissionNo: "asc" },
    }),
  );
  const guardians = await withBypass(() =>
    prisma.guardian.findMany({ where: { schoolId }, select: { id: true }, orderBy: { createdAt: "asc" } }),
  );
  const byAdmission = new Map(students.map((st) => [st.admissionNo, st.id]));

  const studentsByClass = new Map<string, { id: string; weak: boolean }[]>();
  const enrollmentRows: Prisma.EnrollmentCreateManyInput[] = [];
  const linkRows: Prisma.StudentGuardianCreateManyInput[] = [];

  for (const [i, entry] of plan.entries()) {
    const studentId = byAdmission.get(entry.admissionNo)!;
    enrollmentRows.push({
      schoolId,
      studentId,
      academicYearId: year.id,
      classGroupId: entry.classId,
      rollNumber: entry.roll,
      status: "ACTIVE",
      enrolledOn: d(YEAR_START),
    });
    const guardianId = guardians[i]?.id;
    if (guardianId) {
      linkRows.push({
        schoolId,
        studentId,
        guardianId,
        relationship: i % 2 === 0 ? "MOTHER" : "FATHER",
        isPrimary: true,
        receivesBills: true,
        receivesReports: true,
      });
    }
    const roll = studentsByClass.get(entry.classId) ?? [];
    roll.push({ id: studentId, weak: entry.weak });
    studentsByClass.set(entry.classId, roll);
  }

  await withBypass(() => prisma.enrollment.createMany({ data: enrollmentRows }));
  await withBypass(() => prisma.studentGuardian.createMany({ data: linkRows }));
  console.log(`  ${admissionSeq} students`);

  console.log("Assigning teachers to subjects…");
  const assignments: Prisma.TeachingAssignmentCreateManyInput[] = [];
  for (const cls of classes) {
    // KG and primary run on one class teacher; JHS splits by subject.
    const classTeacher = cls.formTeacherId!;
    const jhs = cls.level.stage === "JHS";
    for (const [i, ls] of cls.level.levelSubjects.entries()) {
      assignments.push({
        schoolId,
        academicYearId: year.id,
        staffId: jhs ? teachers[(i + 3) % teachers.length]!.id : classTeacher,
        subjectId: ls.subjectId,
        classGroupId: cls.id,
      });
    }
  }
  await withBypass(() => prisma.teachingAssignment.createMany({ data: assignments }));
  console.log(`  ${assignments.length} assignments`);

  console.log("Pricing the fees…");
  const categories = await withBypass(() =>
    prisma.feeCategory.findMany({ where: { schoolId }, orderBy: { order: "asc" } }),
  );
  for (const level of levels) {
    const termly = FEE_BY_STAGE[level.stage] ?? 600;
    // Spread the termly fee across the school's own fee items rather than
    // inventing one "School fees" line, so the printed bill has a breakdown.
    await withBypass(() =>
      prisma.feeStructure.create({
        data: {
          schoolId,
          academicYearId: year.id,
          termId: null, // applies to every term
          levelId: level.id,
          name: `${level.name} — termly`,
          isActive: true,
          items: {
            create: categories
              .filter((c) => FEE_SPLIT[c.code] !== undefined)
              .map((c) => ({
                schoolId,
                feeCategoryId: c.id,
                amount: money(Math.round(termly * FEE_SPLIT[c.code]!)),
              })),
          },
        },
      }),
    );
  }

  /* Next year is priced too, about 8% up — which is what makes the advance
   * bill (/invoices/proforma) mean anything. A school that has not set next
   * year's fees cannot tell a parent what September costs, and the screen
   * correctly refuses to guess. */
  for (const level of levels) {
    const termly = Math.round((FEE_BY_STAGE[level.stage] ?? 600) * 1.08);
    await withBypass(() =>
      prisma.feeStructure.create({
        data: {
          schoolId,
          academicYearId: nextYear.id,
          termId: null,
          levelId: level.id,
          name: `${level.name} — termly`,
          isActive: true,
          items: {
            create: categories
              .filter((c) => FEE_SPLIT[c.code] !== undefined)
              .map((c) => ({
                schoolId,
                feeCategoryId: c.id,
                amount: money(Math.round(termly * FEE_SPLIT[c.code]!)),
              })),
          },
        },
      }),
    );
  }

  /* ── The year, term by term ────────────────────────────────────────────── */

  const expenseCategories = await withBypass(() =>
    prisma.expenseCategory.findMany({ where: { schoolId }, select: { id: true } }),
  );

  let receiptSeq = 0;
  let voucherSeq = 0;
  const totals = { assessments: 0, scores: 0, invoices: 0, payments: 0, days: 0, marks: 0 };

  for (const term of terms) {
    const label = `${term.name} term`;
    console.log(`\n── ${label} ──`);

    /* Marks. Every component approved, because this term is finished. */
    const assessmentRows: Prisma.AssessmentCreateManyInput[] = [];
    for (const cls of classes) {
      for (const ls of cls.level.levelSubjects) {
        for (const a of ASSESSMENTS) {
          assessmentRows.push({
            schoolId,
            termId: term.id,
            classGroupId: cls.id,
            subjectId: ls.subjectId,
            type: a.type,
            title: a.title,
            maxScore: money(a.max),
            // Weight tracks maxScore: the class score is marks earned over
            // marks available. See src/lib/assessment-templates.ts.
            weight: money(a.max),
            status: "APPROVED",
            createdByStaffId: cls.formTeacherId,
          });
        }
      }
    }
    await withBypass(() => prisma.assessment.createMany({ data: assessmentRows }));
    const saved = await withBypass(() =>
      prisma.assessment.findMany({
        where: { schoolId, termId: term.id },
        select: { id: true, classGroupId: true, maxScore: true },
      }),
    );
    totals.assessments += saved.length;

    const scoreRows: Prisma.ScoreCreateManyInput[] = [];
    for (const a of saved) {
      const max = Number(a.maxScore);
      for (const student of studentsByClass.get(a.classGroupId) ?? []) {
        // A weak child sits around the pass mark; everyone else lands in a
        // believable spread. ⚠️ the column is rawScore, never `score`.
        const floor = student.weak ? 0.3 : 0.45;
        const span = student.weak ? 0.22 : 0.5;
        scoreRows.push({
          schoolId,
          assessmentId: a.id,
          studentId: student.id,
          rawScore: money(Math.round(max * (floor + rand() * span))),
          isAbsent: false,
        });
      }
    }
    for (let i = 0; i < scoreRows.length; i += 2000) {
      await withBypass(() =>
        prisma.score.createMany({ data: scoreRows.slice(i, i + 2000) }),
      );
    }
    totals.scores += scoreRows.length;
    console.log(`  ${saved.length} assessments, ${scoreRows.length} scores`);

    /* The register. Every other school day, which is enough for the report
     * card's attendance line to mean something without writing 20,000 rows. */
    const start = new Date(term.startDate!);
    const end = new Date(term.endDate!);
    const dates: Date[] = [];
    for (let t = new Date(start); t <= end && dates.length < 30; t.setUTCDate(t.getUTCDate() + 2)) {
      const day = t.getUTCDay();
      if (day === 0 || day === 6) continue; // weekends
      dates.push(new Date(t));
    }
    /* ⚠️ BULK. One AttendanceDay create plus one entries createMany per class
     * per day is 660 sequential round trips a term — measured at 2.9s each on
     * this link, which is an hour for the year. Write every day in one call,
     * read the ids back, then write every mark in one call: 3 round trips. */
    const dayRows: Prisma.AttendanceDayCreateManyInput[] = [];
    for (const cls of classes) {
      for (const date of dates) {
        dayRows.push({
          schoolId,
          termId: term.id,
          classGroupId: cls.id,
          date,
          takenByStaffId: cls.formTeacherId,
        });
      }
    }
    await withBypass(() => prisma.attendanceDay.createMany({ data: dayRows }));

    const savedDays = await withBypass(() =>
      prisma.attendanceDay.findMany({
        where: { schoolId, termId: term.id },
        select: { id: true, classGroupId: true },
      }),
    );
    const entryRows: Prisma.AttendanceEntryCreateManyInput[] = [];
    for (const day of savedDays) {
      for (const student of studentsByClass.get(day.classGroupId) ?? []) {
        const r = rand();
        const mark = r > 0.93 ? "ABSENT" : r > 0.89 ? "LATE" : r > 0.87 ? "EXCUSED" : "PRESENT";
        entryRows.push({
          schoolId,
          attendanceDayId: day.id,
          studentId: student.id,
          mark: mark as "PRESENT" | "LATE" | "EXCUSED" | "ABSENT",
        });
      }
    }
    for (let i = 0; i < entryRows.length; i += 2000) {
      await withBypass(() =>
        prisma.attendanceEntry.createMany({ data: entryRows.slice(i, i + 2000) }),
      );
    }
    totals.days += savedDays.length;
    totals.marks += entryRows.length;
    console.log(`  ${dates.length} register days per class`);

    /* Results, by the real engine — which applies the year's promotion itself
     * in the third term. */
    let promoted = 0;
    let repeated = 0;
    let graduated = 0;
    for (const cls of classes) {
      const result = await withBypass(() =>
        prisma.$transaction(
          (tx) => computeClassResults(asTenant(tx), schoolId, term.id, cls.id),
          { timeout: 600_000, maxWait: 30_000 },
        ),
      );
      if (result.promotion) {
        promoted += result.promotion.promoted;
        repeated += result.promotion.repeated;
        graduated += result.promotion.graduated;
      }
      await withBypass(() =>
        prisma.$transaction(
          (tx) => syncAttendanceTotals(asTenant(tx), schoolId, term.id, cls.id),
          { timeout: 300_000, maxWait: 30_000 },
        ),
      );
    }

    // Publish: a finished term's cards are what parents can see.
    await withBypass(() =>
      prisma.termResult.updateMany({
        where: { schoolId, termId: term.id },
        data: { status: "PUBLISHED" },
      }),
    );
    console.log(
      `  results computed and published` +
        (term.sequence === 3
          ? ` · promotion: ${promoted} promoted, ${repeated} repeated, ${graduated} graduated`
          : ""),
    );

    /* Fees. The real generator, so the "why was this student skipped" path is
     * the one the office would actually hit. */
    const generated = await withBypass(() =>
      prisma.$transaction(
        (tx) => generateInvoicesForTerm(asTenant(tx), schoolId, term.id, 21),
        { timeout: 180_000, maxWait: 20_000 },
      ),
    );
    const invoices = await withBypass(() =>
      prisma.invoice.findMany({
        where: { schoolId, termId: term.id },
        select: { id: true, studentId: true, total: true },
      }),
    );
    totals.invoices += invoices.length;

    /* ⚠️ BULK again: a guardian lookup, a payment, an allocation and a recalc
     * per invoice is four round trips × 200 invoices. The links are read once,
     * payments and allocations go in one call each, and the recalcs — which
     * must stay per-invoice, because the engine owns status and balance — share
     * a single transaction instead of opening one apiece. */
    const links = await withBypass(() =>
      prisma.studentGuardian.findMany({
        where: { schoolId },
        select: { studentId: true, guardianId: true },
      }),
    );
    const guardianOf = new Map(links.map((l) => [l.studentId, l.guardianId]));

    const paymentRows: Prisma.PaymentCreateManyInput[] = [];
    const paidInvoices: { invoiceId: string; receiptNo: string; amount: number }[] = [];
    const paidAt = d(term.startDate!.toISOString().slice(0, 10));

    for (const invoice of invoices) {
      const roll = rand();
      // Later terms are paid less completely, which is what a school's arrears
      // actually look like by July.
      const fullyPaidChance = term.sequence === 1 ? 0.72 : term.sequence === 2 ? 0.6 : 0.42;
      if (roll > 0.88) continue; // nothing paid at all — a real debtor

      const ratio = roll < fullyPaidChance ? 1 : 0.35 + rand() * 0.4;
      const amount = Math.round(Number(invoice.total) * ratio);
      if (amount <= 0) continue;

      receiptSeq += 1;
      const receiptNo = `RCT-${pad(receiptSeq, 5)}`;
      paymentRows.push({
        schoolId,
        studentId: invoice.studentId,
        guardianId: guardianOf.get(invoice.studentId) ?? null,
        receiptNo,
        amount: money(amount),
        method: rand() > 0.45 ? "MOBILE_MONEY" : "CASH",
        momoNetwork: rand() > 0.5 ? "MTN" : "TELECEL",
        status: "CONFIRMED",
        paidAt,
        recordedByUserId: owner.id,
      });
      paidInvoices.push({ invoiceId: invoice.id, receiptNo, amount });
    }

    await withBypass(() => prisma.payment.createMany({ data: paymentRows }));
    const savedPayments = await withBypass(() =>
      prisma.payment.findMany({
        where: { schoolId, receiptNo: { in: paidInvoices.map((p) => p.receiptNo) } },
        select: { id: true, receiptNo: true },
      }),
    );
    const paymentIdOf = new Map(savedPayments.map((p) => [p.receiptNo, p.id]));

    await withBypass(() =>
      prisma.paymentAllocation.createMany({
        data: paidInvoices.map((p) => ({
          schoolId,
          paymentId: paymentIdOf.get(p.receiptNo)!,
          invoiceId: p.invoiceId,
          amount: money(p.amount),
        })),
      }),
    );

    // The engine owns the invoice's status and balance — never set by hand, or
    // the stored status and the allocations drift apart.
    await withBypass(() =>
      prisma.$transaction(
        async (tx) => {
          for (const p of paidInvoices) {
            await recalcInvoice(asTenant(tx), p.invoiceId);
          }
        },
        { timeout: 300_000, maxWait: 20_000 },
      ),
    );
    totals.payments += paidInvoices.length;


    console.log(`  ${generated.created} invoices raised, ${invoices.length} on file`);

    /* The cash book. */
    for (const e of EXPENSES_PER_TERM) {
      voucherSeq += 1;
      await withBypass(() =>
        prisma.expense.create({
          data: {
            schoolId,
            termId: term.id,
            categoryId: pick(expenseCategories).id,
            voucherNo: `PV-${pad(voucherSeq, 5)}`,
            description: e.desc,
            amount: money(e.amount + Math.round(rand() * 300)),
            payee: e.payee,
            method: rand() > 0.5 ? "BANK_TRANSFER" : "CASH",
            status: "PAID",
            spentAt: d(term.startDate!.toISOString().slice(0, 10)),
            recordedByUserId: owner.id,
          },
        }),
      );
    }
  }

  /* ── Number sequences must not trail the data they number ───────────────── */
  console.log("\nAligning number sequences…");
  const invoiceCount = await withBypass(() =>
    prisma.invoice.count({ where: { schoolId } }),
  );
  for (const [key, used] of [
    ["ADMISSION", admissionSeq],
    ["INVOICE", invoiceCount],
    ["RECEIPT", receiptSeq],
    ["VOUCHER", voucherSeq],
    ["STAFF", STAFF_SEED.length],
  ] as const) {
    await withBypass(() =>
      prisma.numberSequence.updateMany({
        where: { schoolId, key },
        data: { next: used + 1 },
      }),
    );
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\n✅ ${NAME} — a complete ${YEAR_NAME} in ${seconds}s`);
  console.log(`   Login:       owner@${DOMAIN} / ${PASSWORD}`);
  console.log(`   Students:    ${admissionSeq} in ${classes.length} classes`);
  console.log(`   Marks:       ${totals.assessments} assessments, ${totals.scores} scores`);
  console.log(`   Register:    ${totals.days} class-days, ${totals.marks} marks`);
  console.log(`   Fees:        ${totals.invoices} invoices, ${totals.payments} payments`);
  console.log(`   Report cards: all three terms computed and PUBLISHED`);
  console.log(`\n   Remove it with: npm run db:seed:fullyear -- --clean`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
