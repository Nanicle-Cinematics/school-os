import type { Metadata } from "next";
import { OfflineRegisterApp } from "./offline-register-app";

export const metadata: Metadata = {
  title: "Attendance (offline) · School OS",
  robots: { index: false },
};

/**
 * The register, for a phone with no signal.
 *
 * ⚠️ Deliberately OUTSIDE both (app) and (portal), and it reads NOTHING about
 * the school or the person: no session, no database, no layout that prints the
 * school's name. Everything it shows comes from the phone's own store
 * (`offline-store.ts`), which is why the service worker is allowed to keep a
 * copy of this page. A page that carried tenant data could not be cached (see
 * public/sw.js); this one is the same bytes for every school and every person.
 *
 * Do not add a `requireAuth`, a school name or a user name here: the first
 * would make the page unreachable without a signal, and any of them would put
 * one person's data into a cache that outlives their session.
 */
export default function AttendanceOfflinePage() {
  return <OfflineRegisterApp />;
}
