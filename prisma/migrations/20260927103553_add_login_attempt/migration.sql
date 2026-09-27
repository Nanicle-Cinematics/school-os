-- Brute-force lockout for the login form, keyed by the identifier typed at
-- the form rather than by userId — so a made-up email locks out exactly the
-- same way a real one does, and the anti-enumeration guarantee in
-- src/lib/auth-actions.ts is not undone by a side channel here.
--
-- ADDITIVE ONLY: one new table, nothing existing touched.
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoginAttempt_identifier_key" ON "LoginAttempt"("identifier");
