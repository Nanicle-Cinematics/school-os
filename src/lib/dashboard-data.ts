import "server-only";

import { prisma } from "@/lib/prisma";

const cedis = new Intl.NumberFormat("en-GH", {
  style: "currency",
  currency: "GHS",
  maximumFractionDigits: 0,
});

export function formatCedis(value: number) {
  return cedis.format(value);
}

/**
 * Every query here is tenant-scoped by the context requireAuth() installed, so
 * none of them pass schoolId explicitly — that is the point of the RLS setup.
 * Once DB_RLS=on, Postgres enforces it rather than trusting these callers.
 */
export async function getDashboard(schoolId: string) {
  const term = await prisma.term.findFirst({
    where: { schoolId, isCurrent: true },
    include: { academicYear: true },
  });

  const [students, staff, classGroups, boys, girls] = await Promise.all([
    prisma.student.count({ where: { schoolId, status: "ACTIVE" } }),
    prisma.staff.count({ where: { schoolId, status: "ACTIVE" } }),
    prisma.classGroup.count({ where: { schoolId } }),
    prisma.student.count({ where: { schoolId, status: "ACTIVE", gender: "MALE" } }),
    prisma.student.count({ where: { schoolId, status: "ACTIVE", gender: "FEMALE" } }),
  ]);

  const invoiceTotals = term
    ? await prisma.invoice.aggregate({
        where: { schoolId, termId: term.id, status: { not: "CANCELLED" } },
        _sum: { total: true, amountPaid: true, balance: true },
      })
    : null;

  // PAID only, matching the cash book. DRAFT is spending held for a second
  // signature; showing it here would put money in the dashboard's expenditure
  // figure that the school has not agreed to, and the two screens would then
  // disagree about the same term.
  const expenseTotal = term
    ? await prisma.expense.aggregate({
        where: { schoolId, termId: term.id, status: "PAID" },
        _sum: { amount: true },
      })
    : null;

  const debtorCount = term
    ? await prisma.invoice.count({ where: { schoolId, termId: term.id, balance: { gt: 0 } } })
    : 0;

  const billed = Number(invoiceTotals?._sum.total ?? 0);
  const collected = Number(invoiceTotals?._sum.amountPaid ?? 0);
  const outstanding = Number(invoiceTotals?._sum.balance ?? 0);
  const spent = Number(expenseTotal?._sum.amount ?? 0);

  const recentPayments = await prisma.payment.findMany({
    where: { schoolId, status: "CONFIRMED" },
    orderBy: { paidAt: "desc" },
    take: 5,
    include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } },
  });

  const topDebtors = term
    ? await prisma.invoice.findMany({
        where: { schoolId, termId: term.id, balance: { gt: 0 } },
        orderBy: { balance: "desc" },
        take: 5,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              admissionNo: true,
              currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
            },
          },
        },
      })
    : [];

  const enrolmentByLevel = await prisma.level.findMany({
    where: { schoolId },
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      classGroups: { select: { _count: { select: { students: true } } } },
    },
  });

  return {
    term,
    students,
    staff,
    classGroups,
    boys,
    girls,
    billed,
    collected,
    outstanding,
    spent,
    debtorCount,
    collectionRate: billed > 0 ? (collected / billed) * 100 : 0,
    recentPayments,
    topDebtors,
    enrolmentByLevel: enrolmentByLevel.map((level) => ({
      id: level.id,
      name: level.name,
      count: level.classGroups.reduce((sum, cg) => sum + cg._count.students, 0),
    })),
  };
}

