"use client";

import { useActionState } from "react";
import { buttonClass } from "../../(app)/button-style";
import {
  triggerSchoolBackup,
  SCHOOL_BACKUP_RUNS_URL,
  type BackupState,
} from "@/lib/platform-backup-actions";

/**
 * One school's own backup, on demand — the nightly run covers every school
 * already, this is for "I need one right now" (before a risky change, before
 * a school leaves, before touching anything by hand).
 */
export function SchoolBackupButton({ schoolId }: { schoolId: string }) {
  const [state, action] = useActionState<BackupState, FormData>(triggerSchoolBackup, {});

  return (
    <form action={action} className="p-4">
      <input type="hidden" name="schoolId" value={schoolId} />
      <p className="text-sm text-slate-600">
        Runs the same job as the nightly backup, scoped to just this school — a real
        pg_dump, restorable per RESTORING.md, not a second format.
      </p>

      {state.error ? (
        <p role="alert" className="mt-3 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger-ink">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="alert" className="mt-3 rounded-lg bg-success-tint px-3 py-2 text-sm text-success-ink">
          {state.ok}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-4">
        <button type="submit" className={buttonClass("primary")}>
          Back up this school now
        </button>
        <a
          href={SCHOOL_BACKUP_RUNS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-slate-500 hover:text-slate-900"
        >
          View backup runs on GitHub →
        </a>
      </div>
    </form>
  );
}
