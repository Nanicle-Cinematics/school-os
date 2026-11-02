import "server-only";

import type { GuardianRelationship, Prisma, StudentStatus } from "@prisma/client";
import { admissionBlocked } from "@/lib/capacity";
import { writeAudit } from "@/lib/audit";
import { sameGuardian } from "@/lib/guardian-match";
import { tenantTransaction, type TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { normalisePhone } from "@/lib/sms-shared";

/**
 * Putting a child on the roll: the admission number, the pupil, the class, the guardian, the audit row.
 *
 * One function, because there are two ways in (the office's admit form and admitting an application) and a
 * second copy of this sequence would drift: the guardian match by phone, the cap, the number probe and the
 * enrolment all have a reason, and each of them has been wrong once. It is not a "use server" module:
 * every export of one is a callable endpoint, and this takes the school as an argument.
 *
 * The caller has already run `requireRole` and `setTenantContext`, and has read any class, house or
 * programme id back through the tenant client (a foreign-reference constraint ignores row security).
 */

export type PupilProfile = Omit<
  Prisma.StudentUncheckedCreateInput,
  "schoolId" | "admissionNo" | "status" | "admissionDate" | "currentClassGroupId"
>;

export type PupilGuardian = {
  firstName: string;
  lastName: string;
  phone: string;
  relationship: GuardianRelationship;
  receivesBills: boolean;
  receivesReports: boolean;
};

export type AdmitPupil = {
  schoolId: string;
  actorUserId: string | null;
  profile: PupilProfile;
  status: StudentStatus;
  admissionDate: Date | null;
  /** Empty for "not placed yet". Needs `yearId`: a class with no year would leave a pupil no roster sees. */
  classGroupId: string;
  yearId: string | null;
  guardian: PupilGuardian | null;
  /** Anything else to record on the audit row (the application a pupil came from). */
  auditExtra?: Record<string, unknown>;
  /** Runs inside the same transaction, so the thing that caused the admission commits with it. */
  afterCreate?: (tx: TenantTx, studentId: string) => Promise<void>;
};

export type AdmitOutcome =
  | { ok: true; studentId: string; admissionNo: string }
  | { ok: false; error: string };

export function mismatchMessage(phone: string, onFile: string) {
  return (
    `${phone} is already on file for ${onFile}, which is not the name you entered. ` +
    `If that is the same person, enter the name as it is on file; if not, check the number — ` +
    `a wrong digit would give another family access to this child's fees and results.`
  );
}

export async function admitPupil(input: AdmitPupil): Promise<AdmitOutcome> {
  const { schoolId, guardian, classGroupId, yearId } = input;

  // Admitting straight into a class is the normal path; without a year there is no roster to join, and a
  // pupil with a class but no enrolment would be invisible to invoicing and score entry.
  if (classGroupId && !yearId) {
    return { ok: false, error: "No academic year is marked current, so nobody can be placed in a class yet." };
  }

  // Checked before the transaction opens: a refusal should cost a count, not a rolled-back write and an
  // admission number burnt out of the sequence.
  const full = await admissionBlocked(schoolId, 1);
  if (full) {
    return { ok: false, error: full };
  }

  try {
    return await tenantTransaction(schoolId, async (tx: TenantTx): Promise<AdmitOutcome> => {
      const allocated = await nextNumber(tx, schoolId, "ADMISSION", takenProbes.admission(tx, schoolId));

      const student = await tx.student.create({
        data: {
          ...input.profile,
          schoolId,
          admissionNo: allocated,
          status: input.status,
          admissionDate: input.admissionDate ?? new Date(),
          currentClassGroupId: classGroupId || null,
        },
      });

      if (classGroupId && yearId) {
        await tx.enrollment.create({
          data: { schoolId, studentId: student.id, academicYearId: yearId, classGroupId, status: "ACTIVE" },
        });
      }

      if (guardian) {
        // Siblings share a parent: match on the normalised phone so a family of four does not become four
        // copies of the same mother.
        const wanted = normalisePhone(guardian.phone);
        const candidates = await tx.guardian.findMany({
          where: { deletedAt: null },
          select: { id: true, phone: true, firstName: true, lastName: true },
        });
        const existing = candidates.find((c) => normalisePhone(c.phone) === wanted);
        if (
          existing &&
          !sameGuardian(`${guardian.firstName} ${guardian.lastName}`, `${existing.firstName} ${existing.lastName}`)
        ) {
          throw new Error(`GUARDIAN_MISMATCH:${existing.firstName} ${existing.lastName}`);
        }

        const guardianId =
          existing?.id ??
          (
            await tx.guardian.create({
              data: { schoolId, firstName: guardian.firstName, lastName: guardian.lastName, phone: guardian.phone },
            })
          ).id;

        await tx.studentGuardian.create({
          data: {
            schoolId,
            studentId: student.id,
            guardianId,
            relationship: guardian.relationship,
            isPrimary: true,
            receivesBills: guardian.receivesBills,
            receivesReports: guardian.receivesReports,
          },
        });
      }

      await writeAudit(tx, {
        schoolId,
        actorUserId: input.actorUserId,
        action: "student.admit",
        entity: "Student",
        entityId: student.id,
        after: {
          admissionNo: allocated,
          classGroupId: classGroupId || null,
          status: input.status,
          ...(input.auditExtra ?? {}),
        },
      });

      if (input.afterCreate) {
        await input.afterCreate(tx, student.id);
      }

      return { ok: true, studentId: student.id, admissionNo: allocated };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GUARDIAN_MISMATCH:") && guardian) {
      return { ok: false, error: mismatchMessage(guardian.phone, error.message.slice("GUARDIAN_MISMATCH:".length)) };
    }
    throw error;
  }
}