export type AttentionItem = {
  /** Stable key, and what the row is ABOUT. Not what colour it wears. */
  kind: "marking" | "fees" | "results" | "staffing" | "setup";
  /**
   * ⚠️ What this BLOCKS, which is a different question from what it is about.
   *
   * The dot used to be picked from `kind` — fees red, marking blue, results
   * green — so an overdue invoice and a first-week reminder were the same
   * colour, a school with nothing wrong still showed red, and the one row that
   * genuinely stopped work looked like the other four.
   *
   * blocking: somebody cannot do their job until this is dealt with. A school
   *           with no term cannot bill, mark or report; a class with no teacher
   *           has nobody who can enter its marks.
   * soon:     it runs out shortly. Money owed mid-term is chasing, not crisis —
   *           it becomes blocking when report cards are withheld for it.
   * pending:  waiting on a person, entirely routine. Marks still coming in.
   */
  severity: "blocking" | "soon" | "pending";
  tag: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
};

/**
 * The four things that actually stop a term finishing, computed rather than
 * listed. Each item is a sentence and the link that resolves it, so the
 * dashboard answers "what needs me today" instead of "how is the school going".
 *
 * Queries are counted deliberately: five, all aggregates. This runs on every
 * dashboard load over a link where a round trip is measured in seconds, so a
 * rule that needs a per-row query does not belong here.
 */
export async function getAttention(
  schoolId: string,
  term: { id: string; academicYearId: string } | null,
  /**
   * ⚠️ NULL for anyone outside FINANCE, and the card then says nothing about
   * money.
   *
   * The dashboard already hid the collections chart and the money tiles behind
   * `showMoney`, but this was handed the outstanding total unconditionally — so
   * "26 families owe GH₵24,158" appeared in the attention list for a nurse, a
   * librarian, and now an IT admin. The figure was gated in three places and
   * leaked from the fourth, which is what a boundary spread across call sites
   * does eventually.
   */
  fees: { outstanding: number; debtorCount: number } | null,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  /**
   * What a school that has just opened still has to do.
   *
   * ⚠️ Every rule below counts something a NEW school does not have yet — sheets,
   * results, classes short of teachers, families owing money — so all four stayed
   * silent and this card told a school with no calendar, no classes and no pupils
   * that "nothing is waiting on you". The one card built to answer "what needs me
   * today" was quiet exactly when everything did.
   *
   * These three disappear as each is done, so a running school never sees them.
   * Ordered the way the work actually goes: a class needs a year to enrol into,
   * and a pupil needs a class to sit in.
   */
  const [years, classCount, studentCount] = [
    await prisma.academicYear.count({ where: { schoolId } }),
    await prisma.classGroup.count({ where: { schoolId } }),
    await prisma.student.count({ where: { schoolId, deletedAt: null } }),
  ];

  if (years === 0) {
    items.push({
      kind: "setup",
      severity: "blocking",
      tag: "Setup",
      title: "The school has no academic year yet",
      detail: "Fees are billed per term and results are computed per term, so nothing can start without one",
      href: "/settings/terms",
      cta: "Set it up",
    });
  }
  if (classCount === 0) {
    items.push({
      kind: "setup",
      severity: "blocking",
      tag: "Setup",
      title: "No classes have been created",
      detail: "The GES levels are already here — each one needs at least a class for pupils to sit in",
      href: "/settings/structure",
      cta: "Add classes",
    });
  }
  if (studentCount === 0) {
    items.push({
      kind: "setup",
      severity: "blocking",
      tag: "Setup",
      title: "No pupils are on roll",
      detail: "Admit them one at a time, or paste the whole register in at once",
      href: "/students/import",
      cta: "Add pupils",
    });
  }

  if (term) {
    // 1. Marking. An assessment is unfinished when fewer pupils have a score
    //    than are on the roster of the class it belongs to.
    const roster = await prisma.enrollment.groupBy({
      by: ["classGroupId"],
      where: { schoolId, academicYearId: term.academicYearId, status: "ACTIVE" },
      _count: { _all: true },
    });
    const rosterByClass = new Map(roster.map((row) => [row.classGroupId, row._count._all]));

    const assessments = await prisma.assessment.findMany({
      where: { schoolId, termId: term.id, status: { not: "APPROVED" } },
      select: { id: true, classGroupId: true, _count: { select: { scores: true } } },
    });
    const unfinished = assessments.filter(
      (a) => a._count.scores < (rosterByClass.get(a.classGroupId) ?? 0),
    );
    if (unfinished.length > 0) {
      const classes = new Set(unfinished.map((a) => a.classGroupId)).size;
      items.push({
        kind: "marking",
        severity: "pending",
        tag: "Marking",
        title: `${unfinished.length} ${unfinished.length === 1 ? "sheet is" : "sheets are"} unfinished`,
        detail: `Across ${classes} ${classes === 1 ? "class" : "classes"} this term`,
        href: "/assessments/sheet",
        cta: "Open",
      });
    }

    // 3. Results computed but never published — a report card nobody can see.
    const pending = await prisma.termResult.groupBy({
      by: ["classGroupId"],
      where: { schoolId, termId: term.id, status: { not: "PUBLISHED" } },
      _count: { _all: true },
    });
    if (pending.length > 0) {
      const cards = pending.reduce((sum, row) => sum + row._count._all, 0);
      items.push({
        kind: "results",
        severity: "pending",
        tag: "Results",
        title: `${cards} report ${cards === 1 ? "card is" : "cards are"} unpublished`,
        detail: `${pending.length} ${pending.length === 1 ? "class has" : "classes have"} results computed but not released`,
        href: "/results",
        cta: "Review",
      });
    }

    // 4. Staffing. A class whose level offers more subjects than it has
    //    teachers for has a mark sheet nobody can open.
    const classes = await prisma.classGroup.findMany({
      where: { schoolId },
      select: { id: true, levelId: true },
    });
    const offerings = await prisma.levelSubject.groupBy({
      by: ["levelId"],
      where: { schoolId },
      _count: { _all: true },
    });
    const offeredByLevel = new Map(offerings.map((row) => [row.levelId, row._count._all]));
    const assigned = await prisma.teachingAssignment.groupBy({
      by: ["classGroupId"],
      where: { schoolId, academicYearId: term.academicYearId },
      _count: { _all: true },
    });
    const assignedByClass = new Map(assigned.map((row) => [row.classGroupId, row._count._all]));

    const short = classes.filter(
      (c) => (assignedByClass.get(c.id) ?? 0) < (offeredByLevel.get(c.levelId) ?? 0),
    );
    if (short.length > 0) {
      items.push({
        kind: "staffing",
        severity: "blocking",
        tag: "Staffing",
        title: `${short.length} ${short.length === 1 ? "class is" : "classes are"} missing a teacher`,
        detail: "Some subjects have nobody assigned, so their marks cannot be entered",
        href: "/classes",
        cta: "Assign",
      });
    }
  }

  // 2. Fees. Already counted for the stat cards — not queried twice.
  if (fees && fees.debtorCount > 0) {
    items.push({
      kind: "fees",
      severity: "soon",
      tag: "Fees",
      title: `${fees.debtorCount} ${fees.debtorCount === 1 ? "family owes" : "families owe"} ${formatCedis(fees.outstanding)}`,
      detail: "Unpaid invoices for the current term",
      href: "/invoices?status=owing",
      cta: "Chase",
    });
  }

  return items;
}

