-- A deleted pupil used to keep their class and their ACTIVE enrolment: delete set
-- "deletedAt" and nothing else. Registers, mark sheets, results and promotions read
-- the roll from enrolments, so a duplicate deleted from /students went on appearing
-- in its class, was ranked on the broadsheet with no marks, and could no longer be
-- opened to withdraw it. deleteStudent now ends the enrolment itself; this puts
-- right the pupils deleted before it did.
--
-- DATA ONLY, no schema change. Safe on either side of the merge: the old code
-- never reads a deleted pupil's enrolment on purpose, and the new code writes
-- exactly these values. Idempotent — a second run matches nothing.
UPDATE "Enrollment" AS e
   SET "status" = 'WITHDRAWN', "updatedAt" = now()
  FROM "Student" AS s
 WHERE e."studentId" = s."id"
   AND s."deletedAt" IS NOT NULL
   AND e."status" = 'ACTIVE';

UPDATE "Student"
   SET "currentClassGroupId" = NULL, "updatedAt" = now()
 WHERE "deletedAt" IS NOT NULL
   AND "currentClassGroupId" IS NOT NULL;
