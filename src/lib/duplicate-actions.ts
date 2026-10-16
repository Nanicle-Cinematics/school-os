"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { MERGE_PUPILS } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { ownsStudents } from "@/lib/ownership";
import { mergeStudents } from "@/lib/student-merge";

/**
 * Merge one pupil record into another: leadership and the IT admin, because it moves a child's money and marks.
 * Every refusal is a redirect back to the screen with the reason; nothing is changed unless the merge returns ok.
 */
export async function mergeDuplicate(formData: FormData): Promise<void> {
  const auth = await requireRole(MERGE_PUPILS);
  setTenantContext(auth.tenant);

  const a = String(formData.get("a") ?? "");
  const b = String(formData.get("b") ?? "");
  const keepId = String(formData.get("keep") ?? "");
  const back = (error: string): never => redirect(`/students/duplicates?error=${encodeURIComponent(error)}`);

  if (!a || !b || a === b || (keepId !== a && keepId !== b)) {
    return back("Choose which of the two records to keep.");
  }
  if (formData.get("confirm") !== "yes") {
    return back("Tick the box to confirm. A merge cannot be undone from the screen.");
  }
  // An id from a form is read back through the tenant client before it is acted on.
  if (!(await ownsStudents([a, b]))) {
    return back("One of those records was not found in this school.");
  }
  const removeId = keepId === a ? b : a;

  const result = await tenantTransaction(auth.schoolId, (tx) =>
    mergeStudents(tx, { schoolId: auth.schoolId, actorUserId: auth.userId, keepId, removeId }),
  );
  if (!result.ok) {
    const detail = result.conflicts.map((c) => `${c.table} (${c.count}: ${c.why})`).join("; ");
    return back(detail ? `${result.error} ${detail}.` : result.error);
  }

  revalidatePath("/students");
  revalidatePath("/students/duplicates");
  revalidatePath("/dashboard");
  const movedCount = Object.values(result.moved).reduce((n, v) => n + v, 0);
  redirect(`/students/duplicates?merged=${encodeURIComponent(`${movedCount} records moved onto the one you kept.`)}`);
}