export type CollectionWeek = {
  /** 1-based week of the term. */
  index: number;
  label: string;
  /** Human range, for the hover. */
  range: string;
  amount: number;
  /** Share of the term's best week, 0–1, which is what the bar height shows. */
  share: number;
  isCurrent: boolean;
};

export type Collections = {
  weeks: CollectionWeek[];
  /** How many weeks the whole term runs to, so an early chart can read as early. */
  termWeeks: number;
  /** 1-based week the school is in now; 0 when the term is not under way. */
  currentWeek: number;
  total: number;
  best: number;
};

const WEEK = 7 * 24 * 60 * 60 * 1000;
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/**
 * Fees collected, by week of the term.
 *
 * Buckets ALLOCATIONS against this term's invoices, not payments by date. The
 * two differ: a payment made in week 3 can settle last term's arrears, and the
 * "Collected" stat card reads `invoice.amountPaid`. Bucketing allocations makes
 * the bars sum to exactly that figure — which `verify:collections` asserts,
 * because a chart that disagrees with the number above it is worse than no
 * chart.
 *
 * One query. The rows are two small columns bounded by a single term.
 */
export async function getCollections(
  schoolId: string,
  term: { id: string; startDate: Date; endDate: Date } | null,
  now = new Date(),
): Promise<Collections> {
  if (!term) {
    return { weeks: [], total: 0, best: 0, termWeeks: 0, currentWeek: 0 };
  }

  const allocations = await prisma.paymentAllocation.findMany({
    where: { schoolId, invoice: { termId: term.id } },
    select: { amount: true, payment: { select: { paidAt: true } } },
  });

  const start = term.startDate.getTime();
  const termWeeks = Math.max(1, Math.ceil((term.endDate.getTime() - start) / WEEK));
  // Weeks that have actually happened — an empty tail of future weeks reads as
  // a collapse in collections rather than as a term still running.
  const elapsed = Math.min(termWeeks, Math.max(1, Math.ceil((now.getTime() - start) / WEEK)));

  const sums = new Array<number>(termWeeks).fill(0);
  let total = 0;
  for (const row of allocations) {
    const amount = Number(row.amount);
    total += amount;
    // Money allocated to this term but paid before it opened belongs to week 1.
    const offset = row.payment.paidAt.getTime() - start;
    const index = Math.min(termWeeks - 1, Math.max(0, Math.floor(offset / WEEK)));
    sums[index] += amount;
  }

  // The window covers the weeks that have happened AND every week holding money.
  // A payment can be dated ahead of today — a bursar entering Friday's takings on
  // Monday, a term whose fees were settled before it opened — and trimming to
  // "weeks elapsed" alone would hide that money from a chart whose own subtitle
  // still counts it.
  const lastWithMoney = sums.reduce((last, amount, i) => (amount > 0 ? i : last), -1);
  const shown = sums.slice(0, Math.max(elapsed, lastWithMoney + 1));
  const best = Math.max(0, ...shown);

  // Only a term actually under way has a current week.
  const withinTerm = now.getTime() >= start && now.getTime() <= term.endDate.getTime();
  const currentIndex = withinTerm ? Math.floor((now.getTime() - start) / WEEK) : -1;

  const weeks = shown.map((amount, i) => {
    const from = new Date(start + i * WEEK);
    const to = new Date(Math.min(start + (i + 1) * WEEK - 1, term.endDate.getTime()));
    return {
      index: i + 1,
      label: `Wk ${i + 1}`,
      range: `${dayMonth.format(from)} – ${dayMonth.format(to)}`,
      amount,
      share: best > 0 ? amount / best : 0,
      isCurrent: i === currentIndex,
    };
  });

  // Long terms: the last dozen weeks are the ones anyone is looking at.
  //
  // `termWeeks` and `currentWeek` ride along so the CARD can say "week 2 of 15"
  // and draw the rest of the term as still to come. The weeks array itself stays
  // exactly what it was — the elapsed window, plus any week holding money —
  // because inventing future rows here is what makes a running term look like a
  // collapse in collections, and `verify:collections` pins that shape.
  return {
    weeks: weeks.slice(-12),
    total,
    best,
    termWeeks,
    currentWeek: currentIndex >= 0 ? currentIndex + 1 : 0,
  };
}

