-- STUDENT was scaffolding that never got built: the enum value, the
-- Membership.studentId pointer and the Student.memberships back-relation were
-- referenced by ZERO lines of application code. Nothing ever granted the role,
-- landingFor() has no branch for it (a STUDENT-only login fell through to the
-- staff dashboard), and there is no student portal. It read as a feature to
-- anyone browsing the schema, which is the only harm it was doing.
--
-- Parents are unaffected — PARENT stays, and the portal is live.
--
-- ⚠️ These two guards must come FIRST, and must RAISE rather than repair.
-- The cast below is ("role"::text::"Role_new"), which throws "invalid input
-- value for enum" on any row still reading STUDENT, and DROP COLUMN discards a
-- populated studentId without a word. There is no value to migrate such a row
-- TO — a STUDENT membership is a login with nowhere to land — so the honest
-- outcome is a refusal that someone has to look at, not a silent rewrite.
-- Dev was verified empty before this was written (0 STUDENT memberships, 0
-- studentId set). Production could NOT be checked from a workstation — its
-- credential lives only as the PROD_DIRECT_URL actions secret — so on prod
-- these guards are the check, which is the reason they are in the file.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "Membership" WHERE "role"::text = 'STUDENT';
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing to drop the STUDENT role: % membership(s) still hold it. Decide what those logins become before running this.', n;
  END IF;

  SELECT count(*) INTO n FROM "Membership" WHERE "studentId" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing to drop Membership.studentId: % row(s) have it set. That link would be discarded silently.', n;
  END IF;
END $$;

-- AlterEnum
-- No DROP DEFAULT here, unlike the Plan migration: Membership.role has no
-- default to cast.
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('OWNER', 'HEAD', 'ASSISTANT_HEAD', 'ADMIN', 'ACCOUNTANT', 'TEACHER', 'LIBRARIAN', 'HOUSE_MASTER', 'NURSE', 'PARENT');
ALTER TABLE "Membership" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "public"."Role_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_studentId_fkey";

-- AlterTable
ALTER TABLE "Membership" DROP COLUMN "studentId";
