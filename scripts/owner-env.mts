/**
 * Import this FIRST in any script that runs against production with `--env-file=.env.prod`.
 *
 * ⚠️ `.env.prod` deliberately has no APP_DATABASE_URL (Vercel supplies that one). Constructing a
 * PrismaClient loads the project's plain `.env` into `process.env` for every variable not already set,
 * so the gap was filled with DEV's restricted-role URL. `src/lib/prisma.ts` then refused to start
 * because the two URLs named different Supabase projects: `npm run platform:prod` could not create a
 * platform admin without the caller overriding the variable by hand. (Without that refusal, `??`
 * would have picked the dev value and a "production" run would have read dev's database.)
 *
 * These scripts are the owner's, and must not be tenant-scoped, so the app URL is simply the owner
 * URL. Set before anything constructs a client, and only when it is missing: a caller that sets
 * APP_DATABASE_URL on purpose is left alone, and prisma.ts still checks the two agree.
 */
if (process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL = process.env.DATABASE_URL;
}
