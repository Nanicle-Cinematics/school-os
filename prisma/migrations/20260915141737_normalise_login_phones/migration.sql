-- Store login phone numbers in one shape, so a staff member can type theirs the
-- way they know it.
--
-- createUserAccount validated with normalisePhone and then saved the RAW string,
-- while createGuardianLogin and the bulk portal invite both saved the normalised
-- one. Sign-in tries the typed identifier and its normalised form — which
-- rescues a stored normalised number from any input format, and cannot rescue a
-- stored raw one. So a staff member had to reproduce the office's exact
-- formatting: "024 412 3456" typed into the create-login box meant "0244123456"
-- at the login screen was refused, with the same message as a wrong password.
--
-- This backfills the rows that already exist. It only ever WIDENS access: once a
-- number is stored normalised every input format resolves to it, so nobody who
-- can sign in today loses the ability.
--
-- ⚠️ It REFUSES rather than repairs when two rows would normalise to the same
-- number. User.phone is globally unique, and "0244123456" and "233244123456"
-- are different strings — so the same person may already hold two accounts, one
-- staff and one guardian, without ever tripping the constraint. Merging those is
-- a decision about whose account survives, and nothing here should make it
-- silently.
--
-- Rows whose number cannot be normalised at all are left exactly as they are:
-- they sign in the way they do today.
DO $$
DECLARE
  clash text;
BEGIN
  -- The same rules as normalisePhone in sms-shared.ts. Kept here rather than
  -- called out to, because a migration must mean the same thing when it is
  -- replayed on an empty database years from now.
  CREATE TEMP TABLE _phone_fix ON COMMIT DROP AS
  SELECT
    u.id,
    u.phone AS current,
    CASE
      WHEN d.digits ~ '^233[0-9]{9}$'   THEN d.digits
      WHEN d.digits ~ '^0[0-9]{9}$'     THEN '233' || substr(d.digits, 2)
      WHEN d.digits ~ '^[1-9][0-9]{8}$' THEN '233' || d.digits
      ELSE NULL
    END AS normalised
  FROM "User" u
  CROSS JOIN LATERAL (
    SELECT regexp_replace(regexp_replace(u.phone, '^\+', ''), '[^0-9]', '', 'g') AS digits
  ) d
  WHERE u.phone IS NOT NULL;

  DELETE FROM _phone_fix WHERE normalised IS NULL OR normalised = current;

  -- Would any update land on a number another row already holds?
  SELECT string_agg(format('%s -> %s', f.current, f.normalised), ', ')
    INTO clash
  FROM _phone_fix f
  WHERE EXISTS (
    SELECT 1 FROM "User" other
    WHERE other.phone = f.normalised AND other.id <> f.id
  )
     OR EXISTS (
    SELECT 1 FROM _phone_fix g
    WHERE g.normalised = f.normalised AND g.id <> f.id
  );

  IF clash IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to normalise: % would collide with a number another account already holds. Decide which account keeps it before running this.', clash;
  END IF;

  UPDATE "User" u
     SET phone = f.normalised
    FROM _phone_fix f
   WHERE u.id = f.id;

  RAISE NOTICE 'normalised % login phone number(s)', (SELECT count(*) FROM _phone_fix);
END $$;
