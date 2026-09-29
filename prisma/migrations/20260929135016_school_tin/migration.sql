-- The school's own Ghana Revenue Authority Tax Identification Number, printed
-- on invoices and receipts alongside the existing GES/Ministry accreditation
-- number.
--
-- ADDITIVE ONLY: one new nullable column. Nothing existing is altered, so this
-- deploys BEFORE the merge (see .github/workflows/migrate.yml).

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "tin" TEXT;
