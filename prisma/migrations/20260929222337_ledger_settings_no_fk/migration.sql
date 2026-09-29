-- The five core-account columns stay; only the foreign keys go. They are
-- plain ids now, matching SchoolSettings.defaultGradingScaleId's existing
-- convention for a "soft" cross-reference the reading code resolves itself —
-- a declared Prisma relation here sat unread by name (code reaches these
-- only as `…Id`) and verify:settings correctly caught it as a dead field
-- before this shipped. See the schema comment on SchoolSettings.
--
-- ADDITIVE in effect: no column is dropped, so old and new code both keep
-- working against either shape. Safe on either side of the merge.

-- DropForeignKey
ALTER TABLE "SchoolSettings" DROP CONSTRAINT "SchoolSettings_bankAccountId_fkey";

-- DropForeignKey
ALTER TABLE "SchoolSettings" DROP CONSTRAINT "SchoolSettings_cashAccountId_fkey";

-- DropForeignKey
ALTER TABLE "SchoolSettings" DROP CONSTRAINT "SchoolSettings_momoAccountId_fkey";

-- DropForeignKey
ALTER TABLE "SchoolSettings" DROP CONSTRAINT "SchoolSettings_payableAccountId_fkey";

-- DropForeignKey
ALTER TABLE "SchoolSettings" DROP CONSTRAINT "SchoolSettings_receivableAccountId_fkey";