export type ActivityItem = {
  id: string;
  /** Drives the icon and its tint. */
  kind: "money" | "message" | "academic" | "people" | "admin";
  title: string;
  detail: string;
  /** "just now", "12 min", "3 hr", "Tue" — resolved server-side. */
  when: string;
  /** How many identical entries this row stands for. 1 unless folded. */
  count: number;
};

/**
 * What has happened in the school lately, read from the audit trail.
 *
 * `AuditLog` has been written on every money and grade mutation since the first
 * commit and never once read for display. Nothing new is recorded here — this
 * is a reader.
 *
 * The `after` payloads are untyped JSON written by twenty-five different call
 * sites, so every field is read defensively: a feed that throws because one old
 * row has a missing key is worse than a feed that says less about that row.
 */
const ACTIVITY: Record<
  string,
  { kind: ActivityItem["kind"]; title: (a: Record<string, unknown>) => string; detail: string }
> = {
  "payment.record": {
    kind: "money",
    title: (a) => `Payment of ${money(a.amount)} received`,
    detail: "Receipt issued",
  },
  "payment.reverse": { kind: "money", title: () => "A payment was reversed", detail: "Money returned or corrected" },
  "expense.record": {
    kind: "money",
    title: (a) => `Expense of ${money(a.amount)} recorded`,
    detail: "Cash book",
  },
  "budget.set": {
    kind: "money",
    title: (a) => `Budget set for ${text(a.category) ?? "a heading"} — ${money(a.amount)}`,
    detail: "Cash book",
  },
  "budget.clear": {
    kind: "money",
    title: (a) => `Budget removed from ${text(a.category) ?? "a heading"}`,
    detail: "Cash book",
  },
  "plan.create": {
    kind: "money",
    // Named as an agreement, because that is what a parent was told it was.
    title: (a) => `Payment plan agreed — ${count(a.count)} instalments on ${text(a.invoiceNo) ?? "a bill"}`,
    detail: "Fees",
  },
  "plan.cancel": { kind: "money", title: () => "A payment plan was ended", detail: "Fees" },
  "statement.reconcile": {
    kind: "money",
    title: (a) => `Statement reconciled — ${count(a.matched)} of ${count(a.lines)} lines matched`,
    detail: "Fees",
  },
  "expense.approve": {
    kind: "money",
    // Named as an approval rather than "an expense was updated": the whole
    // point of the hold is that somebody signed, and a feed that does not say
    // so loses the only record of who did.
    title: (a) => `Expense of ${money(a.amount)} approved`,
    detail: "Cash book",
  },
  "expense.cancel": { kind: "money", title: () => "An expense was cancelled", detail: "Cash book" },
  "invoice.cancel": { kind: "money", title: () => "An invoice was cancelled", detail: "Fees" },
  /* The skipped count is the interesting half: a batch that billed 180 and
     skipped 40 is a question, and a feed that only said "180 invoices" would
     hide it. */
  "invoice.generateBatch": {
    kind: "money",
    title: (a) => {
      const created = count(a.created);
      const skipped = Number(a.skipped);
      const head = `${created} ${plural(a.created, "invoice")} generated`;
      return Number.isFinite(skipped) && skipped > 0 ? `${head}, ${skipped} skipped` : head;
    },
    detail: "Fees",
  },
  "feeCategory.create": {
    kind: "money",
    title: (a) => {
      const name = text(a.name);
      return name ? `“${name}” was added as a fee item` : "A fee item was added";
    },
    detail: "Fees",
  },
  "feeCategory.update": {
    kind: "money",
    title: (a) => {
      const name = text(a.name);
      return name ? `The “${name}” fee item was changed` : "A fee item was changed";
    },
    detail: "Fees",
  },
  "feeCategory.delete": {
    kind: "money",
    title: () => "A fee item was removed",
    detail: "Fees",
  },
  "feeStructure.delete": {
    kind: "money",
    title: () => "A fee structure was removed",
    detail: "Fees",
  },
  "guardian.login.create": {
    kind: "people",
    title: (a) => `${text(a.guardianName) ?? "A guardian"} was given a parent portal login`,
    detail: "Guardians",
  },
  "campaign.send": {
    kind: "message",
    title: (a) => `SMS sent to ${count(a.recipients)} ${plural(a.recipients, "recipient")}`,
    detail: "Messages",
  },
  "results.compute": { kind: "academic", title: () => "Results computed for a class", detail: "Academics" },
  /**
   * The payload carries the status and how many pupils it touched, and this
   * ignored both — so publishing a term's results printed "Results status
   * changed" five times over, once per class, with nothing to tell them apart.
   */
  "results.status": {
    kind: "academic",
    title: (a) => {
      const n = count(a.affected);
      const who = n ? ` for ${n} ${plural(n, "pupil")}` : "";
      switch (String(a.status ?? "")) {
        case "PUBLISHED":
          return `Report cards published${who}`;
        case "APPROVED":
          return `Results approved${who}`;
        case "SUBMITTED":
          return `Results submitted for approval${who}`;
        case "DRAFT":
          return `Results were unpublished${who}`;
        default:
          return "Results status changed";
      }
    },
    detail: "Academics",
  },
  "results.remarks": { kind: "academic", title: () => "Conduct and remarks saved", detail: "Academics" },
  "results.classRemarks": {
    kind: "academic",
    title: (a) => `Conduct and remarks saved for ${count(a.students)} ${plural(a.students, "pupil")}`,
    detail: "Academics",
  },
  /* Marks, phrased by how many landed rather than by the screen they came from
     — a head reading the feed cares that Basic 5 got marked, not which of the
     two entry screens did it. `cleared` is deliberately absent: a teacher
     blanking a mistyped mark is not news. */
  "score.saveSheet": {
    kind: "academic",
    title: (a) => `${count(a.marked)} ${plural(a.marked, "mark")} entered`,
    detail: "Mark sheet",
  },
  "score.saveBatch": {
    kind: "academic",
    title: (a) => `${count(a.entered)} ${plural(a.entered, "mark")} entered`,
    detail: "Assessment",
  },
  "assessment.create": { kind: "academic", title: () => "An assessment was created", detail: "Academics" },
  "assessment.status": { kind: "academic", title: () => "An assessment was locked or reopened", detail: "Academics" },
  "assessment.delete": { kind: "academic", title: () => "An assessment was deleted", detail: "Academics" },
  "component.delete": { kind: "academic", title: () => "An assessment component was removed", detail: "Settings" },
  "student.admit": { kind: "people", title: () => "A pupil was admitted", detail: "Students" },
  "student.enrol": { kind: "people", title: () => "A pupil was placed in a class", detail: "Students" },
  "student.withdraw": { kind: "people", title: () => "A pupil was withdrawn", detail: "Students" },
  "student.import": {
    kind: "people",
    title: (a) => `${count(a.created)} ${plural(a.created, "pupil")} imported`,
    detail: "From a spreadsheet",
  },
  "promotion.run": {
    kind: "people",
    title: (a) => `${count(a.students)} ${plural(a.students, "pupil")} moved up a year`,
    detail: "Promotions",
  },
  /* The number that matters in a register is who was NOT there — a line saying
     "the register was taken" tells a head nothing they could act on. */
  "attendance.register": {
    kind: "academic",
    title: (a) => {
      const away = Number(a.absent ?? 0) + Number(a.excused ?? 0);
      return away > 0
        ? `${count(away)} ${plural(away, "pupil")} away`
        : "A full register — everybody in";
    },
    detail: "Attendance",
  },
  "attendance.day.remove": {
    kind: "academic",
    title: () => "A day's register was removed",
    detail: "Attendance",
  },
  "user.create": { kind: "admin", title: () => "A staff login was created", detail: "Users" },
  "user.roles": { kind: "admin", title: () => "Someone's roles changed", detail: "Users" },
  "term.update": { kind: "admin", title: () => "Term dates changed", detail: "Settings" },
  "settings.academic": { kind: "admin", title: () => "Academic settings changed", detail: "Settings" },
  "school.asset.upload": { kind: "admin", title: () => "The crest or signature was updated", detail: "Settings" },
  "school.asset.remove": { kind: "admin", title: () => "The crest or signature was removed", detail: "Settings" },
  "school.provision": { kind: "admin", title: () => "The school was set up", detail: "Nanicle" },
  "school.backup.triggered": {
    kind: "admin",
    title: () => "A backup of this school was triggered on demand",
    detail: "Nanicle",
  },
  /* A head teacher asking "why did this go read-only in March" gets an answer
     from the trail rather than from somebody's memory. */
  "school.subscription": {
    kind: "admin",
    title: (a) => {
      const status = String(a.subscriptionStatus ?? "");
      return status ? `The subscription was set to ${status.replace(/_/g, " ").toLowerCase()}` : "The subscription changed";
    },
    detail: "Nanicle",
  },
  "school.subscription.paid": {
    kind: "admin",
    title: (a) => `A subscription payment of ${money(a.amount)} was recorded`,
    detail: "Nanicle",
  },
  /**
   * Somebody took a copy of the school's records. This is the entry that most
   * deserves a phrase rather than a fallback: "data export · Activity · Grace
   * Amoah" tells a head teacher nothing, and the whole point of auditing an
   * export is that a head can see WHAT left and how much of it.
   */
  "data.export": {
    kind: "admin",
    title: (a) => {
      const dataset = text(a.dataset);
      const rows = Number(a.rows);
      const what = dataset ? dataset.replace(/_/g, " ") : "records";
      // "44 rows exported from invoices", not "44 invoices rows were exported".
      // The dataset names are already plural, so any phrasing that puts the
      // count in front of them reads wrong for one of them — this one reads
      // right for all six, and for a single row.
      return Number.isFinite(rows)
        ? `${count(rows)} ${plural(rows, "row")} exported from ${what}`
        : `The ${what} were exported`;
    },
    detail: "Export",
  },
  "user.password.change": {
    kind: "admin",
    title: () => "A password was changed",
    detail: "Security",
  },
};

