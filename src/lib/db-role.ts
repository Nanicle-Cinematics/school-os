/**
 * Does the database role this app connects as actually obey row security?
 *
 * ⚠️ Everything in scripts/apply-rls.mjs depends on one fact that nothing used to
 * ask about: that the connection is NOT the owner. Postgres skips every policy
 * for a superuser and for any role with BYPASSRLS, and `postgres` is both. So if
 * APP_DATABASE_URL were ever pasted as the owner's string, all 58 policies would
 * become decoration while the site booted, every test passed and every page
 * rendered. The production guard in prisma.ts only checked that the variable was
 * SET; the daily audit connects as the owner and reads the catalogue; the
 * isolation suite checked the variable was set too. Nobody asked Postgres what
 * the connected role could do.
 *
 * This file is the question and the verdict, kept free of Prisma and of
 * `server-only` so a verify script can run the verdict against a real owner
 * connection and prove it is flagged (see verify-isolation.mts).
 */

/** One row: who we are, and whether Postgres will skip policies for us. */
export const ROLE_ATTRIBUTES_SQL = `
  select current_user::text as name, r.rolsuper, r.rolbypassrls
    from pg_roles r
   where r.rolname = current_user
`;

export type RoleAttributes = {
  name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

/** Why this role cannot be trusted with tenant isolation, or null when it can. */
export function roleProblem(row: RoleAttributes | undefined): string | null {
  if (!row) {
    return (
      "Postgres did not report the connected role, so whether row security applies to it is unknown."
    );
  }
  const reasons = [row.rolsuper && "SUPERUSER", row.rolbypassrls && "BYPASSRLS"].filter(Boolean);
  if (reasons.length === 0) {
    return null;
  }
  return (
    `The app is connected as "${row.name}", which has ${reasons.join(" and ")}. ` +
    `Postgres skips every row-level security policy for such a role, so no school is ` +
    `isolated from any other. APP_DATABASE_URL must name the restricted role that ` +
    `scripts/apply-rls.mjs creates, not the owner.`
  );
}
