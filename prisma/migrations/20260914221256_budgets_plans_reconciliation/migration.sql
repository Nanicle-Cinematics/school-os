-- Budgets, payment plans and bank reconciliation.
--
-- Three additions, all of them tables the finance section had no way to express:
--
--   Budget                 what a school INTENDS to spend on a heading this
--                          term, against which the cash book is the actual.
--                          Per TERM, because a Ghanaian school's money arrives
--                          in the first weeks of each one and is spent within
--                          it — a yearly figure compared against a third of a
--                          year reads as a surplus that is not there.
--
--   PaymentPlan            an agreed arrangement to pay one bill in tranches,
--   PaymentPlanInstalment  attached to the INVOICE because that is already per
--                          student per term, which is the unit a school
--                          negotiates over. ⚠️ A plan does NOT change what is
--                          owed; Invoice.balance stays the truth. It says when
--                          the school agreed the money would arrive, which is
--                          what stops a parent keeping to an arrangement being
--                          chased as a debtor.
--
--   StatementLine          a line read off a bank or momo statement. Kept
--                          rather than matched-and-forgotten, because the
--                          useful half of a reconciliation is the lines that did
--                          NOT match — money in the account the book has no
--                          record of.
--
-- ⚠️ FOUR new tenant tables, all carrying schoolId. `action=rls` must be run
-- against production after this deploys, or they arrive with no row security —
-- which is what AssessmentTemplate and SchoolAsset both did.
--
-- ADDING only, so this migrates BEFORE the merge.
-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "setByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlan" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "agreedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlanInstalment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentPlanInstalment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementLine" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "narration" TEXT,
    "paymentId" TEXT,
    "importedByUserId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_schoolId_idx" ON "Budget"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_termId_categoryId_key" ON "Budget"("termId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_invoiceId_key" ON "PaymentPlan"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentPlan_schoolId_idx" ON "PaymentPlan"("schoolId");

-- CreateIndex
CREATE INDEX "PaymentPlanInstalment_schoolId_idx" ON "PaymentPlanInstalment"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlanInstalment_planId_sequence_key" ON "PaymentPlanInstalment"("planId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "StatementLine_paymentId_key" ON "StatementLine"("paymentId");

-- CreateIndex
CREATE INDEX "StatementLine_schoolId_idx" ON "StatementLine"("schoolId");

-- CreateIndex
CREATE INDEX "StatementLine_schoolId_paidAt_idx" ON "StatementLine"("schoolId", "paidAt");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_setByUserId_fkey" FOREIGN KEY ("setByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_agreedByUserId_fkey" FOREIGN KEY ("agreedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanInstalment" ADD CONSTRAINT "PaymentPlanInstalment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlanInstalment" ADD CONSTRAINT "PaymentPlanInstalment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PaymentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementLine" ADD CONSTRAINT "StatementLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

