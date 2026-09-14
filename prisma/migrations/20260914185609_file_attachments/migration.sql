-- Photographed bank slips and expense receipts.
--
-- bankSlipUrl and receiptUrl have been columns since the beginning and were
-- never written by anything — the schema comment on Expense.receiptUrl says
-- "how bursars actually file these", which was a plan, not a feature. This is
-- the table they point into.
--
-- Bytes in a row, like SchoolAsset, because there is no object store configured
-- and a school's whole term of receipts is a few megabytes. Its own table
-- rather than reusing SchoolAsset because that one is @@unique([schoolId,
-- kind]) — one crest per school — and these are one per voucher, unbounded.
--
-- ⚠️ A new tenant table, so `npm run db:rls` MUST be re-run against every
-- database after this deploys, production included. It carries schoolId, so
-- verify:isolation fails until it is protected — but only in a run that did not
-- just apply the policies, which is why the prod-rls job exists.
--
-- ADDING, so this migrates BEFORE the merge.
-- CreateTable
CREATE TABLE "FileAttachment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileAttachment_schoolId_idx" ON "FileAttachment"("schoolId");

-- AddForeignKey
ALTER TABLE "FileAttachment" ADD CONSTRAINT "FileAttachment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

