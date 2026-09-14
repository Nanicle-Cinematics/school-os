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

/**
 * Days a school keeps working after its month runs out.
 *
 * Not generosity — arithmetic. School money arrives in the first weeks of term
 * and thins out by the end of it, so a monthly bill will routinely be paid
 * late in the months when the office has nothing in hand. Cutting a school off
 * the morning after the date passes turns a cashflow gap into an argument, and
 * the head teacher who cannot print a report card that week remembers it longer
 * than the invoice.
 *
 * A week is enough to cover "we will pay on Friday" without becoming a second
 * free month.
 */
const GRACE_DAYS = 7;

export type SubscriptionState = {
  /** Staff may read but not write. */
  readOnly: boolean;
  /** Shown to staff, in their words, or null when everything is in order. */
  notice: string | null;
  /** Days until the trial ends; negative once it has. Null when not trialing. */
  trialDaysLeft: number | null;
  /** Days until the paid month runs out; negative once it has. Null if never paid. */
  daysPaidAhead: number | null;
  /** Inside the week after the due date: still writing, but told. */
  inGrace: boolean;
};

const DAY = 86_400_000;

export function subscriptionState(
  school: {
    plan: Plan;
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
    paidUntil?: Date | null;
  },
  now = new Date(),
): SubscriptionState {
  const trialDaysLeft = school.trialEndsAt
    ? Math.ceil((school.trialEndsAt.getTime() - now.getTime()) / DAY)
    : null;
  const daysPaidAhead = school.paidUntil
    ? Math.ceil((school.paidUntil.getTime() - now.getTime()) / DAY)
    : null;
  const base = { trialDaysLeft, daysPaidAhead, inGrace: false };

  switch (school.subscriptionStatus) {
    case "ACTIVE": {
      /**
       * ⚠️ ACTIVE is not a permanent state under monthly billing — it means
       * "paid up to `paidUntil`". Reading the status alone is how a school that
       * stopped paying in March is still marked Active in September, which is
       * the same class of dead field this whole file exists to end.
       */
      if (daysPaidAhead === null) {
        // Marked active but never dated: a school being set up by hand, not a
        // school in arrears. Do not punish a missing field.
        return { ...base, readOnly: false, notice: null };
      }
      if (daysPaidAhead > 7) {
        return { ...base, readOnly: false, notice: null };
      }
      if (daysPaidAhead >= 0) {
        return {
          ...base,
          readOnly: false,
          notice: `This school's subscription is due in ${daysPaidAhead} ${
            daysPaidAhead === 1 ? "day" : "days"
          }.`,
        };
      }
      const overdue = Math.abs(daysPaidAhead);
      if (overdue <= GRACE_DAYS) {
        return {
          ...base,
          readOnly: false,
          inGrace: true,
          notice:
            `This school's subscription was due ${overdue} ${overdue === 1 ? "day" : "days"} ago. ` +
            `It keeps working for ${GRACE_DAYS - overdue} more ${
              GRACE_DAYS - overdue === 1 ? "day" : "days"
            }, then becomes read-only until it is settled.`,
        };
      }
      return {
        ...base,
        readOnly: true,
        notice:
          `This school's subscription was due ${overdue} days ago, so it is read-only: records and ` +
          `report cards can still be read and printed, but nothing new can be entered. Settle it to continue.`,
      };
    }

    case "TRIALING": {
      // A trial with no end date is an open trial, not an expired one — the
      // absence of a date must never be read as "ran out".
      if (trialDaysLeft === null) {
        return { ...base, readOnly: false, notice: null };
      }
      if (trialDaysLeft <= 0) {
        return {
          ...base,
          readOnly: true,
          notice:
            "Your trial has ended, so the school is read-only: records and report cards can still be " +
            "read and printed, but nothing new can be entered. Contact Nanicle to continue.",
        };
      }
      return {
        ...base,
        readOnly: false,
        // Quiet until the last week: a countdown on every screen for a month is
        // furniture, and furniture is not read.
        notice:
          trialDaysLeft <= 7
            ? `Your trial ends in ${trialDaysLeft} ${trialDaysLeft === 1 ? "day" : "days"}. Contact Nanicle to continue without interruption.`
            : null,
      };
    }

    case "PAST_DUE":
      return {
        ...base,
        readOnly: true,
        notice:
          "This school's subscription is past due, so it is read-only: records and report cards can " +
          "still be read and printed, but nothing new can be entered. Settle it to continue.",
      };

    case "SUSPENDED":
      return {
        ...base,
        readOnly: true,
        notice:
          "This school's subscription is suspended, so it is read-only. Records and report cards can " +
          "still be read and printed. Contact Nanicle.",
      };

    case "CANCELLED":
      return {
        ...base,
        readOnly: true,
        notice:
          "This school's subscription has been cancelled. Records remain readable and printable so " +
          "nothing is lost; nothing new can be entered.",
      };
  }
}

