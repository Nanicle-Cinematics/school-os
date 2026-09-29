-- The double-entry ledger itself: JournalEntry/JournalLine, plus the five
-- core account mappings on SchoolSettings (cash/bank/momo/receivable/
-- payable) the posting engine reads. Nothing yet WRITES a JournalEntry — that
-- is the application-code half of this change, grafted onto the already-live
-- invoice/payment/expense/vendor-bill actions in the same PR, additively and
-- best-effort (a missing account mapping skips a posting, never blocks the
-- money movement it is about).
--
-- ADDITIVE ONLY: two new tables, one new enum, five new nullable columns.
-- Nothing existing is altered, so this deploys BEFORE the merge (see
-- .github/workflows/migrate.yml).

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('INVOICE', 'PAYMENT', 'EXPENSE', 'VENDOR_BILL', 'VENDOR_PAYMENT');

-- AlterTable
ALTER TABLE "SchoolSettings" ADD COLUMN     "bankAccountId" TEXT,
ADD COLUMN     "cashAccountId" TEXT,
ADD COLUMN     "momoAccountId" TEXT,
ADD COLUMN     "payableAccountId" TEXT,
ADD COLUMN     "receivableAccountId" TEXT;

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "entryNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memo" TEXT NOT NULL,
    "sourceType" "JournalSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "postedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalEntry_schoolId_sourceType_sourceId_idx" ON "JournalEntry"("schoolId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_schoolId_entryNo_key" ON "JournalEntry"("schoolId", "entryNo");

-- CreateIndex
CREATE INDEX "JournalLine_schoolId_idx" ON "JournalLine"("schoolId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_momoAccountId_fkey" FOREIGN KEY ("momoAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_receivableAccountId_fkey" FOREIGN KEY ("receivableAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSettings" ADD CONSTRAINT "SchoolSettings_payableAccountId_fkey" FOREIGN KEY ("payableAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_postedByUserId_fkey" FOREIGN KEY ("postedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
