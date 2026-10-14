-- A platform admin could attach their first authenticator with the password alone. Whoever held the
-- password first (it is printed to a terminal when the account is made) could enrol an authenticator
-- of their own, which opens the console and locks the real admin out. Closing that needs something
-- the password does not carry: a one-time enrolment code, issued out of band by the person with
-- database access and required before the setup page will show a secret.
--
-- ADDITIVE: three nullable columns. Old code ignores them, so this migrates BEFORE the merge.
-- Nothing changes for an admin who is already enrolled, and no row needs a backfill: a null code
-- means "none issued", which the new code treats as closed, not open.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "enrolmentCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "enrolmentCodeHash" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "enrolmentVerifiedAt" TIMESTAMP(3);
