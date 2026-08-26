"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export type ClassState = { error?: string; ok?: string };

export async function saveClassGroup(
  _prev: ClassState,
  formData: FormData,
): Promise<ClassState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const levelId = String(formData.get("levelId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const formTeacherId = String(formData.get("formTeacherId") ?? "");
  const capacityRaw = String(formData.get("capacity") ?? "").trim();
  const capacity = capacityRaw ? Number(capacityRaw) : null;

  if (!levelId) {
    return { error: "Pick the level this class sits in." };
  }
  if (!name) {
    return { error: "Give the class a stream name, e.g. Gold." };
  }
  if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0)) {
    return { error: "Capacity must be a whole number of seats, or blank." };
  }

  const data = {
    levelId,
    name,
    capacity: capacity === null ? null : Math.trunc(capacity),
    formTeacherId: formTeacherId || null,
  };

  try {
    if (id) {
      await prisma.classGroup.update({ where: { id }, data });
      revalidatePath(`/classes/${id}`);
      revalidatePath("/classes");
      return { ok: `Saved ${name}.` };
    }

    await prisma.classGroup.create({ data: { schoolId: auth.schoolId, ...data } });
    revalidatePath("/classes");
    return { ok: `Added ${name}.` };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `That level already has a class called ${name}.` };
    }
    throw error;
  }
}

export async function deleteClassGroup(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // Enrollment cascades on delete at the database level (so a school can be torn
  // down in one go), which means the guard has to live here — deleting a class
  // with a roster would silently erase every enrolment record it holds.
  const enrolled = await prisma.enrollment.count({ where: { classGroupId: id } });
  if (enrolled > 0) {
    redirect(`/classes/${id}?error=has-roster`);
  }

  await prisma.classGroup.delete({ where: { id } });
  revalidatePath("/classes");
  redirect("/classes");
}
