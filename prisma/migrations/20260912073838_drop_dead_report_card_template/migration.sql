-- Drop `reportCardTemplate`, which never chose anything.
--
-- The settings form offered "GES standard" and "Compact"; only one layout has
-- ever existed, so the column recorded an answer no code read. Dropping data is
-- normally worth an argument — here the two non-null values are both the
-- default string, and nothing can consult them.

-- AlterTable
ALTER TABLE "SchoolSettings" DROP COLUMN "reportCardTemplate";

