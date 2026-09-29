-- A real chart of accounts: LedgerAccount rows classified by AccountType, plus
-- optional links from FeeCategory/ExpenseCategory to the account each posts
-- to. Nothing posts to these accounts yet — that is a later, isolated change
-- grafted onto already-live invoice/payment/expense code once these accounts
-- exist to post to.
--
-- ADDITIVE ONLY: one new table, one new enum, two new nullable columns.
-- Nothing existing is altered, so this deploys BEFORE the merge (see
-- .github/workflows/migrate.yml).

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- AlterTable
ALTER TABLE "ExpenseCategory" ADD COLUMN     "expenseAccountId" TEXT;

-- AlterTable
ALTER TABLE "FeeCategory" ADD COLUMN     "incomeAccountId" TEXT;

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerAccount_schoolId_type_idx" ON "LedgerAccount"("schoolId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_schoolId_code_key" ON "LedgerAccount"("schoolId", "code");

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCategory" ADD CONSTRAINT "FeeCategory_incomeAccountId_fkey" FOREIGN KEY ("incomeAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
