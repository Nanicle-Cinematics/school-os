-- A registry of bill TYPES (Term Fees Bill, PTA Bill, Trip Bill), distinct from
-- FeeCategory, which is a line item within a bill. Invoice.billCodeId is
-- nullable and SetNull, matching FeeCategory/ExpenseCategory: deleting a bill
-- code must never delete or orphan a real invoice.
--
-- ADDITIVE ONLY: one new table, one new nullable column. Nothing existing is
-- altered, so this deploys BEFORE the merge (see .github/workflows/migrate.yml).

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "billCodeId" TEXT;

-- CreateTable
CREATE TABLE "BillCode" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillCode_schoolId_idx" ON "BillCode"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "BillCode_schoolId_code_key" ON "BillCode"("schoolId", "code");

-- AddForeignKey
ALTER TABLE "BillCode" ADD CONSTRAINT "BillCode_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_billCodeId_fkey" FOREIGN KEY ("billCodeId") REFERENCES "BillCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
