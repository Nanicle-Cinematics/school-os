-- A term is marked out of something, and the year decides who moves up.
--
-- Until now a TermResult carried totalMarks with no denominator: 624 meant
-- nothing without knowing how many subjects the class sat. The report card
-- printed the numerator alone and a parent had to be told the rest. These three
-- columns freeze the denominator at compute time — a level's subject list gets
-- edited, and a card reprinted next year must still read the 900 the child was
-- actually marked against.
--
-- Nullable with no backfill, deliberately: existing rows were computed under
-- the old "sum whatever was assessed" rule, and inventing a denominator for
-- them would assert something nobody measured. They read "—" until recomputed.
ALTER TABLE "TermResult" ADD COLUMN "subjectsOffered" INTEGER;
ALTER TABLE "TermResult" ADD COLUMN "possibleMarks" INTEGER;
ALTER TABLE "TermResult" ADD COLUMN "percentage" DECIMAL(5,2);

-- The pass mark for the year. NOT NULL with a default, because every school
-- has one whether or not it has ever said so out loud, and a null here would
-- make the promotion rule silently skip the schools that never visited
-- Settings. 45 is GES practice.
ALTER TABLE "SchoolSettings" ADD COLUMN "promotionPassPercent" INTEGER NOT NULL DEFAULT 45;
