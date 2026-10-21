-- A guardian deleted before the fix was only marked deleted: the links to their children and their portal login
-- stayed, so the child's page, the bills, the receipts and the SMS audience went on showing and texting them. Deleting
-- now removes all that (removeGuardian); this does the same for the guardians already deleted. Data only, no schema
-- change, and safe to run twice. Run it AFTER the code that stops new strays is deployed.

-- Sessions BEFORE memberships: the Session policy shows a school the sessions of its own members, so once the
-- membership is gone a session with no school chosen would no longer be visible and would survive. Only the sessions of
-- logins that belong to nothing else (a login that is also staff, or another guardian, keeps its sessions).
DELETE FROM "Session"
WHERE "userId" IN (
  SELECT m."userId" FROM "Membership" m JOIN "Guardian" g ON g."id" = m."guardianId" WHERE g."deletedAt" IS NOT NULL
)
AND "userId" NOT IN (
  SELECT m."userId" FROM "Membership" m LEFT JOIN "Guardian" g ON g."id" = m."guardianId" WHERE g."deletedAt" IS NULL
);

DELETE FROM "Membership"
WHERE "guardianId" IN (SELECT "id" FROM "Guardian" WHERE "deletedAt" IS NOT NULL);

-- A child whose primary contact was a deleted guardian, and who has another, gets the oldest remaining one as primary.
-- Before the links go, while the deleted ones can still be found.
UPDATE "StudentGuardian" SET "isPrimary" = true
WHERE "id" IN (
  SELECT DISTINCT ON (sg."studentId") sg."id"
  FROM "StudentGuardian" sg
  JOIN "Guardian" g ON g."id" = sg."guardianId" AND g."deletedAt" IS NULL
  WHERE sg."studentId" IN (
    SELECT d."studentId" FROM "StudentGuardian" d JOIN "Guardian" dg ON dg."id" = d."guardianId"
    WHERE dg."deletedAt" IS NOT NULL AND d."isPrimary"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "StudentGuardian" p JOIN "Guardian" pg ON pg."id" = p."guardianId"
    WHERE p."studentId" = sg."studentId" AND p."isPrimary" AND pg."deletedAt" IS NULL
  )
  ORDER BY sg."studentId", sg."createdAt", sg."id"
);

DELETE FROM "StudentGuardian"
WHERE "guardianId" IN (SELECT "id" FROM "Guardian" WHERE "deletedAt" IS NOT NULL);
