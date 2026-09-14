-- One paid plan. Standard and Institution Plus were identical apart from
-- GH₵300, so Standard is gone and anyone on it moves across at no charge.
--
-- ⚠️ This UPDATE is not optional and must come FIRST. The cast below is
-- ("plan"::text::"Plan_new"), which throws "invalid input value for enum" on
-- any row still reading STANDARD — so without this line the migration fails
-- on exactly the databases that have customers on that plan.
--
-- Moving them UP rather than down: a school is not charged more (monthlyFee is
-- a separate column and is untouched), and nothing about the product changes,
-- because the two plans never did anything different.
UPDATE "School" SET "plan" = 'INSTITUTION_PLUS' WHERE "plan"::text = 'STANDARD';

-- AlterEnum
BEGIN;
CREATE TYPE "Plan_new" AS ENUM ('TRIAL', 'INSTITUTION_PLUS');
ALTER TABLE "public"."School" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "School" ALTER COLUMN "plan" TYPE "Plan_new" USING ("plan"::text::"Plan_new");
ALTER TYPE "Plan" RENAME TO "Plan_old";
ALTER TYPE "Plan_new" RENAME TO "Plan";
DROP TYPE "public"."Plan_old";
ALTER TABLE "School" ALTER COLUMN "plan" SET DEFAULT 'TRIAL';
COMMIT;

