import "server-only";

import { Prisma, type Plan } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { applyGesCurriculum } from "@/lib/ges-curriculum";
import { applyDefaultFinanceCategories } from "@/lib/finance-defaults";
import { applyDefaultBillCodes } from "@/lib/billcode-defaults";
import { applyDefaultChartOfAccounts } from "@/lib/ledger-defaults";
import { applyDefaultMessageTemplates } from "@/lib/message-defaults";
import { schoolYearFor, splitIntoTerms } from "@/lib/academic-year";
import { PLANS, TRIAL_DAYS, nextDueDate } from "@/lib/subscription";
import { applyDefaultAssessmentTemplate } from "@/lib/assessment-templates";

/**
 * Everything a school is handed on day one.
 *
 * This lives apart from the `"use server"` action that calls it so it can be
 * exercised without a browser: provisioning is the first code a paying customer
 * meets, and `scripts/verify-onboarding.mts` walks a school built by this exact
 * function rather than by a re-implementation that could drift from it.
 */

/**
 * The Ghanaian basic-school scale, as a starting point.
 *
 * A school with no grading scale cannot compute a single result, so provisioning
 * one without it hands over an app that looks finished and fails at the first
 * report card. The head can edit the bands, or duplicate and replace it.
 */
export const DEFAULT_BANDS = [
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

export type ProvisionInput = {
  name: string;
  slug: string;
  shortName: string | null;
  plan: Plan;
  /** 50 for basic school, 30 for SHS. The exam weight is the remainder. */
  classScoreWeight: number;
  ownerName: string;
  ownerEmail: string;
  passwordHash: string;
  /** The platform admin doing the provisioning, for the audit trail. */
  actorUserId: string;
};

/**
 * Seeding the curriculum is 11 levels, 18 subjects and 104 offerings, so the
 * transaction wrapping this needs a budget far past Prisma's 5s default.
 */
export const PROVISION_TX_OPTS = { timeout: 180_000, maxWait: 20_000 };

export async function provisionSchool(tx: TenantTx, input: ProvisionInput) {
  const school = await tx.school.create({
    data: {
      name: input.name,
      slug: input.slug,
      shortName: input.shortName,
      plan: input.plan,
      subscriptionStatus: input.plan === "TRIAL" ? "TRIALING" : "ACTIVE",
      // TRIAL_DAYS, not a number written here: this said 30 while the console's
      // plan picker said 30 and the price list says 7, and the school is the one
      // who finds out which was true.
      trialEndsAt:
        input.plan === "TRIAL" ? new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000) : null,
      // A paid school starts on its plan's price and its first month runs from
      // today. Both are editable per school — a negotiated rate is a decision
      // about that school, not a change to the price list.
      monthlyFee: PLANS[input.plan].monthlyPrice,
      paidUntil: input.plan === "TRIAL" ? null : nextDueDate(null),
    },
  });

  const scale = await tx.gradingScale.create({
    data: { schoolId: school.id, name: "Basic School 1–9", isDefault: true },
  });
  await tx.gradeBand.createMany({
    data: DEFAULT_BANDS.map((band) => ({
      schoolId: school.id,
      gradingScaleId: scale.id,
      grade: band.grade,
      minScore: new Prisma.Decimal(band.minScore),
      maxScore: new Prisma.Decimal(band.maxScore),
      points: band.points,
      remark: band.remark,
      isPass: band.isPass,
    })),
  });

  await tx.schoolSettings.create({
    data: {
      schoolId: school.id,
      classScoreWeight: input.classScoreWeight,
      examScoreWeight: 100 - input.classScoreWeight,
      defaultGradingScaleId: scale.id,
    },
  });

  const owner = await tx.user.create({
    data: {
      name: input.ownerName,
      email: input.ownerEmail,
      passwordHash: input.passwordHash,
      // The console hands the proprietor a temporary password too, so the same
      // rule applies to the very first login a school ever has.
      mustChangePassword: true,
      passwordIssuedAt: new Date(),
      schoolId: school.id,
    },
  });

  await tx.membership.create({
    data: {
      schoolId: school.id,
      userId: owner.id,
      role: "OWNER",
      status: "ACTIVE",
      invitedAt: new Date(),
      acceptedAt: new Date(),
    },
  });

  // Every school starts on the national curriculum rather than an empty ladder:
  // eleven levels KG1–JHS3 and the GES subject offering for each, transitions
  // included.
  await applyGesCurriculum(tx, school.id);

  // And on a working bill: a fee structure is priced per item, so a school with
  // no fee items cannot enter an amount anywhere.
  await applyDefaultFinanceCategories(tx, school.id);

  // And a chart of accounts, linked to the fee items and expense headings
  // just created — foundation for double-entry posting, added later.
  await applyDefaultChartOfAccounts(tx, school.id);

  // And on a bill CODE — generateInvoicesForTerm stamps TERMBILL onto every
  // invoice it creates, so it must exist before this school's first term bill.
  await applyDefaultBillCodes(tx, school.id);

  // And on a working mark sheet: without components a teacher builds
  // "Class Test 1" by hand for every subject in every class.
  await applyDefaultAssessmentTemplate(tx, school.id);

  // And on the texts it sends without composing them. A receipt is found by
  // NAME, so a school with no templates does not send a broken receipt — it
  // sends nothing, and says nothing about it.
  await applyDefaultMessageTemplates(tx, school.id);

  /**
   * And on a CALENDAR, which everything else hangs off.
   *
   * Fees are priced per term, results are computed per term, the dashboard
   * reports on one — so a school with no academic year met three screens that
   * refused to render and told it, in prose, to go and build one. Every other
   * day-one decision here is already made for the school and left editable; the
   * year is the one that unlocks the rest, and it was the one omitted.
   *
   * The dates are the standard Ghanaian shape and are a starting point, exactly
   * as the fee items and the GES ladder are: GES sets real term dates, they move
   * every year, and /settings/terms is where a school corrects them. The term
   * containing today is marked current so the school lands on a working
   * dashboard rather than an accurate one about nothing.
   */
  const now = new Date();
  const yearShape = schoolYearFor(now);
  const year = await tx.academicYear.create({
    data: { schoolId: school.id, ...yearShape, isCurrent: true },
  });
  const terms = splitIntoTerms(yearShape.startDate, yearShape.endDate);
  // Before the year opens — a school set up in August — the first term is the
  // one it is about to run.
  const currentSequence =
    terms.find((t) => now >= t.startDate && now <= t.endDate)?.sequence ?? 1;
  await tx.term.createMany({
    data: terms.map((term) => ({
      schoolId: school.id,
      academicYearId: year.id,
      name: term.name,
      sequence: term.sequence,
      startDate: term.startDate,
      endDate: term.endDate,
      isCurrent: term.sequence === currentSequence,
    })),
  });

  await writeAudit(tx, {
    schoolId: school.id,
    actorUserId: input.actorUserId,
    action: "school.provision",
    entity: "School",
    entityId: school.id,
    after: {
      name: input.name,
      slug: input.slug,
      plan: input.plan,
      classScoreWeight: input.classScoreWeight,
      owner: input.ownerEmail,
    },
  });

  return { school, owner };
}
