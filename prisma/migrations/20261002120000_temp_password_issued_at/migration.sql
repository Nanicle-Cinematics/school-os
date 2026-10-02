-- A temporary password (the one the office reads down the phone, or texts in an
-- invite) used to stay valid for ever until first use. This records when it was
-- issued so sign-in can refuse one that has gone stale.
--
-- ADDITIVE: a nullable column. Old code ignores it, so it migrates BEFORE the
-- merge. Every temporary password already outstanding gets a fresh clock from
-- now rather than being refused the moment this ships.
ALTER TABLE "User" ADD COLUMN "passwordIssuedAt" TIMESTAMP(3);

UPDATE "User" SET "passwordIssuedAt" = now() WHERE "mustChangePassword" = true;
