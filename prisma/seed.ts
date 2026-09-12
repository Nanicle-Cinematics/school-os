/**
 * Seed: one demo Ghanaian basic school, fully populated.
 *
 * Deliberately uses the plain PrismaClient (not src/lib/prisma.ts) so the
 * "server-only" import chain and the RLS extension stay out of the way.
 *
 * Re-runnable: it deletes the demo school by slug first and lets the cascades
 * clear everything underneath.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
// The same list provisioning gives a real school, so the demo cannot drift
// from what a paying school actually gets.
import { DEFAULT_MESSAGE_TEMPLATES } from "../src/lib/message-defaults";

// Seed over DIRECT_URL (session pooler), not DATABASE_URL. The runtime URL
// carries connection_limit=1, which is right for the app but starves a seed:
// any concurrent query queues behind the single connection and trips the 10s
// pool timeout (P2024) on a slow link.
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const SLUG = "st-mary-demo";
const EMAIL_DOMAIN = "stmarydemo.edu.gh";
const YEAR = "2026/2027";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// ── Reference data ───────────────────────────────────────────────────────────

const LEVELS = [
  { code: "KG1", name: "Kindergarten 1", stage: "KINDERGARTEN" },
  { code: "KG2", name: "Kindergarten 2", stage: "KINDERGARTEN" },
  { code: "B1", name: "Basic 1", stage: "PRIMARY" },
  { code: "B2", name: "Basic 2", stage: "PRIMARY" },
  { code: "B3", name: "Basic 3", stage: "PRIMARY" },
  { code: "B4", name: "Basic 4", stage: "PRIMARY" },
  { code: "B5", name: "Basic 5", stage: "PRIMARY" },
  { code: "B6", name: "Basic 6", stage: "PRIMARY" },
  { code: "JHS1", name: "JHS 1", stage: "JHS" },
  { code: "JHS2", name: "JHS 2", stage: "JHS" },
  { code: "JHS3", name: "JHS 3", stage: "JHS" },
] as const;

const SUBJECTS = [
  { code: "ENG", name: "English Language", isCore: true },
  { code: "MAT", name: "Mathematics", isCore: true },
  { code: "SCI", name: "Integrated Science", isCore: true },
  { code: "OWOP", name: "Our World Our People", isCore: true },
  { code: "SOC", name: "Social Studies", isCore: true },
  { code: "GHL", name: "Ghanaian Language", isCore: true },
  { code: "RME", name: "Religious and Moral Education", isCore: true },
  { code: "CAD", name: "Creative Arts and Design", isCore: true },
  { code: "COM", name: "Computing", isCore: true },
  { code: "CTE", name: "Career Technology", isCore: true },
  { code: "PHE", name: "Physical and Health Education", isCore: true },
  { code: "FRE", name: "French", isCore: false },
] as const;

// Which subjects each stage actually offers, and which count toward aggregate.
const STAGE_SUBJECTS: Record<string, string[]> = {
  KINDERGARTEN: ["ENG", "MAT", "SCI", "CAD", "PHE", "RME"],
  PRIMARY: ["ENG", "MAT", "SCI", "OWOP", "GHL", "RME", "CAD", "COM", "PHE", "FRE"],
  JHS: ["ENG", "MAT", "SCI", "SOC", "GHL", "RME", "CAD", "COM", "CTE", "PHE", "FRE"],
};
const AGGREGATE_SUBJECTS = new Set(["ENG", "MAT", "SCI", "SOC", "OWOP", "GHL", "RME"]);

const BASIC_BANDS = [
  { grade: "1", minScore: 80, maxScore: 100, points: 1, remark: "Excellent", isPass: true },
  { grade: "2", minScore: 70, maxScore: 79.99, points: 2, remark: "Very Good", isPass: true },
  { grade: "3", minScore: 65, maxScore: 69.99, points: 3, remark: "Good", isPass: true },
  { grade: "4", minScore: 60, maxScore: 64.99, points: 4, remark: "Credit", isPass: true },
  { grade: "5", minScore: 55, maxScore: 59.99, points: 5, remark: "Credit", isPass: true },
  { grade: "6", minScore: 50, maxScore: 54.99, points: 6, remark: "Credit", isPass: true },
  { grade: "7", minScore: 45, maxScore: 49.99, points: 7, remark: "Pass", isPass: true },
  { grade: "8", minScore: 40, maxScore: 44.99, points: 8, remark: "Pass", isPass: true },
  { grade: "9", minScore: 0, maxScore: 39.99, points: 9, remark: "Fail", isPass: false },
];

const WASSCE_BANDS = [
  { grade: "A1", minScore: 80, maxScore: 100, points: 1, remark: "Excellent", isPass: true },
  { grade: "B2", minScore: 75, maxScore: 79.99, points: 2, remark: "Very Good", isPass: true },
  { grade: "B3", minScore: 70, maxScore: 74.99, points: 3, remark: "Good", isPass: true },
  { grade: "C4", minScore: 65, maxScore: 69.99, points: 4, remark: "Credit", isPass: true },
  { grade: "C5", minScore: 60, maxScore: 64.99, points: 5, remark: "Credit", isPass: true },
  { grade: "C6", minScore: 55, maxScore: 59.99, points: 6, remark: "Credit", isPass: true },
  { grade: "D7", minScore: 50, maxScore: 54.99, points: 7, remark: "Pass", isPass: true },
  { grade: "E8", minScore: 45, maxScore: 49.99, points: 8, remark: "Pass", isPass: true },
  { grade: "F9", minScore: 0, maxScore: 44.99, points: 9, remark: "Fail", isPass: false },
];

const ASSESSMENT_COMPONENTS = [
  { title: "Class Test 1", type: "CLASS_TEST" as const, maxScore: 20, isExam: false, order: 10 },
  { title: "Class Test 2", type: "CLASS_TEST" as const, maxScore: 20, isExam: false, order: 20 },
  { title: "Group Work 1", type: "GROUP_WORK" as const, maxScore: 10, isExam: false, order: 30 },
  { title: "Group Work 2", type: "GROUP_WORK" as const, maxScore: 10, isExam: false, order: 40 },
  { title: "Project Work", type: "PROJECT" as const, maxScore: 20, isExam: false, order: 50 },
  { title: "Examination", type: "END_OF_TERM_EXAM" as const, maxScore: 100, isExam: true, order: 60 },
];

const FEE_CATEGORIES = [
  { code: "TUITION", name: "Tuition", order: 1 },
  { code: "PTA", name: "PTA Levy", order: 2 },
  { code: "EXAM", name: "Examination Fee", order: 3 },
  { code: "FEEDING", name: "Feeding Fee", order: 4 },
  { code: "ICT", name: "ICT / Computer Levy", order: 5 },
  { code: "SPORTS", name: "Sports and Culture", order: 6 },
  { code: "STATIONERY", name: "Stationery and Printing", order: 7 },
];

const EXPENSE_CATEGORIES = [
  { code: "SALARIES", name: "Salaries and Allowances", order: 1 },
  { code: "UTILITIES", name: "Utilities (Light, Water)", order: 2 },
  { code: "MAINT", name: "Repairs and Maintenance", order: 3 },
  { code: "KITCHEN", name: "Feeding and Kitchen", order: 4 },
  { code: "STATIONERY", name: "Stationery and Printing", order: 5 },
  { code: "TRANSPORT", name: "Transport and Fuel", order: 6 },
  { code: "MISC", name: "Miscellaneous", order: 7 },
];

// Per-level termly fees, in GHS. Rises with the level, as fees do.
const TUITION_BY_STAGE: Record<string, number> = {
  KINDERGARTEN: 450,
  PRIMARY: 600,
  JHS: 800,
};

const HOUSES = [
  { name: "Aggrey", color: "#1d4ed8" },
  { name: "Nkrumah", color: "#b91c1c" },
  { name: "Danquah", color: "#15803d" },
  { name: "Yaa Asantewaa", color: "#a16207" },
];

const FIRST_NAMES_M = ["Kwame", "Kofi", "Yaw", "Kwabena", "Kojo", "Kwaku", "Kwadwo", "Nana", "Elikem", "Selorm"];
const FIRST_NAMES_F = ["Ama", "Akosua", "Abena", "Yaa", "Afua", "Adwoa", "Esi", "Akua", "Efua", "Mansa"];
const SURNAMES = [
  "Mensah", "Owusu", "Boateng", "Asante", "Agyeman", "Darko", "Appiah", "Frimpong",
  "Ofori", "Amponsah", "Adjei", "Quartey", "Tetteh", "Anane", "Sarpong", "Baidoo",
];

const STAFF_SEED = [
  { first: "Emmanuel", last: "Ofori", gender: "MALE", designation: "Headmaster", teaching: false, role: "HEAD" },
  { first: "Grace", last: "Amoah", gender: "FEMALE", designation: "Bursar", teaching: false, role: "ACCOUNTANT" },
  { first: "Isaac", last: "Boateng", gender: "MALE", designation: "Mathematics Teacher", teaching: true, role: "TEACHER" },
  { first: "Comfort", last: "Asare", gender: "FEMALE", designation: "English Teacher", teaching: true, role: "TEACHER" },
  { first: "Daniel", last: "Nyarko", gender: "MALE", designation: "Science Teacher", teaching: true, role: "TEACHER" },
  { first: "Vida", last: "Agyapong", gender: "FEMALE", designation: "Class Teacher", teaching: true, role: "TEACHER" },
  { first: "Samuel", last: "Tetteh", gender: "MALE", designation: "Class Teacher", teaching: true, role: "TEACHER" },
  { first: "Patience", last: "Kumi", gender: "FEMALE", designation: "School Secretary", teaching: false, role: "ADMIN" },
];


// Deterministic pseudo-random so re-seeding gives the same demo data.
function makeRng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const rand = makeRng(20260824);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const pad = (n: number, width = 4) => String(n).padStart(width, "0");
const money = (n: number) => new Prisma.Decimal(n.toFixed(2));

async function main() {
  console.log("Clearing previous demo data…");
  await prisma.school.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${EMAIL_DOMAIN}` } } });

  console.log("Creating school…");
  const school = await prisma.school.create({
    data: {
      name: "St. Mary's Preparatory & JHS",
      slug: SLUG,
      shortName: "SMPJHS",
      motto: "Knowledge and Character",
      email: `info@${EMAIL_DOMAIN}`,
      phone: "0302123456",
      address: "P.O. Box 44, Adenta",
      town: "Adenta",
      district: "Adentan Municipal",
      region: "Greater Accra",
      gpsAddress: "GD-123-4567",
      accreditationNo: "GES/GAR/AD/0091",
      headName: "Mr. Emmanuel Ofori",
      plan: "STANDARD",
      subscriptionStatus: "TRIALING",
      trialEndsAt: d("2026-10-01"),
      settings: {
        create: {
          classScoreWeight: 50,
          examScoreWeight: 50,
          invoiceDueDays: 21,
          smsEnabled: false,
          smsSenderId: "SMPJHS",
        },
      },
      sequences: {
        create: [
          { key: "ADMISSION", prefix: "SM/", padding: 4, next: 1 },
          { key: "STAFF", prefix: "STF-", padding: 3, next: 1 },
          { key: "INVOICE", prefix: "INV-", padding: 5, next: 1 },
          { key: "RECEIPT", prefix: "RCT-", padding: 5, next: 1 },
          { key: "VOUCHER", prefix: "PV-", padding: 5, next: 1 },
        ],
      },
      houses: { create: HOUSES },
      // The same six a real school is provisioned with. Without them a teacher
      // opening a mark sheet in the demo finds nothing to mark.
      assessmentTemplates: { create: ASSESSMENT_COMPONENTS },
      feeCategories: { create: FEE_CATEGORIES.map((c) => ({ ...c, isMandatory: c.code !== "SPORTS" })) },
      expenseCategories: { create: EXPENSE_CATEGORIES },
      messageTemplates: {
        create: DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ ...t, channel: "SMS" as const, isSystem: true })),
      },
    },
  });
  const schoolId = school.id;

  console.log("Creating academic year and terms…");
  const year = await prisma.academicYear.create({
    data: {
      schoolId,
      name: YEAR,
      startDate: d("2026-09-08"),
      endDate: d("2027-07-30"),
      isCurrent: true,
      terms: {
        create: [
          {
            schoolId, name: "FIRST", sequence: 1, isCurrent: true,
            startDate: d("2026-09-08"), endDate: d("2026-12-18"),
            vacationDate: d("2026-12-18"), nextTermBegins: d("2027-01-12"),
          },
          {
            schoolId, name: "SECOND", sequence: 2,
            startDate: d("2027-01-12"), endDate: d("2027-04-09"),
            vacationDate: d("2027-04-09"), nextTermBegins: d("2027-05-04"),
          },
          {
            schoolId, name: "THIRD", sequence: 3,
            startDate: d("2027-05-04"), endDate: d("2027-07-30"),
            vacationDate: d("2027-07-30"), nextTermBegins: d("2027-09-07"),
          },
        ],
      },
    },
    include: { terms: { orderBy: { sequence: "asc" } } },
  });
  const term1 = year.terms[0];
  const term2 = year.terms[1];

  console.log("Creating grading scales…");
  const basicScale = await prisma.gradingScale.create({
    data: {
      schoolId, name: "Basic School 1–9", isDefault: true,
      bands: { create: BASIC_BANDS.map((b) => ({ ...b, schoolId })) },
    },
  });
  await prisma.gradingScale.create({
    data: {
      schoolId, name: "WASSCE A1–F9", isDefault: false,
      bands: { create: WASSCE_BANDS.map((b) => ({ ...b, schoolId })) },
    },
  });
  await prisma.schoolSettings.update({
    where: { schoolId },
    data: { defaultGradingScaleId: basicScale.id },
  });

  console.log("Creating levels, classes and subjects…");
  // Sequential, not Promise.all — this link is slow enough that a burst of
  // parallel inserts is a liability, and seeds have no reason to race.
  const subjects = [];
  for (const [i, s] of SUBJECTS.entries()) {
    subjects.push(
      await prisma.subject.create({
        data: { schoolId, code: s.code, name: s.name, isCore: s.isCore, order: i },
      }),
    );
  }
  const subjectByCode = new Map(subjects.map((s) => [s.code, s]));

  const levels = [];
  for (const [i, l] of LEVELS.entries()) {
    const level = await prisma.level.create({
      data: {
        schoolId, code: l.code, name: l.name, stage: l.stage, order: i + 1,
        classGroups: { create: [{ schoolId, name: "A", capacity: 35 }] },
        levelSubjects: {
          create: STAGE_SUBJECTS[l.stage].map((code, order) => ({
            schoolId,
            subjectId: subjectByCode.get(code)!.id,
            isElective: code === "FRE",
            countsForAggregate: AGGREGATE_SUBJECTS.has(code),
            order,
          })),
        },
      },
      include: { classGroups: true },
    });
    levels.push({ ...level, stage: l.stage });
  }

  console.log("Creating staff and users…");
  const ownerPassword = await hashPassword("Password123!");
  const staffRecords = [];
  for (const [i, s] of STAFF_SEED.entries()) {
    const staff = await prisma.staff.create({
      data: {
        schoolId,
        staffNo: `STF-${pad(i + 1, 3)}`,
        firstName: s.first,
        lastName: s.last,
        gender: s.gender as "MALE" | "FEMALE",
        designation: s.designation,
        isTeaching: s.teaching,
        employmentType: "FULL_TIME",
        phone: `024${pad(1000000 + i, 7)}`,
        email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@${EMAIL_DOMAIN}`,
        dateHired: d("2024-09-01"),
      },
    });
    const user = await prisma.user.create({
      data: {
        schoolId,
        name: `${s.first} ${s.last}`,
        email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@${EMAIL_DOMAIN}`,
        passwordHash: ownerPassword,
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { schoolId, userId: user.id, staffId: staff.id, role: s.role as never, acceptedAt: new Date() },
    });
    staffRecords.push(staff);
  }

  // The proprietor — the account you actually log in with.
  const owner = await prisma.user.create({
    data: {
      schoolId,
      name: "Nana Kwabena Osei",
      email: `owner@${EMAIL_DOMAIN}`,
      passwordHash: ownerPassword,
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.create({
    data: { schoolId, userId: owner.id, role: "OWNER", acceptedAt: new Date() },
  });

  const teachers = staffRecords.filter((s) => s.isTeaching);
  for (const [i, level] of levels.entries()) {
    await prisma.classGroup.update({
      where: { id: level.classGroups[0].id },
      data: { formTeacherId: teachers[i % teachers.length].id },
    });
  }

  console.log("Creating fee structures…");
  const feeCategories = await prisma.feeCategory.findMany({ where: { schoolId } });
  const catByCode = new Map(feeCategories.map((c) => [c.code, c]));
  const feeStructures = new Map<string, { id: string; total: number; items: { categoryId: string; name: string; amount: number }[] }>();

  for (const level of levels) {
    const tuition = TUITION_BY_STAGE[level.stage];
    const items = [
      { code: "TUITION", amount: tuition },
      { code: "PTA", amount: 50 },
      { code: "EXAM", amount: 40 },
      { code: "FEEDING", amount: 300 },
      { code: "ICT", amount: 60 },
      { code: "SPORTS", amount: 30 },
      { code: "STATIONERY", amount: 45 },
    ];
    const structure = await prisma.feeStructure.create({
      data: {
        schoolId,
        academicYearId: year.id,
        termId: null, // applies to every term this year
        levelId: level.id,
        name: `${level.name} — ${YEAR}`,
        residency: "ANY",
        studentType: "ANY",
        items: {
          create: items.map((it) => ({
            schoolId,
            feeCategoryId: catByCode.get(it.code)!.id,
            amount: money(it.amount),
          })),
        },
      },
    });
    feeStructures.set(level.id, {
      id: structure.id,
      total: items.reduce((sum, it) => sum + it.amount, 0),
      items: items.map((it) => ({
        categoryId: catByCode.get(it.code)!.id,
        name: catByCode.get(it.code)!.name,
        amount: it.amount,
      })),
    });
  }

  console.log("Creating students, guardians, enrolments and invoices…");
  const houses = await prisma.house.findMany({ where: { schoolId } });
  let admissionSeq = 0;
  let invoiceSeq = 0;
  let receiptSeq = 0;

  for (const level of levels) {
    const classGroup = level.classGroups[0];
    const fees = feeStructures.get(level.id)!;

    for (let n = 0; n < 4; n += 1) {
      admissionSeq += 1;
      const isFemale = rand() > 0.5;
      const firstName = isFemale ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
      const lastName = pick(SURNAMES);

      const student = await prisma.student.create({
        data: {
          schoolId,
          admissionNo: `SM/${pad(admissionSeq)}`,
          firstName,
          lastName,
          gender: isFemale ? "FEMALE" : "MALE",
          dateOfBirth: d(`${2012 - Math.floor(level.order / 2)}-0${(admissionSeq % 9) + 1}-15`),
          nationality: "Ghanaian",
          status: "ACTIVE",
          residency: "DAY",
          houseId: pick(houses).id,
          currentClassGroupId: classGroup.id,
          admissionDate: d("2026-09-08"),
        },
      });

      const guardian = await prisma.guardian.create({
        data: {
          schoolId,
          firstName: pick(rand() > 0.5 ? FIRST_NAMES_M : FIRST_NAMES_F),
          lastName,
          phone: `05${pad(40000000 + admissionSeq, 8)}`,
          occupation: pick(["Trader", "Teacher", "Driver", "Nurse", "Farmer", "Civil Servant"]),
          address: "Adenta, Accra",
        },
      });
      await prisma.studentGuardian.create({
        data: {
          schoolId,
          studentId: student.id,
          guardianId: guardian.id,
          relationship: rand() > 0.5 ? "FATHER" : "MOTHER",
          isPrimary: true,
          receivesBills: true,
          receivesReports: true,
          isEmergencyContact: true,
        },
      });

      await prisma.enrollment.create({
        data: {
          schoolId,
          studentId: student.id,
          academicYearId: year.id,
          classGroupId: classGroup.id,
          rollNumber: n + 1,
          status: "ACTIVE",
        },
      });

      // Term 1 invoice from the level's fee structure.
      invoiceSeq += 1;
      const invoice = await prisma.invoice.create({
        data: {
          schoolId,
          studentId: student.id,
          termId: term1.id,
          invoiceNo: `INV-${pad(invoiceSeq, 5)}`,
          issueDate: d("2026-09-08"),
          dueDate: d("2026-09-29"),
          subtotal: money(fees.total),
          discountTotal: money(0),
          broughtForward: money(0),
          total: money(fees.total),
          amountPaid: money(0),
          balance: money(fees.total),
          status: "ISSUED",
          items: {
            create: fees.items.map((it) => ({
              schoolId,
              feeCategoryId: it.categoryId,
              description: it.name,
              amount: money(it.amount),
            })),
          },
        },
      });

      // ~70% of parents have paid something — gives the debtor list real data.
      const roll = rand();
      if (roll > 0.3) {
        const paidRatio = roll > 0.6 ? 1 : 0.5;
        const amount = Math.round(fees.total * paidRatio);
        receiptSeq += 1;
        const payment = await prisma.payment.create({
          data: {
            schoolId,
            studentId: student.id,
            guardianId: guardian.id,
            receiptNo: `RCT-${pad(receiptSeq, 5)}`,
            amount: money(amount),
            method: rand() > 0.5 ? "MOBILE_MONEY" : "CASH",
            momoNetwork: rand() > 0.5 ? "MTN" : "TELECEL",
            status: "CONFIRMED",
            paidAt: d("2026-09-15"),
            recordedByUserId: owner.id,
          },
        });
        await prisma.paymentAllocation.create({
          data: { schoolId, paymentId: payment.id, invoiceId: invoice.id, amount: money(amount) },
        });
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: money(amount),
            balance: money(fees.total - amount),
            status: amount >= fees.total ? "PAID" : "PARTIALLY_PAID",
          },
        });
      }
    }
  }

  console.log("Creating teaching assignments…");
  for (const level of levels) {
    const classGroup = level.classGroups[0];
    for (const [i, code] of STAGE_SUBJECTS[level.stage].entries()) {
      await prisma.teachingAssignment.create({
        data: {
          schoolId,
          academicYearId: year.id,
          staffId: teachers[(level.order + i) % teachers.length].id,
          subjectId: subjectByCode.get(code)!.id,
          classGroupId: classGroup.id,
        },
      });
    }
  }

  console.log("Creating assessments and scores…");
  // Two assessments per class/subject for term 1: a class test carrying the
  // continuous-assessment weight, and the end-of-term exam. Written with
  // createMany so this stays a handful of round trips rather than hundreds.
  const enrolmentsByClass = new Map<string, string[]>();
  for (const enrolment of await prisma.enrollment.findMany({
    where: { schoolId, academicYearId: year.id },
    select: { classGroupId: true, studentId: true },
  })) {
    const list = enrolmentsByClass.get(enrolment.classGroupId) ?? [];
    list.push(enrolment.studentId);
    enrolmentsByClass.set(enrolment.classGroupId, list);
  }

  const assessmentRows = [];
  for (const level of levels) {
    const classGroup = level.classGroups[0];
    for (const code of STAGE_SUBJECTS[level.stage]) {
      const subjectId = subjectByCode.get(code)!.id;
      assessmentRows.push(
        {
          schoolId, termId: term1.id, classGroupId: classGroup.id, subjectId,
          type: "CLASS_TEST" as const, title: "Class Test 1",
          maxScore: money(30), weight: money(100), status: "APPROVED" as const,
        },
        {
          schoolId, termId: term1.id, classGroupId: classGroup.id, subjectId,
          type: "END_OF_TERM_EXAM" as const, title: "End of Term Examination",
          maxScore: money(100), weight: money(100), status: "APPROVED" as const,
        },
      );
    }
  }
  // Term 2 is the term being marked: the school's six components, open, with
  // nothing entered. Without this the demo has no markable sheet anywhere —
  // every term-1 assessment is approved and locked — so the mark sheet cannot
  // be tried, or tested.
  if (term2) {
    for (const level of levels) {
      const classGroup = level.classGroups[0];
      for (const code of STAGE_SUBJECTS[level.stage]) {
        const subjectId = subjectByCode.get(code)!.id;
        for (const component of ASSESSMENT_COMPONENTS) {
          assessmentRows.push({
            schoolId,
            termId: term2.id,
            classGroupId: classGroup.id,
            subjectId,
            type: component.type,
            title: component.title,
            // weight tracks maxScore: the class score is then marks earned over
            // marks available. See src/lib/assessment-templates.ts.
            maxScore: money(component.maxScore),
            weight: money(component.maxScore),
            status: "OPEN" as const,
          });
        }
      }
    }
  }

  await prisma.assessment.createMany({ data: assessmentRows });

  const savedAssessments = await prisma.assessment.findMany({
    where: { schoolId, termId: term1.id },
    select: { id: true, classGroupId: true, type: true, maxScore: true },
  });

  // Give each student a stable underlying ability so results look like a real
  // class — a spread with a top and a tail, not uniform noise.
  const ability = new Map<string, number>();
  for (const ids of enrolmentsByClass.values()) {
    for (const studentId of ids) {
      ability.set(studentId, 0.45 + rand() * 0.5);
    }
  }

  const scoreRows = [];
  for (const assessment of savedAssessments) {
    const studentIds = enrolmentsByClass.get(assessment.classGroupId) ?? [];
    const max = Number(assessment.maxScore);
    for (const studentId of studentIds) {
      const base = ability.get(studentId)!;
      const variation = (rand() - 0.5) * 0.22;
      const fraction = Math.min(0.99, Math.max(0.15, base + variation));
      scoreRows.push({
        schoolId,
        assessmentId: assessment.id,
        studentId,
        rawScore: money(Math.round(max * fraction * 100) / 100),
        isAbsent: false,
      });
    }
  }

  for (let i = 0; i < scoreRows.length; i += 500) {
    await prisma.score.createMany({ data: scoreRows.slice(i, i + 500) });
  }
  console.log(`   ${savedAssessments.length} assessments, ${scoreRows.length} scores`);

  console.log("Creating expenses…");
  const expenseCategories = await prisma.expenseCategory.findMany({ where: { schoolId } });
  const expenses = [
    { code: "SALARIES", description: "September staff salaries", amount: 18500, payee: "Payroll" },
    { code: "UTILITIES", description: "ECG electricity bill — September", amount: 1240, payee: "ECG" },
    { code: "KITCHEN", description: "Foodstuff purchase — week 3", amount: 2100, payee: "Madina Market" },
    { code: "STATIONERY", description: "Exercise books and chalk", amount: 860, payee: "Kingdom Books" },
    { code: "MAINT", description: "Repair of classroom windows", amount: 540, payee: "Kofi Carpentry" },
    { code: "TRANSPORT", description: "Fuel for school bus", amount: 700, payee: "Goil Adenta" },
  ];
  for (const [i, e] of expenses.entries()) {
    await prisma.expense.create({
      data: {
        schoolId,
        categoryId: expenseCategories.find((c) => c.code === e.code)!.id,
        termId: term1.id,
        voucherNo: `PV-${pad(i + 1, 5)}`,
        description: e.description,
        amount: money(e.amount),
        payee: e.payee,
        method: e.code === "SALARIES" ? "BANK_TRANSFER" : "CASH",
        status: "PAID",
        spentAt: d("2026-09-30"),
        recordedByUserId: owner.id,
        approvedByUserId: owner.id,
        approvedAt: d("2026-09-30"),
      },
    });
  }

  // Advance the counters past everything this seed wrote by hand. Leaving them
  // at 1 makes the first real invoice/receipt/voucher collide with seeded rows
  // on the unique constraint — the app now probes past collisions, but a
  // counter that disagrees with its data is still a bug, not a quirk.
  console.log("Aligning number sequences…");
  for (const [key, used] of [
    ["ADMISSION", admissionSeq],
    ["INVOICE", invoiceSeq],
    ["RECEIPT", receiptSeq],
    ["VOUCHER", expenses.length],
    ["STAFF", STAFF_SEED.length],
  ] as const) {
    await prisma.numberSequence.update({
      where: { schoolId_key: { schoolId, key } },
      data: { next: used + 1 },
    });
  }

  const studentCount = await prisma.student.count({ where: { schoolId } });
  const invoiceCount = await prisma.invoice.count({ where: { schoolId } });
  const paymentCount = await prisma.payment.count({ where: { schoolId } });

  console.log("\n✅ Seed complete");
  console.log(`   School:   ${school.name} (${SLUG})`);
  console.log(`   Login:    owner@${EMAIL_DOMAIN} / Password123!`);
  console.log(`   Students: ${studentCount}   Invoices: ${invoiceCount}   Payments: ${paymentCount}`);
  console.log(`   Levels:   ${levels.length}   Subjects: ${subjects.length}   Staff: ${staffRecords.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
