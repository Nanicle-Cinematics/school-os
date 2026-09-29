/**
 * Shared with platform-backup-actions.ts, in its own file rather than
 * exported from there: a "use server" file may only export async
 * functions — a plain string constant exported alongside them builds fine
 * but 500s the first time the route actually loads, which is exactly what
 * happened here. Next validates this at runtime, not at build time, so
 * `next build` and CI both stayed green while production 500'd.
 */
export const SCHOOL_BACKUP_RUNS_URL =
  "https://github.com/Nanicle-Cinematics/school-os/actions/workflows/school-backup.yml";
