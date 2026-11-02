-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "PayItemKind" AS ENUM ('ALLOWANCE', 'DEDUCTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSourceType" ADD VALUE 'PAYROLL';
ALTER TYPE "JournalSourceType" ADD VALUE 'PAYROLL_PAYMENT';

-- AlterTable
ALTER TABLE "SchoolSettings" ADD COLUMN     "payrollAdvancesAccountId" TEXT,
ADD COLUMN     "payrollNetPayAccountId" TEXT,
ADD COLUMN     "payrollPayeAccountId" TEXT,
ADD COLUMN     "payrollSalaryAccountId" TEXT,
ADD COLUMN     "payrollSsnitAccountId" TEXT;

-- CreateTable
CREATE TABLE "PayrollRateSet" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "ssnitEmployeePercent" DECIMAL(5,2) NOT NULL,
    "ssnitEmployerPercent" DECIMAL(5,2) NOT NULL,
    "ssnitTier2Percent" DECIMAL(5,2) NOT NULL,
    "ssnitMaxInsurable" DECIMAL(12,2) NOT NULL,
    "taxBands" JSONB NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRateSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPay" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "basicSalary" DECIMAL(12,2) NOT NULL,
    "ssnitApplies" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffPay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPayItem" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "kind" "PayItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "principal" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffPayItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "rateSetId" TEXT NOT NULL,
    "note" TEXT,
    "approvedAt" TIMESTAMP(3),
    "paidOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffNo" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "ssnitNumber" TEXT,
    "tin" TEXT,
    "basic" DECIMAL(12,2) NOT NULL,
    "allowances" DECIMAL(12,2) NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "ssnitBase" DECIMAL(12,2) NOT NULL,
    "ssnitEmployee" DECIMAL(12,2) NOT NULL,
    "ssnitEmployer" DECIMAL(12,2) NOT NULL,
    "ssnitTier2" DECIMAL(12,2) NOT NULL,
    "taxableIncome" DECIMAL(12,2) NOT NULL,
    "chargeable" DECIMAL(12,2) NOT NULL,
    "paye" DECIMAL(12,2) NOT NULL,
    "deductions" DECIMAL(12,2) NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "warnings" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayslipLine" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "payItemId" TEXT,
    "kind" "PayItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PayslipLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollRateSet_schoolId_idx" ON "PayrollRateSet"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRateSet_schoolId_effectiveFrom_key" ON "PayrollRateSet"("schoolId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPay_staffId_key" ON "StaffPay"("staffId");

-- CreateIndex
CREATE INDEX "StaffPay_schoolId_idx" ON "StaffPay"("schoolId");

-- CreateIndex
CREATE INDEX "StaffPayItem_schoolId_staffId_idx" ON "StaffPayItem"("schoolId", "staffId");

-- CreateIndex
CREATE INDEX "PayrollRun_schoolId_idx" ON "PayrollRun"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_schoolId_periodYear_periodMonth_key" ON "PayrollRun"("schoolId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "Payslip_schoolId_idx" ON "Payslip"("schoolId");

-- CreateIndex
CREATE INDEX "Payslip_staffId_idx" ON "Payslip"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_runId_staffId_key" ON "Payslip"("runId", "staffId");

-- CreateIndex
CREATE INDEX "PayslipLine_schoolId_idx" ON "PayslipLine"("schoolId");

-- CreateIndex
CREATE INDEX "PayslipLine_payItemId_idx" ON "PayslipLine"("payItemId");

-- CreateIndex
CREATE INDEX "PayslipLine_payslipId_idx" ON "PayslipLine"("payslipId");

-- AddForeignKey
ALTER TABLE "PayrollRateSet" ADD CONSTRAINT "PayrollRateSet_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPay" ADD CONSTRAINT "StaffPay_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPay" ADD CONSTRAINT "StaffPay_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPayItem" ADD CONSTRAINT "StaffPayItem_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPayItem" ADD CONSTRAINT "StaffPayItem_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_rateSetId_fkey" FOREIGN KEY ("rateSetId") REFERENCES "PayrollRateSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_payItemId_fkey" FOREIGN KEY ("payItemId") REFERENCES "StaffPayItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
