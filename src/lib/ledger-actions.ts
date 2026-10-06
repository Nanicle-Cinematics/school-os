"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type AccountType } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { applyDefaultChartOfAccounts } from "@/lib/ledger-defaults";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction, prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export type ActionState = { error?: string; ok?: string };

const ACCOUNT_TYPES: AccountType[] = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];

/** Create or rename a ledger account. The code is derived from the name on create only, same as every other category in this app. */
export async function saveLedgerAccount(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "");

  if (!name) {
    return { error: "Give the account a name." };
  }
  if (name.length > 60) {
    return { error: "That name is too long — keep it under 60 characters." };
  }
  if (!id && !ACCOUNT_TYPES.includes(type as AccountType)) {
    return { error: "Choose an account type." };
  }

  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!code) {
    return { error: "Use at least one letter or number in the name." };
  }

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      if (id) {
        const existing = await tx.ledgerAccount.findUnique({ where: { id } });
        if (!existing) {
          throw new Error("MISSING");
        }
        await tx.ledgerAccount.update({ where: { id }, data: { name } });
        await writeAudit(tx, {
          schoolId: auth.schoolId,
          actorUserId: auth.userId,
          action: "ledgerAccount.update",
          entity: "LedgerAccount",
          entityId: id,
          before: { name: existing.name },
          after: { name },
        });
        return;
      }

      const last = await tx.ledgerAccount.findFirst({
        where: { schoolId: auth.schoolId, type: type as AccountType },
        orderBy: { order: "desc" },
      });
      const created = await tx.ledgerAccount.create({
        data: {
          schoolId: auth.schoolId,
          name,
          code,
          type: type as AccountType,
          order: (last?.order ?? 0) + 1,
        },
      });
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "ledgerAccount.create",
        entity: "LedgerAccount",
        entityId: created.id,
        after: { name, code, type },
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MISSING") {
      return { error: "That account no longer exists." };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already an account called "${name}".` };
    }
    throw error;
  }

  revalidatePath("/chart-of-accounts");
  return { ok: id ? `Renamed to ${name}.` : `${name} added.` };
}

/**
 * Refused once a fee or expense category posts to this account. There is no
 * journal ledger yet (that lands with the posting engine), so today this is
 * the only "in use" a chart of accounts can mean — the check grows to include
 * postings once they exist.
 */
export async function deleteLedgerAccount(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const existing = await tx.ledgerAccount.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            feeCategoriesAsIncome: true,
            expenseCategoriesAsExpense: true,
            children: true,
            journalLines: true,
          },
        },
      },
    });
    if (!existing) {
      return;
    }
    // The core-account settings are plain ids, not a Prisma relation (see the
    // schema comment on SchoolSettings), so checking them is a manual query
    // rather than a _count include.
    const settingsUsing = await tx.schoolSettings.count({
      where: {
        schoolId: auth.schoolId,
        OR: [
          { cashAccountId: id },
          { bankAccountId: id },
          { momoAccountId: id },
          { receivableAccountId: id },
          { payableAccountId: id },
        ],
      },
    });
    // Once postings exist, this is the real "in use" — a category or a core
    // account setting is refused for the same reason a fee item already
    // billed is: deleting the account must never silently break the school's
    // own live posting, or the postings already made.
    const inUse =
      existing._count.feeCategoriesAsIncome > 0 ||
      existing._count.expenseCategoriesAsExpense > 0 ||
      existing._count.children > 0 ||
      existing._count.journalLines > 0 ||
      settingsUsing > 0;
    if (inUse) {
      return;
    }
    await tx.ledgerAccount.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "ledgerAccount.delete",
      entity: "LedgerAccount",
      entityId: id,
      before: { name: existing.name, code: existing.code },
    });
  });

  revalidatePath("/chart-of-accounts");
}

/** Offered when the list is empty or partial, mirroring `applyDefaultBillCodesAction`. */
export async function applyDefaultChartOfAccountsAction(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: ActionState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const result = await tenantTransaction(auth.schoolId, (tx) =>
    applyDefaultChartOfAccounts(tx, auth.schoolId),
  );

  revalidatePath("/chart-of-accounts");

  if (result.accountsCreated === 0 && result.linksSet === 0) {
    return { ok: "Nothing to add — the standard accounts are already here and linked." };
  }
  return {
    ok: `Added ${result.accountsCreated} account${result.accountsCreated === 1 ? "" : "s"}${
      result.linksSet > 0 ? `, linked ${result.linksSet} fee/expense item${result.linksSet === 1 ? "" : "s"}` : ""
    }.`,
  };
}

/** Point one fee category at the income account it posts to, or clear it. */
export async function setFeeCategoryAccount(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);
  const feeCategoryId = String(formData.get("feeCategoryId") ?? "");
  const incomeAccountId = String(formData.get("incomeAccountId") ?? "") || null;
  if (!feeCategoryId) {
    return;
  }
  await prisma.feeCategory.update({ where: { id: feeCategoryId }, data: { incomeAccountId } });
  revalidatePath("/chart-of-accounts");
}

/** Point one expense category at the expense account it posts to, or clear it. */
export async function setExpenseCategoryAccount(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);
  const expenseCategoryId = String(formData.get("expenseCategoryId") ?? "");
  const expenseAccountId = String(formData.get("expenseAccountId") ?? "") || null;
  if (!expenseCategoryId) {
    return;
  }
  await prisma.expenseCategory.update({
    where: { id: expenseCategoryId },
    data: { expenseAccountId },
  });
  revalidatePath("/chart-of-accounts");
}

/**
 * The school's own core accounts — where the posting engine looks up which
 * account to debit/credit for a cash movement. All five optional: a school
 * that clears one simply stops posting the entries that need it, exactly
 * like leaving a fee item unmapped.
 */
export async function saveCoreAccounts(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const field = (key: string) => String(formData.get(key) ?? "") || null;

  await prisma.schoolSettings.upsert({
    where: { schoolId: auth.schoolId },
    create: {
      schoolId: auth.schoolId,
      cashAccountId: field("cashAccountId"),
      bankAccountId: field("bankAccountId"),
      momoAccountId: field("momoAccountId"),
      receivableAccountId: field("receivableAccountId"),
      payableAccountId: field("payableAccountId"),
    },
    update: {
      cashAccountId: field("cashAccountId"),
      bankAccountId: field("bankAccountId"),
      momoAccountId: field("momoAccountId"),
      receivableAccountId: field("receivableAccountId"),
      payableAccountId: field("payableAccountId"),
    },
  });

  revalidatePath("/chart-of-accounts");
  return { ok: "Default postings saved." };
}