/**
 * The next month's due date, given the one it already holds.
 *
 * ⚠️ Advances from `paidUntil`, NOT from today. A school that pays four days
 * late has bought a month, not a month minus four days — billing from the
 * payment date quietly shortens every late month and the school ends up paying
 * thirteen times a year without anyone deciding to charge them that.
 *
 * From today only when there is nothing to advance from, or when the last
 * payment lapsed so long ago that advancing would still leave them overdue —
 * which would mean taking money and handing back a read-only system.
 */
export function nextDueDate(paidUntil: Date | null, now = new Date()): Date {
  const from = paidUntil && paidUntil.getTime() > now.getTime() - 31 * DAY ? paidUntil : now;
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}

/** How long a new school has before it has to decide. */
export const TRIAL_DAYS = 7;

/**
 * What each plan is called, what it costs a month, and what it allows.
 *
 * ⚠️ **No pupil caps.** The two paid plans are separated by price, not by roll
 * size, so nothing here refuses an admission. A school that needs a limit gets
 * one on its own record (`studentCap` on the console), which is a decision about
 * that school rather than a rule invented for everybody.
 *
 * The trial is uncapped for the same reason and a sharper one: a school
 * evaluating the software imports its real register, and meeting a limit in the
 * middle of that is the worst possible moment to meet one. It is limited by TIME
 * instead — seven days — which `trialEndsAt` already enforces.
 */
/**
 * ONE paid plan, deliberately.
 *
 * There were two — Standard at GH₵500 and Institution Plus at GH₵800 — and they
 * were identical: same features, same (absent) pupil cap, same everything. The
 * `plan` field was read in five places, all of them a label, a price or a badge
 * colour. A school paying GH₵800 got a school paying GH₵500, plus GH₵300.
 *
 * A price difference that buys nothing is not a tier, it is a thing to explain
 * on a sales call. Removed 2026-09-14, before any school was ever charged.
 *
 * `monthlyFee` on the school remains editable in the console, so what a school
 * actually pays is still a conversation — which is what the two plans were
 * really standing in for.
 */
export const PLANS: Record<
  Plan,
  { label: string; studentCap: number | null; monthlyPrice: number | null }
> = {
  TRIAL: { label: "Trial", studentCap: null, monthlyPrice: 0 },
  INSTITUTION_PLUS: { label: "Institution Plus", studentCap: null, monthlyPrice: 800 },
};

/**
 * How many pupils this school may have on roll.
 *
 * The explicit `studentCap` wins where it is set — a school that negotiated 200
 * on Starter keeps 200 — and the plan's own number is the default. Null is no
 * cap at all.
 *
 * ⚠️ A cap is a limit on ADMITTING, never on having. A school that is over — the
 * plan changed, or pupils were imported before the cap was set — keeps every
 * child it has: withdrawing them to satisfy a billing question would hide
 * children from their own school, and the school would still be teaching them on
 * Monday. Only the next admission is refused.
 */
export function pupilCap(school: { plan: Plan; studentCap: number | null }): number | null {
  return school.studentCap ?? PLANS[school.plan].studentCap;
}

export type Capacity = {
  cap: number | null;
  onRoll: number;
  /** Room for this many more. Null when uncapped. */
  remaining: number | null;
  full: boolean;
};

export function capacity(
  school: { plan: Plan; studentCap: number | null },
  onRoll: number,
): Capacity {
  const cap = pupilCap(school);
  if (cap === null) {
    return { cap: null, onRoll, remaining: null, full: false };
  }
  return { cap, onRoll, remaining: Math.max(0, cap - onRoll), full: onRoll >= cap };
}

/** What to tell the office, in numbers they can act on. */
export function capacityMessage(c: Capacity, adding: number, planLabel: string) {
  if (c.cap === null) {
    return null;
  }
  const after = c.onRoll + adding;
  if (after <= c.cap) {
    return null;
  }
  return adding === 1
    ? `This school is at its limit of ${c.cap} pupils on the ${planLabel} plan — ${c.onRoll} are on roll. ` +
        `Contact Nanicle to raise it. No existing pupil is affected.`
    : `That would take the school to ${after} pupils, past its limit of ${c.cap} on the ${planLabel} plan ` +
        `(${c.onRoll} on roll). Nothing has been imported. Contact Nanicle to raise the limit, or import fewer rows.`;
}

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  TRIALING: "Trialing",
  ACTIVE: "Active",
  PAST_DUE: "Past due",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};
