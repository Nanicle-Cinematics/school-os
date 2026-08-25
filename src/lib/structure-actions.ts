"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Stage } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export type StructureState = { error?: string; ok?: string };

const STAGE_VALUES: Stage[] = [
  "CRECHE",
  "NURSERY",
  "KINDERGARTEN",
  "PRIMARY",
  "JHS",
  "SHS",
];

function duplicate(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function refresh() {
  revalidatePath("/settings/structure");
  revalidatePath("/settings");
  revalidatePath("/classes");
}

export async function saveLevel(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const stage = String(formData.get("stage") ?? "") as Stage;
  const orderRaw = Number(formData.get("order"));

  if (!name) {
    return { error: "Give the level a name, e.g. Basic 5." };
  }
  if (!code) {
    return { error: "Give the level a short code — it heads report-card columns." };
  }
  if (!STAGE_VALUES.includes(stage)) {
    return { error: "Pick the stage this level belongs to." };
  }
  // Order is what sorts every class list, broadsheet and fee table. Two levels
  // sharing a number is not an error, but a missing one sorts to the top and
  // makes KG appear above SHS.
  if (!Number.isFinite(orderRaw)) {
    return { error: "Order must be a number — it sorts the whole ladder, KG1 first." };
  }

  const data = { name, code, stage, order: Math.trunc(orderRaw) };

  try {
    if (id) {
      await prisma.level.update({ where: { id }, data });
      refresh();
      return { ok: `Saved ${name}.` };
    }
    await prisma.level.create({ data: { schoolId: auth.schoolId, ...data } });
    refresh();
    return { ok: `Added ${name}.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `Another level already uses the code ${code}.` };
    }
    throw error;
  }
}

export async function deleteLevel(formData: FormData): Promise<void> {
  await requireRole(OFFICE);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // ClassGroup, LevelSubject and FeeStructure all cascade from Level, so a
  // delete here would silently take a school's classes and fee tables with it.
  const classes = await prisma.classGroup.count({ where: { levelId: id } });
  const fees = await prisma.feeStructure.count({ where: { levelId: id } });
  if (classes > 0 || fees > 0) {
    return;
  }

  await prisma.level.delete({ where: { id } });
  refresh();
}

export async function saveHouse(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim();

  if (!name) {
    return { error: "Give the house a name." };
  }

  const data = { name, color: color || null };

  try {
    if (id) {
      await prisma.house.update({ where: { id }, data });
    } else {
      await prisma.house.create({ data: { schoolId: auth.schoolId, ...data } });
    }
    refresh();
    return { ok: `Saved ${name}.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `There is already a house called ${name}.` };
    }
    throw error;
  }
}

export async function deleteHouse(formData: FormData): Promise<void> {
  await requireRole(OFFICE);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // Student.houseId is SetNull, so this is safe — but silently un-housing a
  // hundred children is still a surprise, so it only goes through when empty.
  const students = await prisma.student.count({ where: { houseId: id } });
  if (students > 0) {
    return;
  }

  await prisma.house.delete({ where: { id } });
  refresh();
}

export async function saveProgramme(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim().toUpperCase();

  if (!name) {
    return { error: "Give the programme a name, e.g. General Science." };
  }
  if (!code) {
    return { error: "Give the programme a short code." };
  }

  const data = { name, code };

  try {
    if (id) {
      await prisma.programme.update({ where: { id }, data });
    } else {
      await prisma.programme.create({ data: { schoolId: auth.schoolId, ...data } });
    }
    refresh();
    return { ok: `Saved ${name}.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `Another programme already uses the code ${code}.` };
    }
    throw error;
  }
}

export async function deleteProgramme(formData: FormData): Promise<void> {
  await requireRole(OFFICE);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  const students = await prisma.student.count({ where: { programmeId: id } });
  if (students > 0) {
    return;
  }

  await prisma.programme.delete({ where: { id } });
  refresh();
}