function money(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? formatCedis(n) : "an amount";
}
function count(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "Some";
}
function plural(value: unknown, word: string) {
  return Number(value) === 1 ? word : `${word}s`;
}
/** A name out of untyped audit JSON, or null so the caller can phrase around it. */
function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Relative time, resolved here so no component reads the clock during render. */
function ago(then: Date, now: Date) {
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(then);
}

/**
 * The actions this feed knows how to phrase. `verify:activity` greps every
 * `writeAudit` call in the codebase and asserts each one appears here — so a new
 * audited action cannot quietly reach the dashboard as a raw string like
 * "invoice generate".
 */
export const ACTIVITY_ACTIONS = Object.keys(ACTIVITY);

export async function getActivity(schoolId: string, take = 6, now = new Date()) {
  // Read deeper than we display, because identical entries are folded below and
  // a term's results being published across eleven classes would otherwise fill
  // the whole feed with one event.
  const rows = await prisma.auditLog.findMany({
    where: { schoolId },
    orderBy: { createdAt: "desc" },
    take: take * 5,
    select: {
      id: true,
      action: true,
      after: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });

  const items = rows.map((row): ActivityItem => {
    const spec = ACTIVITY[row.action];
    const payload = (row.after ?? {}) as Record<string, unknown>;
    const who = row.actor?.name;
    return {
      id: row.id,
      kind: spec?.kind ?? "admin",
      // An unmapped action still shows: the trail is the record, and a silent
      // gap in it would be the one thing worth noticing.
      title: spec ? spec.title(payload) : row.action.replace(/[._]/g, " "),
      detail: who ? `${spec?.detail ?? "Activity"} · ${who}` : (spec?.detail ?? "Activity"),
      when: ago(row.createdAt, now),
      count: 1,
    };
  });

  /**
   * Fold runs of the identical line into one, counted.
   *
   * One action across eleven classes is eleven audit rows and one thing that
   * happened. Printed as eleven lines it pushed everything else off the card and
   * told a head teacher nothing they could not have read once — the feed said
   * "Results status changed" five times in the same second.
   *
   * Only CONSECUTIVE runs fold, so the order of events is never rearranged: this
   * shortens the feed, it does not reorder or summarise across time.
   */
  const folded: ActivityItem[] = [];
  for (const item of items) {
    const last = folded[folded.length - 1];
    if (last && last.title === item.title && last.detail === item.detail) {
      last.count += 1;
      continue;
    }
    folded.push(item);
  }

  return folded.slice(0, take);
}
