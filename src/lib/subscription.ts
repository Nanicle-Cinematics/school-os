import type { Plan, SubscriptionStatus } from "@prisma/client";

/**
 * What a school's subscription state MEANS, in one place.
 *
 * ⚠️ `plan`, `subscriptionStatus`, `trialEndsAt` and `studentCap` were written at
 * provisioning, shown in the console and enforced NOWHERE: a trial that ended in
 * March still worked in September, and there was no action to change any of them.
 * The same dead-switch this codebase shipped for `notifyOnPayment`, with the
 * revenue attached.
 *
 * The rule, decided deliberately: an unpaid school goes READ-ONLY for staff.
 * Records, report cards and printing keep working — a school mid-term has
 * children whose results are in here, and locking a head teacher out of them to
 * chase an invoice punishes the wrong people. Writing is refused: no admissions,
 * no billing, no marking, no publishing.
 *
 * Parents are never affected. The portal only reads, and a school's unpaid
 * invoice is not a family's fault.
 */

export type SubscriptionState = {
  /** Staff may read but not write. */
  readOnly: boolean;
  /** Shown to staff, in their words, or null when everything is in order. */
  notice: string | null;
  /** Days until the trial ends; negative once it has. Null when not trialing. */
  trialDaysLeft: number | null;
};

const DAY = 86_400_000;

export function subscriptionState(
  school: {
    plan: Plan;
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
  },
  now = new Date(),
): SubscriptionState {
  const trialDaysLeft = school.trialEndsAt
    ? Math.ceil((school.trialEndsAt.getTime() - now.getTime()) / DAY)
    : null;

  switch (school.subscriptionStatus) {
    case "ACTIVE":
      return { readOnly: false, notice: null, trialDaysLeft };

    case "TRIALING": {
      // A trial with no end date is an open trial, not an expired one — the
      // absence of a date must never be read as "ran out".
      if (trialDaysLeft === null) {
        return { readOnly: false, notice: null, trialDaysLeft };
      }
      if (trialDaysLeft <= 0) {
        return {
          readOnly: true,
          notice:
            "Your trial has ended, so the school is read-only: records and report cards can still be " +
            "read and printed, but nothing new can be entered. Contact Nanicle to continue.",
          trialDaysLeft,
        };
      }
      return {
        readOnly: false,
        // Quiet until the last week: a countdown on every screen for a month is
        // furniture, and furniture is not read.
        notice:
          trialDaysLeft <= 7
            ? `Your trial ends in ${trialDaysLeft} ${trialDaysLeft === 1 ? "day" : "days"}. Contact Nanicle to continue without interruption.`
            : null,
        trialDaysLeft,
      };
    }

    case "PAST_DUE":
      return {
        readOnly: true,
        notice:
          "This school's subscription is past due, so it is read-only: records and report cards can " +
          "still be read and printed, but nothing new can be entered. Settle it to continue.",
        trialDaysLeft,
      };

    case "SUSPENDED":
      return {
        readOnly: true,
        notice:
          "This school's subscription is suspended, so it is read-only. Records and report cards can " +
          "still be read and printed. Contact Nanicle.",
        trialDaysLeft,
      };

    case "CANCELLED":
      return {
        readOnly: true,
        notice:
          "This school's subscription has been cancelled. Records remain readable and printable so " +
          "nothing is lost; nothing new can be entered.",
        trialDaysLeft,
      };
  }
}

/** What each plan is called on screen, and what it allows. */
export const PLANS: Record<Plan, { label: string; studentCap: number | null }> = {
  TRIAL: { label: "Trial", studentCap: 60 },
  STARTER: { label: "Starter", studentCap: 150 },
  GROWTH: { label: "Growth", studentCap: 500 },
  SCHOOL_PLUS: { label: "School Plus", studentCap: null },
};

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  TRIALING: "Trialing",
  ACTIVE: "Active",
  PAST_DUE: "Past due",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};
