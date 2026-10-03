-- Two-factor sign-in for the platform admin (authenticator-app codes).
--
-- ADDITIVE: nullable columns, and a list column that defaults to empty. Old code
-- ignores all of them, so this migrates BEFORE the merge. Nobody is enrolled by the
-- migration itself — a platform admin is walked through enrolment on their next
-- visit to the console.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "recoveryCodeHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpLastStep" INTEGER,
ADD COLUMN     "totpSecretEnc" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "mfaVerifiedAt" TIMESTAMP(3);
