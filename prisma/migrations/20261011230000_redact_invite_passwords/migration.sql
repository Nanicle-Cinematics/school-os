-- Guardian invites logged the whole SMS text, temporary password included, in "Message"."body"
-- from the day they shipped (2026-09-09). The text has had exactly one wording since then:
--
--   <school>: your parent portal is ready. Sign in at <url> with <phone> and password <password>.
--   You will be asked to choose your own password.
--
-- so one pattern finds every such row. The password is the one token between "and password "
-- and the ". You will be asked" that follows it; \S+ cannot span a space, so nothing else in
-- the message is touched. New invites store the same sentence with "(not stored)" in that place
-- (inviteMessages in src/lib/portal-invite-data.ts), and this makes the old rows match.
--
-- Data only, no schema change, safe to run before or after the code that stops writing them.
-- Idempotent: "(not stored)" contains a space, so the pattern no longer matches a redacted row.
-- Rows that do not look like an invite are not touched, whatever their body says.
UPDATE "Message"
SET "body" = regexp_replace(
  "body",
  'and password \S+\. You will be asked to choose your own password\.',
  'and password (not stored). You will be asked to choose your own password.'
)
WHERE "body" LIKE '%your parent portal is ready.%'
  AND "body" LIKE '%and password %. You will be asked to choose your own password.%'
  AND "body" NOT LIKE '%and password (not stored). You will be asked%';
