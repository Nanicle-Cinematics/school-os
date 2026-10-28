/**
 * Liveness for the uptime monitor: "is a function answering", nothing more.
 *
 * Deliberately touches no database and imports nothing that does. The monitor
 * calls this every minute, forever — a `SELECT 1` here would keep Postgres from
 * ever going idle, which is exactly how the church app and Beauty OS burned
 * their whole Neon allowance in August 2026. Real users wake the database; a
 * monitor must not.
 *
 * `force-dynamic` so the response comes from a live function rather than a
 * build-time copy on the CDN, which would keep answering 200 while every real
 * route failed.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      app: "school-os",
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
